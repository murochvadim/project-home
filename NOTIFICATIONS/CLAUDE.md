# Notifications Subsystem

Reusable, user-authored notification system. You create notifications on the
dashboard (**Main Agent → Notifications tab**); each fires a **popup** when its
trigger happens and its conditions pass. Built so new notifications plug into the
same plumbing — no per-notification code. Phone push (ntfy) is a future channel
that slots into the same events.

**Phase 1 shipped 2026-07-09** (door notification + reusable core + tab + popup).
Dashboard-only agent (no dedicated LXC service — firing runs on the existing rule
engine, LXC 105). Sibling pattern to Reminders (`reminders-badge.js`) and the
sidebar alert badges (`alerts-monitor.js`).

## The three notification substrates in this project (don't confuse them)
| Class | "you should do X" | "a system is unhealthy" | **"X just happened"** |
|---|---|---|---|
| Surface | Reminders badge (top-right card) | Sidebar status badges | **Notifications popup (this)** |
| Code | `reminders-badge.js` + `routes-reminders.js` + `reminder_state` | `alerts-monitor.js` + `system_alerts` | `notify-toast.js` + `routes-notifications.js` + `notification_*` |

## Anatomy of a notification
Each `notification_defs` row = **Trigger** + **Conditions** (AND-ed gates) + **When/where**.

- **Triggers:** `main_door_closed` · `home_mode_changed` (opt. `trigger_param` = target mode; `home` = "someone comes home") · `people_count_changed` · **`device_presence`** (`trigger_param` = a presence/motion/door sensor's device_id; fires on the sensor's rising edge — see Tablet alerts) · `scheduled_time` (`trigger_param` = HH:MM).
- **Conditions** = list of `{field, op, value}`, all must pass: `home_mode is X` · `people_home >=/<=/==/>/< N` · `time_window between "HH:MM-HH:MM"` (wraps midnight) · `day is weekday|weekend` (Israel weekend = Fri/Sat).
- **Message** with placeholders: `{people_home} {home_mode} {time} {date} {count}`.
- **Delivery:** `off` (= `enabled=false`) · `immediate` (opt. `throttle_min`) · `at_time` (hold latest occurrence → deliver at `delivery_time`) · `daily` (count occurrences → one summary at `delivery_time`, `{count}`).
- **Surfaces:** `{popup, pages:'all'|[slug…], phone, tablet}`. popup on all pages; **`tablet`** = `{enabled,icon,color,blink,sound,duration_sec}` flashes the Balcony Smart Tablet (see Tablet alerts); phone deferred (Phase 3).
- **Interactive action (`action` column):** `set_people` makes the popup show a **number input pre-filled with the calculated count + a Save button** that writes the manual people count (`POST /api/main-agent/manual-people`, same as Main Agent → Home Activity). This is the whole point of the door notification — you confirm/correct how many people are home right in the popup, not just read it. Interactive popups **don't auto-dismiss**. Toggled per-notification in the editor ("Let me set the number of people at home"). The rule puts `data.action` + live `people_home` on the event; `notify-toast.js` renders the input when `data.action==='set_people'`.

## How it fires (LXC 105 rule engine — dashboard is UI-only)
`RULES/rules/notifications.py`, **group `notify`**, `triggers=["*","heartbeat"]`, `depends_on=["People Home","Mode Buttons"]`.
- ONE generic dispatcher rule reads `notification_defs` (30 s TTL cache) and evaluates every def on each event → inserts a `notification_events` row when one fires. Add a notification from the tab and it's picked up within ~30 s — **no new rule file, no Reload** for new defs (Reload IS needed the first time the rule file itself is deployed/changed).
- **Door signal:** `main_door_closed` fires when People Home's finalized `_people_last_reset_ts` changes AND `_last_transition_source == 'door_sensor'` (verified live). `people_home` is finalized in the same tick, so `{people_home}` is fresh.
- Tracks all per-def state in **`_notify:*` shared keys** — underscore-prefixed, so the engine's real-fire gate (`rule_engine.py` ~L666 `not k.startswith('_')`) does NOT count them → a wildcard dispatcher can't inflate the Runs counter. The rule returns `[]` (no engine commands); producing a notification is a direct DB insert.
- `_first_eval` primes every def's change-detection signal ONCE after (re)load → a restart/Reload never pops a spurious notification for a change it didn't witness.
- `at_time`/`daily` deliver on the 60 s heartbeat when `delivery_time` arrives (once/day).

