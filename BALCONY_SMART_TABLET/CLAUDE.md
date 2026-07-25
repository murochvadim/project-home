# Balcony Smart Tablet — Galaxy Tab A7 wall panel (PWA over MQTT)

> **STATUS: PLANNED — not started (plan captured 2026-07-25 for tomorrow).**
> Nothing built yet. This is the design/index doc; no code, service, or DB rows exist.

## Goal
A **Samsung Galaxy Tab A7** mounted on the wall as an always-on, full-screen
**whole-flat controller** — lights per room · scenes · home/away/abroad mode
(· curtains later). "Like the OpenHASP wall panels, but on a tablet," talking to the
project by **MQTT**. Chosen approach = a **tailored PWA panel** (not kiosking the
dashboard, not a generic MQTT app, not native).

## The load-bearing constraint
The Windows dashboard listens on `0.0.0.0:3000` **but the LAN firewall blocks inbound**
(deliberate), AND a wall panel must keep working **when the laptop is off**. So the panel
**cannot be served by, or fetch from, the dashboard**. It must be **LXC-hosted +
laptop-independent** — mirroring the **BoBo-game precedent** (`bobo_game_service.py` on
LXC 100:8770 serves the balcony-TV page so it works with the laptop dashboard OFF; its env
has `DB_PASS` + `MQTT_BROWSER_PASS`; `mqtt.min.js` is vendored — see
[BoBo balance bridge](../.claude/projects/c--Users-muroc-project-home/memory/project_bobo_balance_bridge.md)).

## Architecture (fits the hard rules — dashboard = UI-only, logic on LXCs)
```
Tab A7 (Fully Kiosk Browser, full-screen)
  └─ panel.html/js ── served by ──▶ panel_service (LXC, LAN-reachable, always-on)
       │                                ├─ GET /api/panel/config (Postgres:
       │                                │     dashboard_settings.panel + devices + scenes)
       │                                └─ GET /api/panel/pass    (MQTT_BROWSER_PASS)
       ├─ subscribe ws://192.168.1.189:9001  mur/home/device/+/state     (live state)
       └─ publish   ws://192.168.1.189:9001  mur/home/device/panel/event {kind,…}
                                                  │
                        rule_engine (LXC 105)     │  panel_commands.py (triggers=['panel'])
                                                  ▼  returns cmds → engine _dispatch_command/_run_scene
                                     real devices (Tuya/Zigbee/HA/scene/mode button)
```
- **Read state** = pure MQTT — the broker already publishes `…/state`, and the existing
  **`dashboard_browser`** user already has `read mur/home/device/+/state`.
- **Commands** = MQTT → a **dispatch rule on LXC 105** (business logic on the LXC).
- **Config + broker-pass** = the only HTTP, from the LXC panel service (the broker has no
  "list" to serve).
- **Laptop-independent:** panel service + broker + rule engine are all LXCs. The Windows
  dashboard is used only to *author* the config, never at runtime.
- Reuses the exact browser→broker pattern from `balcony.js`/`bobo-game.js`:
  `mqtt.connect('ws://192.168.1.189:9001', {username:'dashboard_browser', password})`.

## Build pieces (when we start)
1. **`panel_service`** — new small Flask service (mirrors `bobo_game_service.py`).
   Recommended host **LXC 100** (has the BoBo Flask pattern + `DB_PASS`+`MQTT_BROWSER_PASS`
   env, LAN-reachable, always-on) on a new port (e.g. **8771**). Endpoints: `GET /`
   (static panel) · `GET /api/panel/config` (reads `dashboard_settings.panel` + resolves
   names from `devices`/`apartment.scenes`) · `GET /api/panel/pass` (env). Repo home
   `BALCONY_SMART_TABLET/` (service + static + systemd + README), deploy copied from
   `BOILER/dashboard/bobo-lxc/`.
2. **Panel UI** — `panel/{index.html,panel.js,panel.css}` + `manifest.json`, vendored
   `mqtt.min.js`. Full-screen dark touch grid, PWA. v1 sections: **Scenes** (run buttons)
   · **Mode** (Home/Away/Abroad, active reflected from the 8-Gang state topic) · **Lights
   per room** (toggles, live on/off from `…/state`). Publishes to
   `mur/home/device/panel/event {dps:{kind,…}}`.
