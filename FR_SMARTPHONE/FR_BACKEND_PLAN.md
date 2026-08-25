# FR Backend Plan (grounded) — build new · migrate · decommission old

> **Status:** PLAN — backend not built yet; **the PHONE side is DONE** (LineageOS + `fr_camera_app`:
> MJPEG stream on `:8080`, all recognition + **enrollment** states, always-on kiosk — see
> `FR_SMARTPHONE/CLAUDE.md` + `fr_camera_app/README.md` for the full MQTT state contract). Grounded
> against the live code/DB/MQTT/infra, **re-verified side-to-side 2026-08-25**.
>
> **Goal:** replace the old entrance FR (Hi-Link TX-510 `face_01`) with a new engine on a dedicated
> LXC, fed later by the de-Googled phone as the camera. Build + prove the whole backend FIRST
> (phone-independent, using an existing camera), then migrate the door chain, then delete the old FR.

---

## End-state flow
```
corridor presence  +  home_mode = home
        │  (existing "Move in Corridor" rule, gated by s_mic_gate)
        ▼
  start_recognition  ──►  FR service (LXC 112) pulls frames from the camera, recognizes
        │
        ▼
  match?  ──►  check fr_faces.allowed
        │
        ├─ allowed  ──► publish face_identified ──► "Face Recognition Loop" rule ──► s_frl1_unlock chip
        │                                                                            ──► remoteXY_01 open_doorlock ──► DOOR OPENS
        └─ denied / unknown ──► log to fr_events, NO unlock
```
The physical door (RemoteXY lock) and the corridor automations are UNCHANGED — we only swap the
"who is this, and are they allowed?" brain in front of the existing unlock chip.

---

## GROUNDED FACTS (verified, do not re-guess)

**Infra / LXC**
- PVE host `192.168.1.101`: 16 cores, ~43 GB RAM free, 857 GB disk free — room for a new LXC.
- New **LXC 112 "fr" @ `192.168.1.246`** — **re-verified free 2026-08-25** (⚠ `.247` is now **USED** — the
  old `.246/.247/.248` note is stale; `.246` + `.248` free, `.249` robot). `net_devices` MISSES static LXC IPs
  → always confirm with `pct list` + a live ping at build time, don't trust the table.
