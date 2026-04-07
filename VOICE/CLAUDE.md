# Voice System

## Purpose
Voice-controlled smart home — speak a command in Hebrew, Russian, or English;
the system transcribes, understands intent, and executes the action.

---

## Infrastructure

| Component | Location | Details |
|-----------|----------|---------|
| Whisper STT | LXC 106 | IP `192.168.1.188` |
| Whisper HTTP wrapper | `/opt/whisper-http.py` | Port 10301, raw binary POST |
| Whisper model | `small` | Stored at `/opt/whisper-models` |
| Whisper venv | `/opt/whisper-env` | Python 3.11, faster-whisper + ctranslate2 |
| Systemd service | `whisper-http.service` | Enabled, auto-starts on boot |
| Dashboard server | `BOILER/dashboard/server.js` | All voice API endpoints |

**Note:** `wyoming-whisper.service` (port 10300) was disabled and removed — only `whisper-http.service` (port 10301) runs on LXC 106.

---

## Pipeline Flow

```
Microphone (browser)
  → POST /api/voice/transcribe  (server.js → LXC 106:10301)
    ← { text: "..." }
  → POST /api/voice/intent  (server.js)
    1. keywordIntent()   — server-side regex (Hebrew/Russian/English keywords)
    2. phraseIntent()    — DB substring match against voice_intent_phrases
    3. Claude Haiku      — fallback for unmatched text
    ← { intent, params, confidence, original_language, _source }
  → POST /api/request  (server.js — execute intent)
    ← { ok, message, data }
```

### Intent Recognition — 3-Stage Pipeline

**Stage 1 — Keyword regex** (`keywordIntent()` in server.js):
- Runs before DB and Claude — zero latency, zero cost
- Matches boiler on/off keywords in Hebrew, Russian, English
- Returns `boiler_on` or `boiler_off` directly

**Stage 2 — DB phrase match** (`phraseIntent()` in server.js):
- Substring match against `voice_intent_phrases` table (enabled phrases only)
- Phrases ordered by length DESC — longer phrases match first
- 60-second in-memory cache; cleared on any phrase add/delete/toggle
- Covers edge cases that regex misses

**Stage 3 — Claude Haiku** (fallback):
- Only reached when stages 1 and 2 produce no match
- System prompt includes phrase examples from DB as few-shot context
- Token usage logged to `voice_token_log`

### Hebrew Niqqud Stripping
Whisper sometimes adds vowel marks (niqqud, U+05B0–U+05C7) to Hebrew transcriptions.
Both `keywordIntent()` and `phraseIntent()` strip niqqud before matching:
```javascript
function stripNiqqud(text) {
  return text.replace(/[\u05B0-\u05C7\u05F0-\u05F4]/g, '');
}
```

### Confirmation Flow (pendingConfirm)
For devices with `response_style = short_confirm` or `full_confirm`:
1. First call → server returns a question ("Shall I turn on the boiler?")
2. Frontend sets `pendingConfirm = true`, stores intent + params
3. Next voice input checked against YES_WORDS / NO_WORDS
4. Yes → second POST `/api/request` with `confirmed: true` → executes
5. No / anything else → cancel, speak no-response

---

## DB Tables

| Table | Purpose |
|-------|---------|
| `voice_devices` | Device registry (boiler, switch, switch_group) |
| `voice_device_entities` | HA entity list for switch groups (multiple per device) |
| `voice_device_settings` | Global output device + boiler temp settings |
| `voice_intent_phrases` | DB phrase library for stage-2 intent matching |
| `voice_token_log` | Claude API token usage + cost per call |
| `manual_requests` | Voice-initiated manual requests (shower_prepare, bath_prepare etc.) — 90-day auto-clean |

All tables have retention policies registered in `retention_policies` (keep forever except token_log = 365d, manual_requests = 90d auto-clean).

### voice_devices
```sql
id, name, device_type (boiler|switch|switch_group),
ha_entity, intent (comma-separated),
response_style (short|full|short_confirm|full_confirm),
custom_text_enabled, custom_response_text, custom_confirm_text, custom_no_text,
enabled, sort_order, created_at
```

### voice_device_entities
```sql
id, device_id (FK → voice_devices ON DELETE CASCADE),
ha_entity, sort_order
UNIQUE (device_id, ha_entity)
```
Used for switch_group type — server loops through all entities when executing.

### voice_device_settings (single row, id=1)
```sql
output_device, vol_browser, vol_soundbar, vol_alexa_guy,
boiler_low_temp, boiler_shower_temp, boiler_bath_temp, boiler_heat_rate
```

### voice_intent_phrases
```sql
id, intent, phrase, language (he|ru|en), enabled, created_at
UNIQUE (phrase)
```
Seeded with 27 phrases (Hebrew, Russian, English) for boiler_on/off intents.

---

## Available Intents

| Intent | Handler | Device Type |
|--------|---------|------------|
| `boiler_on` | Turn on electric boiler switch | boiler |
| `boiler_off` | Turn off electric boiler switch | boiler |
| `boiler_status` | Report boiler + panel temp + valve state | boiler |
| `shower_prepare` | Check temp; if low → ask confirm → turn on electric boiler | boiler |
| `bath_prepare` | Same as shower_prepare, higher temp threshold | boiler |
| `switch_on` | Turn on switch / all entities in switch group | switch / switch_group |
| `switch_off` | Turn off switch / all entities in switch group | switch / switch_group |
| `general_query` | Fallback — returns helpful message, no action |

---

## Device Types

**Boiler** (`device_type = boiler`):
- Single HA entity (`switch.boiler_switch_switch_1`)
- Intents: boiler_on, boiler_off, boiler_status, shower_prepare, bath_prepare
- Boiler temp settings (shower/bath threshold, heat rate) stored in `voice_device_settings`

