# /hasp-display — HASP Display Template Builder

Create, update, list, sync, or remove HASP panel **display rows** (rows in `hasp_displays`). Each row maps a panel widget (`p<page>b<label_id>`) to a live data source — either a `state.shared` key or a device sensor — and renders a format string against it on every heartbeat.

This skill is a guided wrapper over the dashboard's existing CRUD endpoints (`/api/hasp/:panel/displays/*` and `/api/hasp/:panel/sync`). Nothing it does requires editing rule-engine code or restarting services. Don't reach for this skill when binding a button to a device — that's the wallmote-style picker on `/balcony.html` (or future per-room panel pages). This skill is purely for **value displays**: labels, gauges, bars.

Follow the steps. Use `AskUserQuestion` for every choice. Don't skip steps or assume answers.

## Architecture refresher (read once, don't repeat to user)

- `hasp_displays` row fields: `panel_id, page, label_id, display_type, target_property, source_type, source_value, format_string, refresh_sec, last_value, last_published_at`
- The runtime rule (`RULES/rules/balcony_displays.py`) reads each row, resolves `source_value`, renders `format_string`, publishes `hasp/<panel>/command/p<page>b<label_id>.<target_property>`.
- `source_value` syntax:
  - `'<key>'` — read `state.shared[<key>]`
  - `'device:<device_id>:<dps_key>'` — read `state.devices[<id>].dps[<dps_key>]`
- `format_string` substitutions:
  - `{{val}}` — the resolved source value
  - `{{<key>}}` — `state.shared[<key>]` (works for multi-key templates like `B {{boiler_temp}} / P {{panel_temp}}`)
- **Float values are auto-rounded to 1 decimal** in `_fmt()` (since 2026-05-03) — no need to embed `.1f` precision in `format_string` for noisy sensors. Bare `{{val}}` of a float like `21.039999961853` renders as `21.0`. This drives the dedupe correctly so stable temperatures stop spamming republishes. See [Float rounding feedback](../../projects/c--Users-muroc-project-home/memory/feedback_float_rounding.md). If a future use case ever needs more precision (battery voltage at 0.01 V), tell the user it's not currently configurable per-row — would need a code change in `_fmt()`.
- Empty `format_string` ⇒ rule skips the row (placeholder, no panel write); SELECT also filters out empty `source_value` rows so they don't burn DB roundtrips on every heartbeat.
- Heartbeat fires every 60 s; per-row `refresh_sec` (default 30) gates re-publish; `last_value` dedupes so the panel only sees real changes; **force-republish every 10 min** (since 2026-05-03) so a panel reboot doesn't leave stable values stuck on default text.
- Filters in dashboard UI: `Show: only configured` hides rows with empty format/source

## Step 0 — Action

Use `AskUserQuestion`:

- **Create** — new display row (must already exist in `hasp_displays`, e.g. via Sync from Panel). Skill wires its source + format + target.
- **Update** — modify an already-configured row.
- **List configured** — read-only — show every row with non-empty format/source.
- **Sync from panel** — call `POST /api/hasp/<panel>/sync`. Reports counts (added / deleted / type_updated). Useful when the user just edited widgets in the OpenHASP web UI.
- **Remove** — `DELETE /api/hasp/<panel>/displays/<id>` (only do this for fully unconfigured placeholders or rows the user explicitly wants gone — never silently delete configured rows).

If `List` or `Sync`: do that and exit (no further steps).

## Step 1 — Pick panel

Query (postgres-lxc MCP):

```sql
SELECT name FROM hasp_panels ORDER BY name
```

Ask user to pick. As of 2026-05-01 only `balcony` exists; this step still runs so the skill stays generalizable when more panels arrive.

## Step 2 — Pick the widget

For **Create**: list synced-but-unconfigured rows for the chosen panel:

```sql
SELECT id, page, label_id, display_type, target_property
FROM hasp_displays
WHERE panel_id = (SELECT id FROM hasp_panels WHERE name = $1)
  AND (format_string IS NULL OR format_string = '')
ORDER BY page, label_id
```