- **Orchestrator monitoring** = ONE `agents` row. Columns are `name, lxc_id, lxc_ip, service_name, data_table,
  settings_table, enabled, deploy_path, git_branch, service_oneshot` — **there is NO `restart_cmd` column**
  (the orchestrator's `check_service` derives the restart from `service_name`). FR row: `name='fr'`,
  `lxc_id=112`, `lxc_ip='192.168.1.246'`, `service_name='fr-agent'`, `data_table=NULL`, `settings_table=NULL`
  (event agent, same shape as `email`/`privacy`).

**Engine (forced, not a preference)**
- The existing media analyzer uses **InsightFace / ArcFace (`buffalo_l`)** — **Chinese-origin → BANNED** by `[[feedback_no_chinese_tools]]` (`MEDIA/agent/analyzer.py:154`, `scripts/embed_crop.py:11`, `MEDIA/CLAUDE.md:6,43`).
- Existing face data (`face_crops`, `person_embeddings`, `face_registry`) = 512-dim **ArcFace** vectors → **NOT reusable** (incompatible with a compliant engine, and the engine is banned).
- **USE `dlib` + `face_recognition` (US-origin, clean).** NOT CompreFace unless its recognition model is verified non-Chinese (its default is often ArcFace-based → risky). The media ArcFace subsystem is SEPARATE (photo tagging) and stays untouched.

**Camera (go2rtc)**
- go2rtc for the balcony/living-room webcams runs on the **PVE host `192.168.1.101`** (`/opt/go2rtc/`), ports API `:1984`, RTSP `:8554`.
- Test camera (Phase-0 stand-in) = **`rtsp://192.168.1.101:8554/balcony_cam`** (MJPEG-native C925e, cheap to decode). Single frame: `http://192.168.1.101:1984/api/frame.jpeg?src=balcony_cam`.
- A future phone IP-cam = one new `streams:` entry in the PVE `go2rtc.yaml` (pattern: `phone_entrance_cam: [ rtsp://<ip>:<port>/<path> ]`), then `systemctl restart go2rtc`.

**Door chain (the integration point)**
- Path: `face_identified` → `mur/home/esp/face_01/event` → **Face Recognition Loop** rule (`RULES/rules/face_recognition_loop.py`, group `corridor`, `triggers=['face_01']`) → dispatches the `s_frl1_unlock` chip (`@RemoteXY Gate door_open on`) → `remoteXY_01` `open_doorlock` on `mur/home/esp/remoteXY_01/command` → `openDoorlock()` → relay pin 14, `door_lock_ms` (500 ms).
- ⚠ Docs claiming the RemoteXY board subscribes to face events directly are **STALE** — the **rule engine is the bridge**.
- ⚠ Event envelope quirk: `{"kind":"face_identified","src":"...","payload":"{\"user_id\":N,\"user_name\":\"X\"}","ts":<uptime-sec>}` — `payload` is a JSON-encoded **string** (not nested), `ts` is uptime not epoch. The new service must emit this shape (or verify the engine's projection still classifies `dps.kind=='face_identified'`).
- ⚠ `s_frl1_unlock` may be **empty/unconfigured** today → author it if so.
- ⚠ **NO per-person "allowed" gate exists anywhere today** — any recognized face unlocks (if the chip is authored + `remoteXY_01.door_open_enabled` is true). The allow-gate is 100% new.
- MQTT: shared **`esp_boards`** user, ACL `readwrite mur/home/esp/+/#` (covers a new `face_XX`). Rule engine is a separate `mqtt_rule` identity.

**Dashboard**
- There's a **`/create-agent` skill** that scaffolds `routes-fr.js` + `fr.html` + `js/fr.js` + migrations + `DBV_GROUPS` + `retention_policies` + sidebar. USE IT (don't hand-build).
- UI-only rule: `js/fr.js` calls the FR LXC directly (Email-agent pattern, `js/email.js:1-4`); `routes-fr.js` (one `require()` in `server.js`, past the architecture-guard hook) only for DB-backed reads.
- DB: migrations `FR/migrations/*.sql` → scp LXC 104 → `psql 192.168.1.219 home_data`. Register tables in `DBV_GROUPS` (`server.js:~2373-2396`) + `tsCol` map + a `retention_policies` INSERT; mark face data 🔒 `protected`. `agents` row with `data_table`/`settings_table` = NULL (event/cache agent, like email).
- `household_users` (`PRIVACY/004_household_users.sql`) = identity to FK against; it has **no** face/allowed column.

---

## PART A — Build the new FR backend (phone-independent)

### A1 — FR LXC + engine
- Create **LXC 112 "fr" @ `192.168.1.246`** on PVE (verify IP free with a live ping-scan first), Debian, 2c/4GB/~20GB. Unprivileged is fine for dlib (no Docker needed).
- venv: `pip install face_recognition dlib flask paho-mqtt opencv-python-headless numpy`.
- `fr_service.py` (Flask + MQTT): `POST /enroll` (photo → 128-d encoding, store), `POST /recognize` (frame → best match + distance), `GET /health`. Smoke test enroll+recognize a photo. No camera/phone yet.
- Deliverables: LXC 112 up; `FR_SMARTPHONE/lxc/` (service + systemd unit + README); root `CLAUDE.md` LXC-index row; Project Health `svc-fr` cell.

### A2 — Faces DB + management UI (scaffold via `/create-agent`)
- Migration `FR/migrations/001_fr.sql`:
  - `fr_faces` (`id, name, allowed BOOLEAN DEFAULT false, household_user_id FK household_users, encoding_ref, photo_path, enrolled_at, updated_at`) — retention **forever + 🔒 protected**.
  - `fr_events` (`id, ts, name, allowed, distance, source_camera, action ('unlock'|'denied'|'unknown')`) — retention **90 d**.
  - Register both in `DBV_GROUPS` ("Face Recognition") + `tsCol` + `retention_policies`.
- UI: `fr.html` (from `corridor.html`) + `js/fr.js` — Enroll (capture from a camera / upload photo → name → **Allowed** toggle), Faces list (name · allowed · thumbnail · delete), Recognition log. `js/fr.js` hits the FR LXC directly; `routes-fr.js` serves `fr_faces`/`fr_events` reads from `db`. Sidebar under "Agents".

### A3 — FR service loop + door wiring
- **Trigger (#1 — corridor presence + home_mode=home):** the FR service does NOT run continuously. It's woken by `start_recognition` from the existing **Move in Corridor** rule, which fires on corridor presence and is gated by `s_mic_gate` (home_mode=home). It recognizes for a short window, then idles.
- On a match, look up `fr_faces.allowed`:
  - **allowed** → publish the `face_identified` envelope (grounded shape above) to `mur/home/esp/face_XX/event` (new id) → existing unlock rule fires the door. Log `action='unlock'`.
  - **not allowed** → log `action='denied'`, NO publish, NO unlock.
  - **unknown** → log `action='unknown'`, no unlock.
- MQTT: reuse `esp_boards` creds (or a dedicated FR user) with write on `mur/home/esp/+/#`.

### A4 — End-to-end test (no phone)
- Point the service at `rtsp://192.168.1.101:8554/balcony_cam`. Enroll your face, Allowed=true.
- ✅ recognize → `face_identified` → door fires → `fr_events` row.
- Flip Allowed=false → recognizes but **no unlock** (`denied`). Unenrolled face → `unknown`, no unlock.
- Done when camera → engine → faces DB (name+allowed) → MQTT → door + log all work on a real camera.

### A5 — Orchestrator monitoring + backups (wire it in like every other LXC)
- **Orchestrator:** add the `agents` row above → `check_service` SSHes + `systemctl is-active fr-agent`
  every cycle, **auto-restarts** on failure, writes `service_down`/`service_ssh_failed` to `system_alerts`
  (soft-fail smoothing already handles brief blips). Retention driven by the `fr_events` policy (90 d) +
  `fr_faces` (forever + 🔒 protected).
- **Project Health:** add a `svc-lxc112` TCP:22 cell + an `fr_agent` service dot (same pattern as `voice_agent`).
- **Backups (identical to the LXC-111 ROBOT setup):**
  - On-site PVE vzdump (⚠ PVE host): QNAP subfolder `/PBS_Data/FR_Data` → PVE storage `QNAP_FR_Backup` →
    a `/etc/pve/jobs.cfg` vzdump job (keep-daily=4). *(12 per-guest jobs exist today for 100–111.)*
  - Off-site (weekly, encrypted Drive): add `112` to `GUESTS` in `scripts/guests-cloud-backup.sh`
    (currently `100 … 111`); retention via the global `guests_copies` (=4).
  - **No `backup_jobs` row** (those are file-level laptop/Pi dirs) — the guest-image vzdump covers the LXC,
    and the faces DB lives in LXC 102 (nightly dump). Decide: face photos on the LXC vs QNAP (recommend QNAP).

---

## PART B — Migrate old → new (run BOTH, cut over, verify FIRST)
1. Register the new FR service as a `devices` row (protocol esp/mqtt, id e.g. `face_lxc`) with a `recognition` channel (`action_on: start_recognition`).
2. **Repoint the trigger:** in Base Rule Settings, edit `Move in Corridor` FR chips from `@Face Recognition …` → `@<NewFR> …` — specifically `s_mic5_pixoo`'s `recognition on` segment (the recognition kick). DROP `s_mic2b_fr` + `s_mic7_end_dev` (screen on/off) since the phone/LXC owns its own screen.
3. **Repoint the unlock rule:** KEEP `RULES/rules/face_recognition_loop.py` but change `FACE_01_ID='face_01'` → the new id (`:67`) and `RULE['triggers']` (`:81`), so it fires on the new service's `face_identified`. Its `s_frl1_unlock` chip (→ `@RemoteXY Gate`) is unchanged → door works identically. (Retry sentences `s_frl2_retries`/`s_frl3_delay` — keep if reusing the loop, delete if the LXC owns retry.)
4. **VERIFY the door unlocks via the new FR + the allow-gate BEFORE removing anything.** Old TX-510 stays live during this.

---

## PART C — Decommission the old FR (delete old-only; keep door + corridor)

### DELETE (Bucket A — old-FR-only)
- `face_01` ESP board (unplug) + sketch `C:\Users\muroc\Arduino_Projects\Face_Recognition_Claude\`.
- DB `esp_boards` row + `devices` row for `face_01` (disable first); clear retained `mur/home/esp/face_01/{schema,status,availability}` on LXC 107.
- `esp-boards.js`: `recognition` group (`:75-85`) + `face_controls` group (`:87-92`) + Enrolled-Users table/Delete-by-ID/Register handlers (`:478-702`) + their `SURFACED_ELSEWHERE` entries (`:724`).
- `rule_engine.py`: face_01 `_ESP_STATUS_DPS_FIELDS` fields (`:971-978`: `screen_state, module_state, last_recognition, last_recognition_ts, enrolled_count, pending_user_name, users`) + the face_01 event-routing comment (`:868-882`). KEEP the generic `_resolve_esp_action` branch.
- Corridor-Simulator FR bits: `server.js` `CORRIDOR_SIM_IDS.fr` (`:4452`), `trigger-fr-event` (`:4838-4889`), `fr-diagnostics/unlock-chip` (`:4580-4640`), the `/state` fr leg (`:4650`); `main-agent.js` `FR_ID` (`:2019`), topicMeta FR, FR card state (`:2083-2108`), `renderFrUserPicker` (`:2167-2234`), FR screen buttons (`:2279-2285`), FR-diagnostics JS (`:529-614`); `main-agent.html` FR card ④ (`:330-338`) + FR-Diagnostics card (`:397-429`).
- Docs: root `CLAUDE.md:54,61,394,409,418`; `CORRIDOR/CLAUDE.md:17,30`; memory pages `project_face_recognition_board`, `project_corridor_simulator` (external memory — verify manually).

### KEEP (Bucket B — shared; deleting breaks the door/corridor)
- **RemoteXY door lock** `remoteXY_01` (IP `.144`, the physical door) — `esp_boards`/`devices` rows, `doorlock` ACTION_GROUP (`esp-boards.js:66`), `_ESP_STATUS_DPS_FIELDS door_relay/charge_relay/door_open_enabled` (`rule_engine.py:952-953`), corridor-sim card ⑤.
- **Move in Corridor** non-FR chips (light `s_mic1`, entrance monitor `s_mic2`, awtrix `s_mic3`, pixoo `s_mic5`/`s_mic8`, delay/cooldown/leaving/gate knobs) + **Corridor Transit Classifier** + corridor presence sensor (`bfbdca138cb1c78c3dlbmc`) + `home_mode`/Mode Buttons + the `corridor` group.
- **Media analyzer ArcFace** (`face_registry`, `face_register.py`, `embed_crop.py`) — separate photo-tagging subsystem, NOT the door.

### REPOINT (Bucket C — rewire old→new, not delete)
- Move in Corridor FR chips (`s_mic2b_fr`, `s_mic5_pixoo`'s `@Face Recognition recognition on` segment, `s_mic7_end_dev`) → new FR device (Part B step 2).
- `Face Recognition Loop` rule → new id (Part B step 3). `s_frl1_unlock` chip reused (already targets `remoteXY_01`, door-independent of face_01).

### Safe decommission order
1. Repoint (Part B) + **verify door via new FR**.
2. Disable then delete `face_01` DB rows + clear retained `mur/home/esp/face_01/*` topics on LXC 107.
3. Remove old-FR code (esp-boards.js groups/table, rule_engine fields, corridor-sim FR endpoints/JS/HTML).
4. Update docs + external memory.
5. Unplug hardware + delete sketch folder.

---

## Deferred to the phone phase (AFTER Knox=Normal → LineageOS)
- Flash LineageOS (staged; ~20 min once Knox reads `Normal` — see memory `project_fr_smartphone_flash`).
- Phone IP-cam app → its RTSP added as a new go2rtc `streams:` entry on the PVE host → the FR service points at it instead of `balcony_cam`.
- Phone panel app showing **Recognizing / Welcome, <name> / Not allowed** (reacts to MQTT replies).
- Front-vs-rear camera choice · liveness/anti-spoof for the lock · retire TX-510 or run both (Part B already lets both run in parallel during migration).

## Open decisions (confirm at build start)
1. dlib/face_recognition (recommended) vs a verified-clean CompreFace.
2. New LXC IP `.246` (re-verify free live) + number 112.
3. Keep the retry loop (`s_frl2/s_frl3`) or let the LXC own retry.
4. Which chips to drop from Move in Corridor (screen on/off vs keep a single start-recognition trigger).
5. New event topic id (`face_lxc` / `face_phone`) vs reusing `face_01`'s topic.

## Suggested execution (one clean session each)
A1→A2 (bulk) → A3→A4 (quick) → **B (verify door)** → **C (decommission, in the safe order)**. Parts A/B don't touch the phone or block on Knox; the phone only enters at the "deferred" stage.