## Tablet alerts (2026-07-26) — a notification can flash the Balcony Smart Tablet
First use: **corridor presence → big blinking red Door + beep on the tablet.** Six pieces:
1. **Trigger `device_presence`** (`notifications.py`): `trigger_param` = a presence/motion/door sensor id; fires on the **rising edge** (`dps['1']` none/false→present). Handled **via the event** (not `_signal_for`) + **primed on `_first_eval`**. ⚠ **Corridor Presence double-reports** — the same sensor pushes both `tcp_push {'1':'presence'}` AND `ha_api {'1':true}` per change; the **multi-value check** `in ('presence',True,'true',1)` + rising-edge dedup + `throttle_min` collapse that to **ONE** alert (a naive `=='presence'` would double-fire).
2. **Surface `surfaces.tablet`** = `{enabled,icon,color,blink,sound,duration_sec}` (JSONB — **no migration**). On fire, `_tablet_cmd` builds `{protocol:'panel_alert',…}` and **`evaluate` returns it** (changed from `return []` → `return commands`), honoring `throttle_min` via its own `_notify:{id}:tablet_ts` key. The **`icon`** dropdown (in `main-agent.html`) offers the shared tablet SVG-icon set (`ICONS` in `panel.js`/`panel-editor.js`); **`human`** (head+shoulders) was added 2026-07-29 for a presence alert — the tablet renders whatever name is set (`ICONS[name] ? svgIcon : text fallback`), so a new option must exist in BOTH the dropdown and `panel.js`'s `ICONS`.
3. **Engine dispatch** (`rule_engine.py`): new **`protocol=='panel_alert'`** branch in `_dispatch_command` → `publish_raw('mur/home/device/panel/alert', json)` *(engine-core change → one-time rule-engine restart)*.
4. **ACL (LXC 107):** `rule_engine` += `write mur/home/device/+/alert`; `dashboard_browser` += `read mur/home/device/+/alert`.
5. **Tablet** (`BALCONY_SMART_TABLET/panel/panel.js` + `.css`): subscribes to `panel/alert`; renders a full-screen **blinking SVG icon (alert colour) + message**, auto-dismiss after `duration_sec` or tap; **synthesized Web-Audio beep** loop. ⚠ Audio unlocks on first screen touch (kiosk gets tapped) — first alert on a freshly-loaded untouched panel is silent; enable Fully Kiosk autoplay for cold-start sound.
6. **Editor** (`notifications-tab.js` + `main-agent.html`): "**Presence detected (a sensor)**" trigger + a sensor picker (`/api/devices` filtered to presence/motion/door), and a "**📟 Also flash the Balcony tablet**" box (icon/colour/blink/sound/duration). **▶ Test** also flashes the tablet — `POST /api/notifications/test/:id` publishes the same `panel_alert` (dashboard mqtt client wired into `routes-notifications` via `() => mqttClient`, like `routes-scenes`) so you can preview on the tablet without the trigger happening.

Verified end-to-end (2026-07-26) with a sandbox def + fake presence device (no real corridor automation, panel config untouched): rule → `panel_alert(icon=door dur=8s)` → tablet received the exact payload; ACL both directions confirmed. See [[project_balcony_smart_tablet]].

## Dashboard (UI only)
- **`routes-notifications.js`** (own module, one `require()` past the architecture-guard hook): `GET/POST/PATCH/DELETE /api/notifications/defs` (authoring), `GET /api/notifications/feed?since=<cursor>` (popup feed + `max_id`), `POST /api/notifications/test/:id` (render message vs live state + insert one event now — **and publish the tablet `panel_alert`** if the def has a `surfaces.tablet`, so ▶ Test previews the real tablet flash).
- **`public/js/notify-toast.js`** — shared component loaded on **all dashboard pages** (since 2026-07-25 — was Main-Agent-only in Phase 1). Every page except `viewer.html` (a bare Document Viewer) has the `<script src="js/notify-toast.js?v=11">` tag, so a pending sticky prompt surfaces wherever you are. It's self-contained (people-count Save, ×-later, sticky pending all work standalone; positioning falls back to top-left where there's no journal/reminders badge to anchor to). Polls the feed every 10 s, pops a **centered modal styled like the Medical popup** (`#notify-toast-overlay`, level-accent bar info/warn/alert), auto-dismiss 9 s. Per-browser cursor in `localStorage` (`notifyToast.cursor`) → each NON-interactive event shows ONCE; **first load seeds the cursor to `max_id` so history never replays** (only notifications fired after you open the page pop). Listens for a `notify-toast-poll` window event so the tab's ▶ Test feels instant.