Ask user to pick a row by `(page, label_id)` — show display_type + target_property as hints. Offer "type a (page, label_id) manually" for cases where the row hasn't been synced yet (rare — usually run sync first).

For **Update**: list configured rows:

```sql
SELECT id, page, label_id, source_type, source_value, format_string, last_value, description
FROM hasp_displays
WHERE panel_id = (SELECT id FROM hasp_panels WHERE name = $1)
  AND format_string IS NOT NULL AND format_string != ''
ORDER BY page, label_id
```

Show description (or empty) + format_string + last_value. Ask user to pick.

For **Remove**: list as for Update + the unconfigured rows. Ask which to remove. Confirm explicit `yes delete <description-or-page-label>` before issuing DELETE.

## Step 3 — Pick the source

Two source kinds. Ask user via `AskUserQuestion`:

- **state.shared key** — pick from rule-engine state. Usually the right answer for derived values like `time_mode`, `people_home`, `home_mode`, `boiler_temp` (if a publisher rule writes it), `next_sunset`.
- **Device sensor** — pick from device-level dps. Usually the right answer for direct sensor readings: temperature, humidity, illuminance, battery, etc.

### state.shared path

Query the engine snapshot via dashboard:

```bash
curl -s http://127.0.0.1:3000/api/rule-engine/state \
  | python -c "import sys,json; print('\n'.join(sorted(json.load(sys.stdin).get('state',{}).keys())))"
```

Filter out internal keys (`_*`) before showing. Ask user to pick one. Final source_value is just the key name (e.g. `time_mode`).

### Device sensor path

Query devices that have at least one numeric/displayable dps key:

```sql
SELECT id, name, room, last_state
FROM devices
WHERE last_state ? 'temperature'
   OR last_state ? 'humidity'
   OR last_state ? 'illuminance'
   OR last_state ? 'battery'
   OR last_state ? 'power'
   OR last_state ? 'energy'
   OR last_state ? 'voltage'
   OR last_state ? 'pressure'
   OR last_state ? 'co2'
   OR last_state ? 'voc'
ORDER BY room, name
```

Group by room. For each device, list available dps keys with current values. Ask user to pick `<device, key>`. Final source_value: `device:<id>:<key>`.

## Step 4 — Format string

Show common patterns and ask:

| Pattern | Example | When |
|---|---|---|
| `{{val}}` | `25.2` | Single source, no decoration. Rule resolves `{{val}}` to source. |
| `{{val}}°C` / `{{val}}%` | `25.2°C` | Single source + unit. |
| `<prefix> {{val}}` | `Boiler 67` | Single source + label prefix. |
| `{{<key1>}} / {{<key2>}}` | `B 67 / P 74` | Multi-key (only state.shared keys). |
| free-form | anything | Free choice — but tell user `{{val}}` only works for the picked source; other tokens are state.shared. |

Default suggestion when source is a device sensor: `{{val}}`. When source is a state.shared key: `{{val}}` or `{{<the-key-name>}}` — both work, but `{{val}}` is canonical.

## Step 5 — display_type + target_property

These two MUST be consistent or the panel ignores the publish. Ask:

| display_type | sensible target_property | what HASP does |
|---|---|---|
| `text` | `text` | writes to a label widget's text |
| `gauge` | `val` | writes a number to a gauge widget |
| `bar` | `val` | writes a number to a bar widget |
| `series` (planned) | n/a | not implemented in renderer yet — discourage |

Validation: if user picks `gauge` + `text` (or any other mismatch), warn and show the recommended pair. Don't write a mismatched row without confirmation.

For text labels with color flips: `target_property='bg_color'` or `'text_color'` is also valid — the format_string then evaluates to a hex like `#1a4775`. Power-user mode; only suggest if user asks.

## Step 6 — refresh_sec

Ask: refresh cadence in seconds. Default `30`.

- `30` (default) for slow-moving values (temps, humidity, mode flags).
- `5–10` for fast-moving / live values (people count, active rooms, gauge readings).
- `300+` for things that rarely change (sunset time, next_sunrise).