3. **`RULES/rules/panel_commands.py`** (LXC 105, group `panel`, `triggers=['panel']`) —
   `kind:'device'`→`[{device_id,action,channel,_skip_loop_guard:True}]`;
   `kind:'scene'`→`[{action:'run_scene',scene}]`;
   `kind:'mode'`→8-Gang channel toggle (HOME=ch4/AWAY=ch8/ABROAD=ch3; Mode Buttons handles
   mutual-ex). No engine-core change (reuses `_dispatch_command`/`_run_scene`). Deploy =
   scp + Reload, NEVER restart rule-engine.
4. **Broker ACL (LXC 107)** — one line: `dashboard_browser` gains
   `topic write mur/home/device/panel/event` (already has the reads). Reload mosquitto.
   No new user, no new listener (WS:9001 already exists).
5. **Config + a dashboard "Panel" editor tab (v1 — user wants dashboard↔tablet config
   sync).** Config lives in `dashboard_settings.panel` (main lights per room + scenes +
   modes). A **Panel editor tab on the (laptop) dashboard** lets the user pick which
   lights/scenes/rooms/mode buttons the tablet shows (+ order/labels) → writes
   `dashboard_settings.panel` → the LXC `panel_service` reads it → the tablet renders
   exactly that. Configure once on the dashboard, the tablet mirrors the layout. Two
   senses of "reflect": **config/layout** flows dashboard→tablet; **live device state**
   is mirrored by BOTH surfaces through the real devices over MQTT (not a direct
   dashboard↔tablet link). Authoring on the laptop dashboard is fine — only the tablet
   *runtime* must be laptop-independent.
6. **Kiosk** — Fully Kiosk Browser on the Tab A7 → start URL `http://<host>:8771/` →
   full-screen + keep-screen-on/dim + auto-reload; add-to-home-screen.

## Updating the "app" (no reinstall — it's a PWA)
The tablet never gets a reinstall/APK — the panel is a web page served by the LXC, so
updates are server-side and the tablet picks them up on reload:
- **Config** (which lights/scenes/rooms show) — edit the **dashboard Panel tab** → DB →
  tablet reflects on refresh. No deploy, instant. (Day-to-day, user-driven.)
- **App code** (features/fixes to the panel) — change files in `BALCONY_SMART_TABLET/`,
  `scp` to the LXC `panel_service` (+ bump cache-bust `?v=N`, same as every dashboard
  page); the tablet **reloads to the new version**. No reinstall.
- **Tablet picks it up** via **Fully Kiosk Browser** auto-reload (scheduled) + "clear
  cache on reload", or a manual pull-to-refresh. Home-screen icon = just a bookmark, so
  it always loads the latest from the server.

## Security (home-LAN threat model)
Safe for a home LAN — same trust model as the existing OpenHASP panels / dashboard /
ESP boards (plaintext MQTT + a shared browser user on the LAN); it adds **no new
internet exposure**.
- **LAN-only, behind the router** — never port-forward `panel_service`.
- **Narrow blast radius:** reuse the existing `dashboard_browser` MQTT user (restricted
  ACL) + add exactly ONE write (`mur/home/device/panel/event`) — a leaked cred can't do
  broker-admin, only that one command topic + the user's existing grants.
- **Realistic risk = someone already on the WiFi** (plaintext HTTP/MQTT on the LAN; the
  browser pass is LAN-reachable) — but that already applies to the current panels/
  dashboard, not new to this.
- **Harden cheaply:** Fully Kiosk PIN-lock the tablet (can't exit kiosk / change settings);
  strong WiFi; keep the tablet on the trusted network.
- **Overkill-if-ever:** a dedicated `tablet` MQTT user (not `dashboard_browser`) + TLS
  (`wss://` broker + HTTPS panel_service). Not needed for a home LAN.

## Open decisions (confirm before building)
1. **Host for `panel_service`** — reuse LXC 100 (recommended, least new infra) vs dedicated.
2. **Which lights/rooms in v1** — default = main light of each room unless a specific list.
3. **Curtains** — v1 or v2 (recommend v2 to keep v1 tight).
4. **Broker pass** — served via `/api/panel/pass` (recommended) vs baked into the page.

## Verification (when built)
- `curl http://<host>:8771/api/panel/config` returns the control list; `/api/panel/pass`
  the pass.
- Panel connects to broker WS; light tiles reflect live state; tapping a scene/mode/light
  publishes `mur/home/device/panel/event`, the `panel_commands` rule fires, the device
  actuates.
- **Kill the laptop dashboard → the panel still fully works** (proves laptop-independence).
- Fully Kiosk on the Tab A7: full-screen, always-on, survives reboot.

## Effort
Medium: one small LXC service (~BoBo-sized) + one rule + one ACL line + a static panel +
a config seed + docs. No engine-core change, no new broker user/listener, no runtime
dashboard dependency.