### Sticky interactive prompts (2026-07-25) — "never miss a main-door-close"
The interactive door prompt (`data.action='set_people'`) must survive the laptop being closed and **never disappear until the user actually Saves the number**. Before this, it could vanish 3 ways: the cursor advanced on *fetch* (close-before-Save lost it), a fresh browser only replayed the last 90 s, and the event **expired** (`expires_at`). Fix = **server-side pending state**, not the browser cursor:
- **`notification_events.resolved_at TIMESTAMPTZ`** (migration `002_resolved.sql`; the migration also baselined all pre-existing rows to `resolved_at=now()` so history doesn't suddenly pop). Pending = interactive event with `resolved_at IS NULL`.
- **Rule (`notifications.py _emit`):** interactive events are inserted with **`expires_at=NULL`** (never auto-expire) and **supersede** the prior unresolved one for that def (`UPDATE … SET resolved_at=now() WHERE def_id=? AND resolved_at IS NULL AND data->>'action' IS NOT NULL`) — so only the LATEST door-close is pending (one prompt, never a stack).
- **Feed (`routes-notifications.js`):** the `events` (cursor) list now **excludes** interactive (`data->>'action' IS NULL`); a new **`pending[]`** returns every unresolved interactive event **ignoring the cursor and expiry**, so it resurfaces on every poll on every browser. New **`POST /api/notifications/:id/resolve`** sets `resolved_at`.
- **`notify-toast.js`:** `poll()` queues `pending[]` items (dedup via a session `_seenIds`, skip a session `_laterIds`); **Save** writes the count THEN `POST /:id/resolve` (clears it everywhere forever); **× = "later"** adds the id to `_laterIds` (hidden this session, re-appears on next page open — a fresh session, since the server still returns it pending). Pending items never touch the `localStorage` cursor. Deploy needed a dashboard restart (routes) + a rule Reload (never a rule-engine restart).

### One-Save-clears-all (2026-07-26) — the door prompt still popped "tens of times"
Supersede kept the DB to 1 unresolved *going forward*, but the prompt still stacked from two real sources: a **residual pile-up** (14 pre-supersede interactive events sat unresolved 07-23→07-25) and **flapping bursts** (the Main Door reset 3× in ~10 min → several distinct ids). The feed returned **all** unresolved (`pending` LIMIT 20), the browser queued each distinct id, and **Save resolved only the id on screen** — so siblings kept popping (exactly "appears tens even after Save"). **Root cause was the feed/client, not the rule** (supersede verified working: events 73→76 each resolved on the next insert). Fix = **dashboard-only, 3 parts, no rule change**:
- **`POST /:id/resolve`** now resolves **every unresolved interactive event of that `def_id`** (`… WHERE resolved_at IS NULL AND data->>'action' IS NOT NULL AND def_id = (SELECT def_id FROM notification_events WHERE id=$1)`) → one Save clears the whole door family (burst / residual / laptop-closed backlog). Returns `{resolved:N}`.
- **`pending[]` query** → `SELECT DISTINCT ON (def_id) … ORDER BY def_id, id DESC` — even a pile-up surfaces as **ONE** prompt (newest occupancy), never a stack.
- **`notify-toast.js?v=12`** (bumped on all 21 pages): each `poll()` **reconciles** — drops any queued/`_seenIds` interactive prompt no longer in `pending` (superseded ones self-remove); **Save** also purges the local queue for that `def_id`.
- **Verified hermetically:** a throwaway disabled def + 3 unresolved events → resolving one via the endpoint cleared all 3 (`{resolved:3}`), and the real door prompt (def 1, id 76) stayed unresolved. Deploy = `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`.
- **Diagnosis lesson:** a live snapshot of "1 unresolved" was misleading — the pile-up was historical; the `resolved_at` timeline (14 rows all resolved at one instant) is what exposed it. Read the timeline, not the current count.
- **`public/js/notifications-tab.js`** + the **Notifications tab** in `main-agent.html` — list (on/off toggle, ▶ Test, Edit, ✕), an editor modal (trigger + dynamic trigger-param, repeatable condition rows, message, delivery + delivery-time, style/level, throttle, popup checkbox), and a "Recent notifications" read-only log. Loaded **after** `main-agent.js` so its `showTab` wrapper chains on (isn't clobbered by) main-agent's own.

## Data model (LXC 102) — migration `NOTIFICATIONS/migrations/001_notifications.sql`
- **`notification_defs`** — the notifications you author. Retention **forever + 🔒 protected**.
- **`notification_events`** — fired instances = the popup feed. Retention **30 days** auto-clean. `pushed` bool reserved for the Phase 3 ntfy forwarder. Indexed on `ts DESC`.
- Both registered in Project Health → DB-Volumes group **"Notifications"** (`DBV_GROUPS` in server.js) + `retention_policies`.
- Seeded def #1: **"Main door closed — people home"** (trigger `main_door_closed`, gate `home_mode is home`, message `🚪 Main door closed — {people_home} people at home`, immediate popup).

## Deploy
- Rule: `scp RULES/rules/notifications.py root@192.168.1.187:/opt/main-agent/project/RULES/rules/notifications.py` → click **Reload** on Main Agent (never `systemctl restart rule-engine`). New/edited *defs* need no reload (30 s TTL).
- Dashboard: `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js` (never `pm2 restart`).

## Roadmap
- **Phase 2:** ~~popups on all pages~~ (DONE 2026-07-25); more triggers (someone leaves, device offline); pages picker per notification; polish the at_time/daily UX; quiet-hours.
- **Phase 3:** phone push via the planned **ntfy** service (LXC 109 Docker, per-person topics over NetBird) — an LXC-side forwarder pushes `pushed`-flagged events; the SAME notification reaches popup + phone.
