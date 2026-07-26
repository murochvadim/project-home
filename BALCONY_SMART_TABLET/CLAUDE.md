# Balcony Smart Tablet — Galaxy Tab A7 wall panel (PWA over MQTT)

> **STATUS: BUILDING — milestones 1 + 2 DONE (2026-07-26).** The command path, the touch
> PWA, and the dashboard editor are all live and verified. Remaining: m3 = mount + Fully
> Kiosk on the tablet.

## Built — milestone 2 (2026-07-26): the touch PWA + the "Smart Tablet" editor tab
- **Per-tile placement (2026-07-26):** each tile carries **`row` + `pos`** (page = which page it lives on). The editor renders **one band per row** (mirrors the tablet) with **drag-to-move** (HTML5 DnD, ⋮⋮ handle): drag a tile within a band to reorder, into another band to change its row, or onto the **"new row"** drop zone; on drop the target row renumbers `pos` 1..N (drag compacts a row — the number inputs re-add gaps). Drag is suppressed when grabbing an input/select/button/bindings so those stay editable. Handlers are **id-based** (indices are unreliable under drag). Each tile also has a **Page** dropdown (move to another page) + **Row** + **Position** number inputs, and tiles sort by `(row, pos)`. **Capacity enforced per page: `MAX_ROWS=3` × `MAX_COLS=5`** — Row/Pos inputs clamp to 1–3 / 1–5, `+ Add tile` fills the first free slot (alerts when the page is full), and drag into a full row or onto a 4th row is blocked. More controls → another page. The tablet sizes tiles to `screen ÷ maxCols` (capped 240px) and centers the whole grid vertically + horizontally. **Per-tile `icon`** — a built-in name from a **19-icon SVG set** (`ICONS` kept 1:1 in `panel.js` + `panel-editor.js`: heater/radiator, light, lamp, fan, ac, tv, lock, curtain, water, boiler, plug, speaker, thermostat, power, scene, gate, camera, music, door — rendered inline with `stroke=currentColor` so they green when on), **or** a custom emoji, **or** blank (auto by binding type). The editor's tile icon is a clickable **preview button → palette** (icon grid + emoji field + Auto) + **`hidden`** flag (editor Hidden checkbox) — a hidden tile renders on the tablet as an invisible **spacer** that still holds its slot, so you can leave gaps between tiles in the same row. The PWA renders each configured **row** as a horizontal band of **fixed-width (215px) tiles**, where `pos` is the **ABSOLUTE slot** within the row (1,2,3…): the row renders slots `1..maxPos` and **empty slots become invisible `.tile-spacer`s**, so a lone tile at pos 3 truly sits 3rd (gaps at 1–2). **Variable tiles per row** (user chose this over a fixed column grid) — each row's width = its own max pos; rows don't force cross-row column alignment. Backward-compatible: tiles missing `row/pos` default to row 1 / array order.
- **PWA** (`panel/{index.html,panel.js,panel.css}` + `manifest.json` + vendored `mqtt.min.js`) — replaces the m1 placeholder. Full-screen dark panel: **rows of tiles** (`#grid` is a vertical flex of `.tile-row` bands — see per-tile placement above), page tabs (hidden when 1 page), a live broker dot + clock. On load it fetches `/api/panel/config` + `/api/panel/pass`, `mqtt.connect('ws://192.168.1.189:9001',{username:'dashboard_browser',password})`, **subscribes `mur/home/device/+/state`** and lights a tile green when its first device-binding is on (`isOn` mirrors the rule's `_resolve_toggle`), and on **tap publishes ONLY `{dps:{tile:<id>,event:'short'}}`** to `mur/home/device/panel/event` (never a raw device command). Re-pulls config every 60 s so dashboard edits appear without reload. PWA/kiosk-friendly (`display:fullscreen`, no-zoom viewport, add-to-home-screen).
- **Editor** — a **"Smart Tablet" tab on the Balcony agent** (`balcony.html` + **`public/js/panel-editor.js`**, `pe*` namespace, own picker overlay so it never collides with balcony's `bc*` picker). Manages **pages → tiles → bindings**: add/rename/delete/reorder pages + tiles, per-tile label, and an **Edit-bindings picker mirroring balcony's `bc*`** (device toggle/on/off + channel, page-select, Alexa speak/play, Vacuum verbs) **plus Scenes** (a 🎬 section → `{type:'scene',target}`) **and Curtains** (`device_type='curtain'` → open/close/stop → `{type:'curtain',device_id,action}`). Reads/writes `dashboard_settings.panel` via the **generic `GET/POST /api/dashboard-settings/panel`** (no new server endpoint → stays clear of the architecture-guard hook). `● Unsaved` badge + beforeunload guard; **Open panel ↗** link to `http://192.168.1.138:8771/`. **Mode (Home/Away/Abroad)** = binding the 8-Gang Switch channels (HOME=ch4/AWAY=ch8/ABROAD=ch3) as ordinary device tiles — Mode Buttons handles mutual-ex.
- **Config `dashboard_settings.panel`** = `{"pages":[{id,name,tiles:[{id,label,bindings:[…]}]}]}` (bindings are the balcony-panel shape). No new table/migration.
- **Verified (2026-07-26):** editor Save (`POST /api/dashboard-settings/panel {value}`) → GET reflects it → `panel_service` serves the same to the tablet; combined with m1 (tap → `panel: tile … → N command(s)` → dispatch) the whole chain is proven. Both JS files pass `node --check`; PWA + `panel.js` + `mqtt.min.js` all serve 200 over the LAN. Config reset to `{"pages":[]}` so the user authors fresh in the editor.


## Built — milestone 1 (2026-07-26): the command path
The plumbing that turns a tablet tile-tap into a real device action, **laptop-independent**,
is live and verified. **Scope decision (user):** the panel is a **fully-configurable**
surface — every capability the OpenHASP balcony panel has (any device on/off/toggle+channel,
scenes, Home/Away/Abroad mode = an 8-Gang channel, curtains, Alexa, Pixoo, media) — and the
user binds each tile from a dashboard editor. So there is **no fixed "v1 control set."**
- **Broker ACL (LXC 107):** `dashboard_browser` gained **one** grant — `topic write mur/home/device/panel/event` (it already had the `…/+/state` + `…/+/event` reads). That's the tablet's ONLY write. Reload: `systemctl reload mosquitto`. Backup at `/etc/mosquitto/acl.bak.*`.
- **Rule `RULES/rules/panel_commands.py` (LXC 105, group `panel`, `triggers=['panel']`, priority 10):** fires on a `device_id='panel'` event, reads the tile id from `dps.tile`, resolves the tile's **bindings** from `dashboard_settings.panel` **server-side** (30 s TTL cache), and returns engine commands. `_build_command` is a **superset of `balcony_buttons.py`** — device (toggle/on/off/channel, `_resolve_toggle`, Alexa/Vacuum via `_display_chips`), `scene` (`run_scene`), `curtain` (`protocol:'curtain'`), `hasp_command`, `media`, `pixoo_preset`. Browser sends only a tile id → a rogue tablet can't inject arbitrary commands; all logic stays on the LXC. 1 s per-tile cooldown de-dupes double-publishes. Deploy = `scp … root@192.168.1.187:/opt/main-agent/project/RULES/rules/panel_commands.py` + reload (publish `{}` to `mur/home/rule-engine/reload`, or the dashboard Reload button) — **never** restart rule-engine.
- **Service `panel_service.py` + `panel-service.service` (LXC 100:8771):** mirrors `bobo_game_service.py` exactly (same venv `/opt/media-agent/venv`, `EnvironmentFile=/etc/environment` → `DB_PASS`+`MQTT_BROWSER_PASS`, orphan-guard, `Cache-Control:no-cache`). Read-only: `GET /` (PWA) · `GET /<path>` (static) · `GET /health` · `GET /api/panel/config` (`{value:<dashboard_settings.panel>}`) · `GET /api/panel/pass` (`{value:MQTT_BROWSER_PASS}`). **No command endpoint on purpose** — the browser's single MQTT publish is the only write. Deploy: `scp panel_service.py root@192.168.1.138:/opt/media-agent/` + `scp panel/index.html root@192.168.1.138:/opt/media-agent/panel/` + `scp panel-service.service root@192.168.1.138:/etc/systemd/system/` + `systemctl daemon-reload && systemctl enable --now panel-service`.
- **Config `dashboard_settings.panel`:** `{"pages":[{"id,name,tiles:[{id,label,bindings:[…]}]}]}` — currently `{"pages":[]}` (empty until the m2 editor). No new table, no migration.
- **Verified end-to-end (2026-07-26):** published `{"dps":{"tile":"t_test"}}` to `mur/home/device/panel/event` **as `dashboard_browser`** (the tablet's real cred/topic) → engine log `panel: tile 't_test' → 1 command(s)` → `Rule 'Panel Commands' -> turn_on …`. The test tile was bound to a **nonexistent device** so **zero hardware** was touched. Config/pass/static all serve over the LAN (`curl http://192.168.1.138:8771/…`). `index.html` is a **placeholder smoke-test page** — the real touch UI is milestone 2.

## Remaining
- **m2:** the touch PWA (`panel/{index,panel.js,panel.css}` + manifest + vendored `mqtt.min.js`) — tile grid, live on/off from `…/state`, publishes tile-id on tap; **and** a dashboard **"Panel" editor tab** reusing `device-picker.js` so the user authors pages/tiles and binds each to any device/scene/mode/curtain (writes `dashboard_settings.panel`).
- **m3:** mount + Fully Kiosk on the Tab A7 → `http://192.168.1.138:8771/`.

---
_Original plan below (still the reference for m2/m3)._

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