**Switch** (`device_type = switch`):
- Single HA entity selected from live HA switch list
- Intents: switch_on, switch_off

**Switch Group** (`device_type = switch_group`):
- Multiple HA entities in `voice_device_entities` table
- Server loops through all entities; partial failures reported
- Intents: switch_on, switch_off

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/voice/transcribe` | Upload audio → Whisper → `{ text }` |
| POST | `/api/voice/intent` | Text → intent classification (3-stage) |
| POST | `/api/request` | Execute intent |
| GET/POST | `/api/voice/device-settings` | Global output + boiler temp settings |
| GET/POST/PUT/DELETE | `/api/voice/devices` | Device registry CRUD |
| GET/POST/DELETE | `/api/voice/device-entities/:id` | Switch group entity CRUD |
| GET/POST/PUT/DELETE | `/api/voice/phrases` | Intent phrase library CRUD |
| GET | `/api/ha/switches` | Live list of all `switch.*` entities from HA |
| GET/POST | `/api/voice/token-log` | Claude token usage log |

---

## Dashboard Voice Page

- File: `BOILER/dashboard/public/voice.html`
- Tabs: **Voice Test** · **Voice Settings** · **Device & Response** · **Tokens**
- All settings saved to DB (not localStorage)

### Voice Test Tab
- Record via browser mic or upload audio file
- Manual mode: separate Transcribe / Extract Intent / Execute buttons
- Auto mode: record → stop → full pipeline runs automatically
- Confirmation flow: yes/no detection when device requires confirmation

### Voice Settings Tab
- Pipeline mode (Manual / Auto)
- Input device (Browser mic / XMOS satellite — coming soon)
- TTS settings (speed, voice, test button)
- Output device (Laptop Speaker / Samsung Soundbar / Alexa Guy Room) + volume sliders

### Device & Response Tab
- Device list with edit buttons
- Add Device: pick type (Boiler / Switch / Switch Group) → opens form
- Device form:
  - Type selector → shows appropriate entity picker
  - HA entity: live dropdown from `/api/ha/switches` (single) or multi-picker (group)
  - Intent checkboxes (type-specific: boiler gets 5 intents, switch/group gets 2)
  - Boiler temp settings section (shown only for boiler type)
  - Response style (Short / Full / Short+Confirm / Full+Confirm)
  - Custom response texts (confirm question, no-response, override text)
  - Recognition phrases (per device, filterable by language ru/en/he)

### Tokens Tab
- Table of last N calls (selector: 10/20/50/100)
- Shows: timestamp, input text, intent, input tokens, output tokens, cost
- All-time total shown in footer
- Stored in `voice_token_log` DB table, 365-day auto-clean retention

---

## LXC 106 State

| Item | Status |
|------|--------|
| `whisper-http.service` | Active, enabled, port 10301 |
| `wyoming-whisper.service` | **Disabled and removed** |
| `postfix` | **Disabled** |
| Open ports | 10301 (whisper), 22 (SSH) only |
| Venv packages | faster-whisper, ctranslate2, av, numpy, onnxruntime — no junk |
| Disk | 1.8 GB used of 8 GB |
| RAM | ~1.2 GB used (single whisper model loaded) |

---

## API Pricing (Claude)

| Model | Input / 1M | Output / 1M | Est. per call |
|-------|-----------|------------|---------------|
| claude-haiku-4-5 (active) | $0.80 | $4.00 | ~$0.00005 |
| claude-sonnet-4-6 | $3.00 | $15.00 | ~$0.00030 |

---

## Output Devices

| Device | Type | HA Entity | Default Volume |
|--------|------|-----------|----------------|
| Laptop Speaker | Browser TTS (Web Speech API) | — | 80% |
| Samsung Soundbar | HA media_player | `media_player.samsung_soundbar` | 40% |
| Alexa — Guy Room | HA media_player | `media_player.alexa_guy_room` | 70% |

---

## Input Devices

| Device | Status |
|--------|--------|
| Browser Microphone | Active — MediaRecorder API, records webm |
| XMOS XVF3800 Satellite | Planned — far-field mic + RPi Zero 2W per room, Wyoming protocol |

---

## Deploy

`whisper-http.py` lives only on LXC 106 (`/opt/whisper-http.py`) — **no local copy in this repo**. Edit directly on the server:

```bash
ssh root@192.168.1.188
nano /opt/whisper-http.py
systemctl restart whisper-http && systemctl is-active whisper-http
```

Model files at `/opt/whisper-models` — do not overwrite.
Venv at `/opt/whisper-env` — only update if dependencies change.

---

## Orchestrator Integration

`whisper-http.service` is **registered** in the `agents` table — the orchestrator monitors it like all other agents.

- `name = whisper-http`, `lxc_id = 106`, `lxc_ip = 192.168.1.188`, `service_name = whisper-http`
- No `data_table`, no `settings_table`, no `deploy_path` — service liveness check only
- Full run (every 1h): SSH to LXC 106 → `systemctl is-active whisper-http`; auto-restart if down; raises `service_down` alert if still failing
- SSH key from LXC 105 (`/root/.ssh/id_ed25519`) is authorized on LXC 106
- Dashboard reads `system_alerts` for `affected_agent = 'whisper-http'` — same path as boiler/media agents
- Deploy via dashboard not available (`deploy_path` is null) — manage script directly on LXC 106

---

## TODO

- [ ] Install Piper TTS on LXC 106 (replace browser Web Speech API)
- [ ] Configure RPi Zero 2W as Wyoming satellite (one per room)
- [ ] Add remaining Alexa devices to output settings
- [ ] Voice request status panel (track long-running shower_prepare)
- [ ] light_on / light_off intents — proper device-registry-based routing (currently uses params.room → HA entity name pattern)