The heartbeat is 60 s, so anything below ~60 s is gated by the heartbeat itself; `refresh_sec=10` doesn't actually publish every 10 s, it just doesn't BLOCK at 30. (TODO: add a note in code if heartbeat cadence ever changes.)

## Step 7 — description

Ask: 1-line human description. Optional but recommended — appears in the Display Templates list and helps with future audits.

## Step 8 — Confirm

Show the full row that will be created/updated:

```
Panel:           balcony
Widget:          p4b1
Display type:    text
Target prop:     text
Source:          device:b0f9c460-...:temperature  (Balcony Motion · temperature, currently 20.2)
Format:          {{val}}
Refresh:         30 s
Description:     OUT temp — Balcony Motion
```

Ask: proceed? (yes / cancel / change a field).

If "change a field" — loop back to that step.

## Step 9 — Execute

For **Create** on an existing unconfigured row: PATCH it (the sync already inserted it):

```bash
curl -s -X PATCH http://127.0.0.1:3000/api/hasp/<panel>/displays/<id> \
  -H 'Content-Type: application/json' \
  -d '{"page":4,"label_id":1,"display_type":"text","target_property":"text","source_type":"device","source_value":"device:b0f9c460-...:temperature","format_string":"{{val}}","refresh_sec":30,"description":"OUT temp — Balcony Motion"}'
```

For **Create** on a brand-new row (rare — usually run sync first): POST instead:

```bash
curl -s -X POST http://127.0.0.1:3000/api/hasp/<panel>/displays \
  -H 'Content-Type: application/json' \
  -d '{...same body...}'
```

For **Update**: same PATCH as above with the new values.

For **Remove**:

```bash
curl -s -X DELETE http://127.0.0.1:3000/api/hasp/<panel>/displays/<id>
```

`source_type` MUST be set explicitly:

- `'device'` if `source_value` starts with `device:`
- `'shared_state'` otherwise

(The runtime rule no longer branches on `source_type` — it parses `source_value` directly — but the column is still indexed and surfaced in the dashboard, so set it correctly.)

## Step 10 — Verify

After PATCH/POST:

1. Wait up to 70 s (one heartbeat + a margin).
2. Query the row's `last_value`:

   ```sql
   SELECT last_value, last_published_at
   FROM hasp_displays WHERE id = $1
   ```

3. If `last_value` is non-null AND `last_published_at` is recent (within last 90 s) → success. Tell the user to look at the panel widget.

4. If `last_value` is still null after 90 s — the source resolved to None. Common causes:
   - Device offline / no fresh state in `state.devices`
   - state.shared key not actually in shared (typo, or the key only gets set by a rule that hasn't fired yet)
   - The dps key name is wrong (e.g. `temp` vs `temperature`)
   - Rule engine on LXC 105 isn't running (`systemctl is-active rule-engine.service`)

   Walk the user through the diagnosis — don't claim "it's working" without evidence.

## Step 11 — Done

Print a 1-line summary:

```
✓ Panel balcony · p4b1 (OUT temp) → Balcony Motion temperature → 20.2 °C
```

Don't push docs updates — the dashboard is self-documenting once the row is configured. The dashboard's Display Templates card shows everything this skill set up.

## Notes / gotchas

- **Don't auto-fix mismatched display_type + target_property** — always confirm with the user. A `gauge` widget with `target_property='text'` is a configuration mistake but the user might be intentionally swapping a numeric widget for a text label without re-syncing.
- **Don't run `Sync from panel`** unless the user explicitly asks (`Action = Sync`). Sync also DELETES unconfigured-stale rows, which can surprise the user if they were mid-edit.
- **Sub-millisecond writes** — PATCH/POST hits the dashboard, dashboard hits LXC 102. Latency is ~50 ms. Don't add artificial delays between Step 9 and Step 10.
- **Don't fall back to creating a publisher rule** if the source isn't in state.shared. The whole point of this feature is direct device-sensor reads. If the user wants a complex derivation (averages, conditionals), that's a different problem — write them a Layer-3 publisher rule via `/create-rule`, don't shoehorn it here.
- **Multi-row update** — if the user wants to wire 5 displays at once, run the skill 5 times. Don't try to batch — the per-row clarity of source/format/target is the value.
