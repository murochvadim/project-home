# BoBo Game — LXC 100 hosting (laptop-independent)

Serves the balcony-TV BoBo game **and** calibration from **LXC 100 (Media Agent, always on)** so the
TV works with the laptop dashboard off. Same URL the TV uses: **`http://192.168.1.138:8770/`**.

## What's here
- **`bobo_game_service.py`** — Flask service on port **8770**. Serves the static `bobo/` page + these
  Postgres/MQTT-backed endpoints (mirror the dashboard shapes so the shared JS is a pure URL swap):
  - `GET /api/bobo/{mqtt-pass, players, settings, recent, cal, tune}`
  - `POST /api/bobo/{settings, score, esp-params, cal, tune}`
  - `esp-params` publishes calibration params to `mur/home/esp/balcony_bridge/config` via paho as the
    `esp_boards` MQTT user (board saves to EEPROM — same as the dashboard's `/parameters`).
  - Static responses carry `Cache-Control: no-cache` so the TV always gets the latest.
- **`bobo/bobo.html`** — the standalone page (Calibration + Game cards, identical to Medical → Settings).
  Sets `window.BOBO_CFG` to the `/api/bobo/*` endpoints.
- **`bobo-game.service`** — systemd unit (venv python, `EnvironmentFile=/etc/environment`, orphan-guard).
- **`bobo_tv_watch.py`** + **`bobo-tv-watch.service`** — the **auto-switch**: watches the board's `pos`
  MQTT stream and drives the balcony TV. Step ON the board (stream flows) → turn TV **on** (tv_control.py
  `:8765` `{entity:'tv55',turn_on}` = SmartThings, reliable) → wait for the TV's DIAL
  (`:8080/ws/app/WebBrowser` — root `/` is 403, so poll the app endpoint) → `tv_launch.py` opens the game.
  Step OFF (no frames ≥ `BOBO_TV_OFF_DELAY`, default 60 s) → turn TV **off**. Anti-flap: must be connected
  `BOBO_TV_ON_SUSTAIN` (2 s) before on. Tunables via env; disable with `systemctl stop bobo-tv-watch`.
- **`tv/`** — TV-control helpers (Samsung WS remote / DIAL), used to point the TV at this page and for the
  planned Auto/Manual launch flow:
  - `tv_launch.py` — DIAL stop+start the TV browser (reopens on its Home page → the game).
  - `tv_sendurl.py <url>` — type a URL into the TV browser's focused field via `SendInputString`.
  - `tv_key.py <KEY…>` — send Samsung WS remote keys (no relaunch).
  - Token at `/opt/media-agent/tv55_bobo_token.txt` (paired once). TV IP `192.168.1.199`.

## Shared front-end (NOT copied here — deployed from the dashboard)
`bobo-game.js` + `medical-bobo.js` are the SAME files the dashboard uses
(`BOILER/dashboard/public/js/`), made host-agnostic via `window.BOBO_CFG`. `mqtt.min.js` is the vendored
copy from `public/vendor/mqtt/`.

## Deploy
```bash
cd BOILER/dashboard
scp bobo-lxc/bobo_game_service.py root@192.168.1.138:/opt/media-agent/
scp bobo-lxc/bobo/bobo.html        root@192.168.1.138:/opt/media-agent/bobo/
scp public/js/bobo-game.js         root@192.168.1.138:/opt/media-agent/bobo/
scp public/js/medical-bobo.js      root@192.168.1.138:/opt/media-agent/bobo/
scp public/vendor/mqtt/mqtt.min.js root@192.168.1.138:/opt/media-agent/bobo/
scp bobo-lxc/bobo-game.service     root@192.168.1.138:/etc/systemd/system/
scp bobo-lxc/tv/*.py               root@192.168.1.138:/opt/media-agent/
ssh root@192.168.1.138 "systemctl daemon-reload && systemctl restart bobo-game"
```
Env (once): `/etc/environment` on LXC 100 needs `DB_PASS`, `MQTT_BROWSER_PASS`, `ESP_BOARDS_MQTT_PASS`.

## Scores
Written to **`ph_bobo`** (Personal Health activity, keyed by `profile_id` — `/api/bobo/score` resolves the
profile from the household `user_id`). Moved off `medical_test_results`/`test_type='balance'` on 2026-07-07
(BoBo is an activity, not a test). Board input is MQTT-WS from LXC 107 (already laptop-independent).
NOTE: this `bobo_game_service.py` runs from `/opt/media-agent/` (parent) — deploy the `.py` there, NOT the
`bobo/` subdir (that only holds the static files).
