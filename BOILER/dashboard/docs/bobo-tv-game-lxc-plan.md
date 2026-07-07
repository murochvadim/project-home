# BoBo TV Game — laptop-independent hosting on LXC 100 (build plan)

**Goal:** the balcony-TV BoBo game must run **without the laptop on**. Today the TV loads
`http://192.168.1.128:3000/medical.html#bobo` from the **dashboard on the laptop** — laptop off = TV
can't load. Move the TV runtime to **LXC 100 (Media Agent, always on)**; scores still land in Postgres
so they appear in Medical → Tests when the dashboard is up.

## Why LXC 100
- Always on; already runs the **TV-launch scripts** (`/opt/media-agent/tv_launch.py` etc.) — so the
  auto-flow (BoBo connect → TV on → open browser) is co-located.
- **Flask + flask_cors** already used (`player_service.py`, `ingest_service.py`, `media_service.py`).
- **Postgres access**: psycopg2 `ThreadedConnectionPool` → `192.168.1.219`, `DB_PASS` from
  **`/etc/environment`** (pattern copied verbatim from `player_service.py`).
- Board input is **already** MQTT-WS from LXC 107 (`ws://192.168.1.189:9001`, user `dashboard_browser`)
  — laptop-independent; unchanged. **The pos stream is already calibrated** (calibration lives in the
  ESP EEPROM), so the game needs NO calibration data from the laptop.
- Free port: **8770** (in use on 100: 8200, 8765–8769).

## New pieces (all on LXC 100, deploy via scp to `/opt/media-agent/`)

### 1. `bobo_game_service.py` — tiny Flask service on :8770
- `CORS(app)`; DB pool copied from `player_service.py` (host `192.168.1.219`, `DB_PASS` from env).
- **Serves static** from `/opt/media-agent/bobo/` — `bobo.html`, `bobo-game.js`, `mqtt.min.js`
  (`send_from_directory`; `/` → `bobo.html`).
- **4 data endpoints** (Postgres-backed; return the SAME shapes the dashboard uses so `bobo-game.js`
  works with just a base-URL swap):
  - `GET  /api/bobo/players`  → `household_users` `(id, name)` (active).
  - `GET  /api/bobo/settings` → `dashboard_settings` key `medical.bobo_game` (mode + default user +
    per-user difficulty).
  - `GET  /api/bobo/recent`   → recent `medical_test_results WHERE test_type='balance'` (id, user_id,
    member_name via join to household_users, results, tested_at) LIMIT ~8.
  - `POST /api/bobo/score`    → INSERT `medical_test_results` `{test_type:'balance', user_id, results, meta}`.
  - `POST /api/bobo/settings` → upsert `dashboard_settings` `medical.bobo_game` (save chosen difficulty/mode).

### 2. `bobo-game.js` — make host-agnostic
- Add `window.BOBO_CFG = { base, players, settings, recent, saveScore, saveLevel, mqtt }`; read it for
  all data + MQTT URLs. Dashboard sets it to the existing dashboard endpoints
  (`/api/household-users`, `/api/dashboard-settings/medical.bobo_game`, `/api/medical/test-results`);
  the LXC `bobo.html` sets it to `/api/bobo/*`. **One shared game file, no logic fork.**
- Fold in the **auto-start** (this session's other TODO): on the TV page, auto-pick default user +
  difficulty from settings → `startGame()` (removes the "can't press Play with the TV remote" gap).

### 3. `bobo.html` — standalone lightweight TV page
- Minimal shell (no Medical-page chrome): sets `BOBO_CFG` to the LXC endpoints, includes
  `mqtt.min.js` + `bobo-game.js`, one `#bobo-root`. Loads fast on the TV browser.

### 4. `bobo-game.service` — systemd unit
- `ExecStart=/opt/media-agent/venv/bin/python3 /opt/media-agent/bobo_game_service.py`,
  `EnvironmentFile=/etc/environment`, `Restart=always`, orphan-guard `ExecStartPre` like the other
  media services (kill stray on 8770). `systemctl enable --now bobo-game`.

### 5. Repoint the TV browser Home page
- From `http://192.168.1.128:3000/medical.html#bobo` → **`http://192.168.1.138:8770/`**.
- Re-save once on the TV: focus the Home-page URL field, send the new URL via
  `tv_typenow.py` (the `SendInputString` path that worked), user Saves. Then `tv_launch.py` (DIAL
  stop+start) lands the browser on the LXC game with the laptop off.

## Fits alongside the other tomorrow TODOs (same session)
- **Auto/Manual flow**: BoBo `ble_connected` rising-edge → TV on (HA/CEC/WoL) + `tv_launch.py`
  (browser → LXC game). Auto = default user+difficulty auto-start; Manual = just land on the page.
  Trigger = a `bobo` rule (LXC 105) or small watcher; TV/DIAL calls stay on LXC 100.
- **Game-card settings** (dashboard): mode + default user + default difficulty → `medical.bobo_game`
  (read by both the dashboard game and the LXC `/api/bobo/settings`).
- **"Show live values" toggle** (calibration wizard `js/medical-bobo.js`): auto-check on BoBo connect,
  auto-uncheck on disconnect.

## Verify
- Laptop **off** → open TV browser (auto or manual) → game loads from `192.168.1.138:8770`, board
  steers (MQTT 107). Crash → score row in `medical_test_results` (psycopg2 write) → appears in
  Medical → Tests → Test Results (⚖ Balance) when the dashboard is next up.
- Dashboard game (Medical → Settings) still works unchanged (its own `BOBO_CFG`).

## Architecture note
Dashboard stays UI-only; the game runtime + its data API run on **LXC 100** (an LXC, per the hard rule).
The dashboard Medical page keeps the calibration wizard + game card for config/desktop play.
