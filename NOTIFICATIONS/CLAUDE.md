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

- **Triggers (v1):** `main_door_closed` · `home_mode_changed` (opt. `trigger_param` = target mode; `home` = "someone comes home") · `people_count_changed` · `scheduled_time` (`trigger_param` = HH:MM).
- **Conditions** = list of `{field, op, value}`, all must pass: `home_mode is X` · `people_home >=/<=/==/>/< N` · `time_window between "HH:MM-HH:MM"` (wraps midnight) · `day is weekday|weekend` (Israel weekend = Fri/Sat).
- **Message** with placeholders: `{people_home} {home_mode} {time} {date} {count}`.
- **Delivery:** `off` (= `enabled=false`) · `immediate` (opt. `throttle_min`) · `at_time` (hold latest occurrence → deliver at `delivery_time`) · `daily` (count occurrences → one summary at `delivery_time`, `{count}`).
- **Surfaces:** `{popup, pages:'all'|[slug…], phone}`. Phase 1 = popup on all pages, phone deferred.
- **Interactive action (`action` column):** `set_people` makes the popup show a **number input pre-filled with the calculated count + a Save button** that writes the manual people count (`POST /api/main-agent/manual-people`, same as Main Agent → Home Activity). This is the whole point of the door notification — you confirm/correct how many people are home right in the popup, not just read it. Interactive popups **don't auto-dismiss**. Toggled per-notification in the editor ("Let me set the number of people at home"). The rule puts `data.action` + live `people_home` on the event; `notify-toast.js` renders the input when `data.action==='set_people'`.

## How it fires (LXC 105 rule engine — dashboard is UI-only)
`RULES/rules/notifications.py`, **group `notify`**, `triggers=["*","heartbeat"]`, `depends_on=["People Home","Mode Buttons"]`.
- ONE generic dispatcher rule reads `notification_defs` (30 s TTL cache) and evaluates every def on each event → inserts a `notification_events` row when one fires. Add a notification from the tab and it's picked up within ~30 s — **no new rule file, no Reload** for new defs (Reload IS needed the first time the rule file itself is deployed/changed).
- **Door signal:** `main_door_closed` fires when People Home's finalized `_people_last_reset_ts` changes AND `_last_transition_source == 'door_sensor'` (verified live). `people_home` is finalized in the same tick, so `{people_home}` is fresh.
- Tracks all per-def state in **`_notify:*` shared keys** — underscore-prefixed, so the engine's real-fire gate (`rule_engine.py` ~L666 `not k.startswith('_')`) does NOT count them → a wildcard dispatcher can't inflate the Runs counter. The rule returns `[]` (no engine commands); producing a notification is a direct DB insert.
- `_first_eval` primes every def's change-detection signal ONCE after (re)load → a restart/Reload never pops a spurious notification for a change it didn't witness.
- `at_time`/`daily` deliver on the 60 s heartbeat when `delivery_time` arrives (once/day).

## Dashboard (UI only)
- **`routes-notifications.js`** (own module, one `require()` past the architecture-guard hook): `GET/POST/PATCH/DELETE /api/notifications/defs` (authoring), `GET /api/notifications/feed?since=<cursor>` (popup feed + `max_id`), `POST /api/notifications/test/:id` (render message vs live state + insert one event now).
- **`public/js/notify-toast.js`** — shared component loaded on every page it's wanted (Phase 1: Main Agent only). Polls the feed every 10 s, pops a **centered modal styled like the Medical popup** (`#notify-toast-overlay`, level-accent bar info/warn/alert), auto-dismiss 9 s. Per-browser cursor in `localStorage` (`notifyToast.cursor`) → each event shows ONCE; **first load seeds the cursor to `max_id` so history never replays** (only notifications fired after you open the page pop). Listens for a `notify-toast-poll` window event so the tab's ▶ Test feels instant.
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
- **Phase 2:** popups on all pages; more triggers (someone leaves, device offline); pages picker per notification; polish the at_time/daily UX; quiet-hours.
- **Phase 3:** phone push via the planned **ntfy** service (LXC 109 Docker, per-person topics over NetBird) — an LXC-side forwarder pushes `pushed`-flagged events; the SAME notification reaches popup + phone.
