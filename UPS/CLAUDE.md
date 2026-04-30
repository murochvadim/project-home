# UPS subsystem — APC Back-UPS BX2200MI

Centralized index for everything related to the home UPS, its orchestrated shutdown, the polling daemon, the dashboard surface, and the safety knobs.

## Hardware

| Field | Value |
|---|---|
| Model | APC Back-UPS BX2200MI |
| Firmware | 378700G -302202G |
| USB ID | 051d:0002 |
| Serial | 9B2507A50555 |
| Capacity | 2200 VA / 1200 W |
| Battery | 24 V lead-acid (BATTV ≈ 27 V healthy) |

USB cable plugs into a back panel USB-A port on the **Proxmox host** (PVE, `192.168.1.101`); kernel exposes it at `/dev/usb/hiddev0`.

## Architecture

```
                      Mains (wall)
                          │
             ┌────────────┴───────────┐
             │  APC Back-UPS BX2200MI │  ← 1200 W battery backup, ~30 min runtime at home load
             └─────┬──────────────┬───┘
                   │              │  Battery output sockets
                USB │              ↓ (powers what the user plugs in)
                   ↓
   PVE host (192.168.1.101) ─── eth0 ─── Aruba 1960 switch ─── LAN (192.168.1.0/24)
        │
        ├ apcupsd MASTER (USB monitor + NIS server on TCP 3551)
        ├ /etc/apcupsd/doshutdown ← orchestrator (SAFETY_MODE-gated)
        ├ /etc/apcupsd/SAFETY_MODE ← if present, orchestrator log-only
        └ /root/.ssh/id_ed25519_ups ← key for SSH to QNAP poweroff
                   │
                   │ NIS poll (3551)
                   ↓
   LXC 105 / MainAgent (192.168.1.187)
        │
        ├ apcupsd NIS SLAVE (no shutdown logic — observer)
        ├ /opt/network-agent/ups_poll.py ← every 60 s via systemd timer
        └ writes → ups_status table on LXC 102
                                   │
                                   ↓
   Dashboard (Windows host, pm2)
        │
        └ Project Health → UPS tab (4 cards: Live / Battery health / Tests / Events)
```

## Files (source of truth in repo)

| Path | Role |
|---|---|
| [scripts/ups_poll.py](scripts/ups_poll.py) | LXC 105 polling daemon — reads `apcaccess`, parses, INSERTs into `ups_status` |
| [scripts/net-ups-poll.service](scripts/net-ups-poll.service) | systemd unit that invokes ups_poll.py |
| [scripts/net-ups-poll.timer](scripts/net-ups-poll.timer) | every-60s timer for the service |
| `/etc/apcupsd/apcupsd.conf` (PVE) | Master config — `UPSCABLE=usb`, `UPSTYPE=usb`, `BATTERYLEVEL=5` (paranoid until going live), `NETSERVER=on`, `NISIP=0.0.0.0`, `NISPORT=3551` |
| `/etc/apcupsd/apcupsd.conf` (LXC 105) | Slave config — `UPSTYPE=net`, `DEVICE=192.168.1.101:3551`, `BATTERYLEVEL=0` (slave never triggers), local NIS on 127.0.0.1 |
| [scripts/doshutdown](../scripts/doshutdown) → `/etc/apcupsd/doshutdown` (PVE) | The orchestrator. SAFETY_MODE-gated. **Phased shutdown** (added 2026-04-30): [1] QNAP halt via CGI → [2] **Phase A clients in parallel, 60 s timeout** (LXCs 100, 103, 104, 105, 106 + VM 101) — these all write to Postgres / MQTT, must finish first → wait → [3] **Phase B services in parallel, 30 s timeout** (LXCs 102 Postgres + 107 MQTT) — safe to halt now, no clients writing → wait → [4] write Phase 4 marker `/etc/apcupsd/last_shutdown_reason` → `shutdown -h now`. The phasing prevents transactions getting rolled back when Postgres/MQTT die mid-write — each client gets time to flush before its broker dies. |
| [scripts/doshutdown_rehearse](../scripts/doshutdown_rehearse) → `/etc/apcupsd/doshutdown_rehearse` (PVE) | Same orchestration body as `doshutdown` but **without** the final PVE halt + marker write. Used by the dashboard's "Shutdown" button on the Shutdown Propagation card so the user can verify the halt sequence end-to-end without needing to physically power-cycle the mini-PC. SELECTION env was dropped 2026-04-30 (always-all rule — see `feedback_ups_all_or_nothing.md` memory). |
| `/etc/apcupsd/SAFETY_MODE` (PVE) | If present: orchestrator logs and exits without shutting anything down. Default state until going live. |
| `/etc/apcupsd/onbattery` (PVE) | Hook fired by apcupsd when STATUS flips ONLINE → ONBATT (after `ONBATTERYDELAY=6 s` filter). INSERTs a `severity=warn, alert_type=ups_onbattery` row into `system_alerts` on LXC 102 with message `UPS on battery — N min runtime left at X% battery`. Idempotent (skips insert if an active row already exists). Best-effort (`timeout 5 psql ... \|\| true` — DB failures never block apcupsd). |
| `/etc/apcupsd/offbattery` (PVE) | Hook fired when mains restored. UPDATE `resolved_at = NOW()` on any active `ups_onbattery` row. |
| `/etc/apcupsd/commfailure` (PVE) | Hook fired when USB comm to UPS is lost. INSERTs `alert_type=ups_commlost`. Idempotent. |
| `/etc/apcupsd/commok` (PVE) | Hook fired when USB restored. Resolves `ups_commlost`. |
| [scripts/recover.conf](../scripts/recover.conf) → `/etc/apcupsd/recover.conf` (PVE) | Phase 4 auto-recovery config. 5 keys: `RECOVER_AUTO`, `RECOVER_MIN_BCHARGE`, `RECOVER_REQUIRE_ONLINE_SEC`, `RECOVER_BOOT_DELAY_SEC`, `RECOVER_MARKER_MAX_AGE_HOURS`. Read by `doshutdown_auto_recover` at boot. Tunable from dashboard (UPS tab → Auto-Recovery Settings sub-section). |
| [scripts/doshutdown_recover](../scripts/doshutdown_recover) → `/etc/apcupsd/doshutdown_recover` (PVE) | Recovery body: WoL QNAP via eth0 MAC + `10.0.0.255` broadcast → wait for QNAP ping → `mount -a -t nfs,nfs4,cifs` (re-trigger PVE NFS mounts that silently failed at boot when QNAP was offline) → `pct/qm start` for guests not already running. `flock` concurrency guard. `check_mains_or_abort` called 3× between phases — exits cleanly on STATUS≠ONLINE. Honors optional `SELECTION` env var for testing only (production always recovers all). |
| [scripts/doshutdown_auto_recover](../scripts/doshutdown_auto_recover) → `/etc/apcupsd/doshutdown_auto_recover` (PVE) | Phase 4 6-gate boot-time gate-check script. Sources `recover.conf`, then: G1 `RECOVER_AUTO=yes` → G2 marker present + age ≤ `MAX_AGE_HOURS` → G3 sleep `BOOT_DELAY_SEC` → G4 `apcaccess STATUS=ONLINE` → G5 ONLINE soak for `REQUIRE_ONLINE_SEC` → G6 `BCHARGE ≥ MIN_BCHARGE`. On all-pass: delegates to `doshutdown_recover`. Test env vars `DRY_RUN=1` (skip delegation), `FAST=1` (collapse sleeps to 1s+2s). Logs to `/var/log/apcupsd_shutdown.log`. |
| [scripts/apcupsd-auto-recover.service](../scripts/apcupsd-auto-recover.service) → `/etc/systemd/system/apcupsd-auto-recover.service` (PVE) | Phase 4 systemd unit. `Type=oneshot`, `After=network-online.target apcupsd.service pve-guests.service`, `ConditionPathExists=/etc/apcupsd/last_shutdown_reason` (only fires after a UPS-triggered halt — regular reboots ignored), `ExecStart=/etc/apcupsd/doshutdown_auto_recover`, `ExecStartPost=/bin/rm -f /etc/apcupsd/last_shutdown_reason` (always cleans marker — no recovery loops), `TimeoutStartSec=600`. |
| [scripts/wait_for_battery.sh](../scripts/wait_for_battery.sh) → `/etc/apcupsd/wait_for_battery.sh` (PVE) | Battery-charge gate. Reads `BATTERY_GATE_PCT` from `recover.conf`. If 0 → exit (off). If 1-99 → poll `apcaccess` every 30s until BCHARGE ≥ threshold AND STATUS=ONLINE; exit immediately on COMMLOST or unreadable apcaccess (no UPS to gate against); 10-min hard timeout fallback. Logs to `/var/log/apcupsd_shutdown.log`. |
| [scripts/pve-guests-battery-gate.service](../scripts/pve-guests-battery-gate.service) → `/etc/systemd/system/pve-guests-battery-gate.service` (PVE) | systemd unit `Before=pve-guests.service`. Runs `wait_for_battery.sh` to delay LXC/VM startup until UPS battery has recharged after a deep-discharge outage. Default off (`BATTERY_GATE_PCT=0`). `TimeoutStartSec=620` so a hung script never blocks pve-guests forever. |
| [scripts/lxc-nfs-refresh.sh](../scripts/lxc-nfs-refresh.sh) → `/usr/local/sbin/lxc-nfs-refresh.sh` (PVE) | Auto-heals LXC bind mounts to QNAP NFS/CIFS shares that went stale because the LXC started before the host mount was active. Auto-discovers `/mnt/qnap-*` host paths from `/etc/pve/lxc/*.conf`, ensures each is mounted (with retry, 5 min cap per path), then compares host vs in-container entry counts and runs `pct restart` only on the LXCs whose bind is stale. Idempotent — no-op when QNAP is healthy. |
| [scripts/lxc-nfs-refresh.service](../scripts/lxc-nfs-refresh.service) → `/etc/systemd/system/lxc-nfs-refresh.service` (PVE) | systemd unit `After=pve-guests.service`. Runs the refresh script on **every** PVE boot (not just UPS-triggered ones), so manual reboots, kernel panics, and outages all converge to a healthy state without touching `pve-guests` ordering. |
| BOILER/dashboard/public/health.html | Project Health → UPS tab markup (4 cards) |
| BOILER/dashboard/public/js/health.js | `ups*` functions (loadLive, loadHistory, loadEvents, runTest) |
| BOILER/dashboard/server.js | In-handler proxies on `/api/dashboard-settings/:key` for `_ups_live`, `_ups_history`, `_ups_events`, `_ups_test_<name>` |

## DB schema

`ups_status` on LXC 102 (PostgreSQL `home_data`):

```sql
CREATE TABLE ups_status (
  id           SERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       TEXT,           -- ONLINE / ONLINE SLAVE / ONBATT / COMMLOST / SHUTTING DOWN
  battery_pct  NUMERIC,        -- BCHARGE
  runtime_min  NUMERIC,        -- TIMELEFT in minutes
  line_volt    NUMERIC,        -- LINEV (input AC voltage)
  battery_volt NUMERIC,        -- BATTV (battery DC voltage, trends down with age)
  load_pct     NUMERIC,        -- LOADPCT
  model        TEXT,
  serial       TEXT,
  last_xfer    TEXT,           -- LASTXFER
  raw          JSONB           -- full apcaccess key-value dump
);
CREATE INDEX idx_ups_status_ts ON ups_status (ts DESC);
```

Retention: 30 days, auto-cleaned by `retention_policies`. ~1440 rows/day at 60-s cadence ≈ 8.6 MB at 30 days.

## Dashboard endpoints

All in-handler proxies on the existing `/api/dashboard-settings/:key` route — zero new `app.X(` calls (architecture-guard hook safe):

| Endpoint | Method | Purpose |
|---|---|---|
| `_ups_live` | GET | Latest row from `ups_status` + `age_sec` |
| `_ups_history?days=N` | GET | Recent rows for charting (BATTV trend) |
| `_ups_events` | GET | SSH to PVE, `tail -25 /var/log/apcupsd.events` |
| `_ups_test_apcaccess` | POST | Read live UPS status from PVE master |
| `_ups_test_qnap_ssh` | POST | Verify SSH key works on QNAP |
| `_ups_test_dryrun` | POST | Run `/etc/apcupsd/doshutdown` (SAFETY_MODE-gated, just logs) |
| `_ups_test_safety_on` | POST | Restore the `SAFETY_MODE` flag |
| `_ups_test_safety_off` | POST | Remove the flag — orchestrator becomes live |
| `_ups_settings` | GET | Reads live `/etc/apcupsd/apcupsd.conf` + flag file + service state, returns 7 fields: `battery_level`, `minutes`, `timeout`, `onbattery_delay`, `safety_mode`, `at_boot`, `nompower_w`. Drives Shutdown Settings sub-section. |
| `_ups_recover_settings` | GET | Reads live `/etc/apcupsd/recover.conf`, returns 5 fields: `recover_auto`, `min_bcharge_pct`, `require_online_sec`, `boot_delay_sec`, `marker_max_age_hours`. Drives Auto-Recovery Settings sub-section. |
| `_ups_settings_set` | POST | Single-field editor for all 11 fields above. Body `{field, value}`. Validates kind/range/enum, then SSHes to PVE and runs targeted `sed` (apcupsd.conf / recover.conf), `touch`/`rm` (SAFETY_MODE), `systemctl enable`/`disable` (apcupsd at boot). `apcupsd_int` writes also `systemctl restart apcupsd` so changes take effect immediately. |

In addition, `runHealthChecks()` in `server.js` reads the same latest `ups_status` row and surfaces it as `r.ups = { ok, status, battery_pct, runtime_min, line_volt, battery_volt, age_sec, stale }` on `/api/health/status`. This drives the **UPS** cell in the Project Health → System Status card (Infrastructure section, clickable to open the UPS tab) AND is counted by the sidebar Status badge in `alerts-monitor.js` — so a `COMMLOST` (USB unplugged) or stalled poller flips the top-left "Smart Home" indicator to red `⚠ N issues` on every page within 60 s.

## Lost-input-power warning (apcupsd hooks → system_alerts)

Independent of the orchestrator (which only fires on BATTERYLEVEL), apcupsd auto-runs scripts in `/etc/apcupsd/` on each event transition. The 4 hook scripts (`onbattery`, `offbattery`, `commfailure`, `commok`) write rows to `system_alerts` on LXC 102 — same table that drives the Project Health → System Alerts card and the sidebar Status badge.

| Event | Action | Row state |
|---|---|---|
| onbattery | INSERT `severity=warn, alert_type=ups_onbattery, source=apcupsd_pve, affected_agent=ups`, message includes live `TIMELEFT` + `BCHARGE` from `apcaccess` | active until offbattery |
| offbattery | UPDATE `resolved_at = NOW()` on the active `ups_onbattery` row | resolved |
| commfailure | INSERT `alert_type=ups_commlost`, message `UPS USB cable lost — apcupsd cannot reach the UPS` | active until commok |
| commok | UPDATE `resolved_at = NOW()` on the active `ups_commlost` row | resolved |

**Auth path**: `psql` from PVE → LXC 102 (192.168.1.219:5432) over the existing `192.168.1.0/24` trust subnet (same pattern as the boiler agent on LXC 103 — no DB password file on PVE). All hook scripts wrap the `psql` call in `timeout 5 ... || true` so DB failures (LXC 102 down, LAN blip) never block apcupsd's event handling. Idempotency: each INSERT is gated by `WHERE NOT EXISTS (... resolved_at IS NULL)` so re-firing the same event doesn't create duplicates.

**Dependency**: PVE has `postgresql-client` installed (~25 MB) — provides `psql`. Installed 2026-04-29 during Phase 2A.

**Detection lag**: `onbattery` fires within `ONBATTERYDELAY=6 s` of mains loss → row appears in dashboard immediately on next page load; sidebar Status badge picks it up within 60 s (alerts-monitor poll cadence with 2-tick smoothing).

**Manual test**: just run any of the 4 hook scripts on PVE directly (`ssh root@192.168.1.101 /etc/apcupsd/onbattery`). End-to-end test for commfailure/commok: physically unplug then replug the USB cable.

## SAFETY_MODE semantics

The orchestrator at `/etc/apcupsd/doshutdown` checks for `/etc/apcupsd/SAFETY_MODE` as its first action. If the file exists, it logs and exits. Removing the file is a single action that flips the orchestrator from "log-only" to "real shutdown on next BATTERYLEVEL trigger."

| State | What happens on BATTERYLEVEL trigger |
|---|---|
| `SAFETY_MODE` flag present | Log entry written to `/var/log/apcupsd_shutdown.log`, no commands run, no shutdown |
| `SAFETY_MODE` flag absent | Real orchestrator runs: SSH `poweroff` QNAP → `pct shutdown` LXCs → `qm shutdown` VMs → `shutdown -h now` PVE |

**The dashboard "Remove SAFETY_MODE" button is the gate to going live.**

## Going-live procedure (Phase 4 Part B)

Phase 4 Part A is **already installed** (auto-recovery machinery + dashboard editor + concurrency + mains-drop guard + NFS remount). All edits below can be done from the dashboard's UPS tab → Shutdown Settings + Auto-Recovery Settings sub-sections (click any value to edit). Per-step rationale:

When user is physically ready (UPS charged + PVE plugged into UPS battery output + QNAP plugged into UPS output + BIOS POWER_ON verified):

1. **(reference only, already done 2026-04-29)** Orchestrator's SSH pubkey installed on QNAP at `/share/homes/admin123/.ssh/authorized_keys`. Used by `/etc/apcupsd/doshutdown` and dashboard `_ups_test_qnap_ssh`. If username changes: `grep -rn "admin123@192.168.1.155"` finds both sites.
2. **B1 — `BATTERYLEVEL=30`**: dashboard Shutdown Settings → click "Shutdown at battery" → 30. (Auto-restarts apcupsd.)
3. **B2 — `MINUTES=8`**: dashboard Shutdown Settings → click "Shutdown at low runtime" → 8.
4. **B3 — apcupsd at boot = enabled**: dashboard Shutdown Settings → click "Auto-start after PVE reboot" → enabled. (Already done 2026-04-30 during recovery hardening — confirm.)
5. **B4 — `RECOVER_AUTO=yes`**: dashboard Auto-Recovery Settings → click "Auto-recover after UPS shutdown" → yes. (No daemon to restart — read at next boot.)
6. **B5 — Remove SAFETY_MODE** (the moment of truth): dashboard Shutdown Settings → click "Safety mode" → absent. After this, the next time `BATTERYLEVEL=30` or `MINUTES=8` trips, the orchestrator fires for real.
7. **B6 — Verify**: dashboard "Test orchestrator (DRY RUN)" → should now log real commands (no SAFETY_MODE short-circuit).
8. **(optional) Part C — BATTERYLEVEL=95 mains-pull test**: temporarily set `BATTERYLEVEL=95`, unplug mains for ~30 s. Watch full orchestrator fire (system_alerts shows `ups_onbattery` warning, then full halt). After PVE halts + UPS KILLPOWER cuts output, plug mains back: verify UPS auto-restarts → PVE auto-boots (BIOS POWER_ON) → systemd `apcupsd-auto-recover.service` fires → 6 gates pass → `doshutdown_recover` runs → all guests come back. Reset `BATTERYLEVEL=30`.

## Known quirks / limitations

- **Aruba 1960 switch SSH refused on port 22** — switch shutdown step intentionally **dropped** from the orchestrator. Managed switches survive hard power loss without corruption.
- **`ISCONFIGURED=no` in `/etc/default/apcupsd` is NOT enforced** by the systemd unit on PVE 9.x — install starts the daemon. We mitigated by stopping/configuring/restarting deliberately during setup, and by `BATTERYLEVEL=5` + `SAFETY_MODE` keeping the orchestrator dormant.
- **First-time start risk** — if BCHARGE happens to be < BATTERYLEVEL at first start, daemon would immediately fire `doshutdown`. Pre-flight P4 check verifies BCHARGE > 50% before going live.
- **NFS to QNAP via dedicated `vmbr1` (10.0.0.x)** — not via Aruba switch. Shutting down switch does not break PVE↔QNAP communication.
- **HA recorder DB flush** — needs ~30-60 s. Orchestrator `qm shutdown --timeout 60` accommodates.
- **NUMXFERS=0** today — no real battery transitions yet (mains never lost since UPS came online).

## Subsystem skill

The `/pss-update` skill (in `.claude/skills/pss-update/SKILL.md`) automates routine UPS subsystem updates: status check, threshold adjustment, SAFETY_MODE toggle, orchestrator edit, peer add/remove. Use it instead of editing files by hand for non-trivial changes.

## Phases (history)

- **2026-04-29 Phase 1** — apcupsd master installed on PVE, USB comm verified, orchestrator written with SAFETY_MODE gate, SSH key generated.
- **2026-04-29 Phase 2** — apcupsd NIS slave on LXC 105, reading master successfully.
- **2026-04-29 Phase 3** — `ups_status` DB table + 60-s polling daemon + Project Health → UPS tab + 4 in-handler API proxies.
- **2026-04-29 Phase 3.5** — System Status surfaces `ups` cell + sidebar Status badge counts UPS health; `ups_status` listed in DB Volumes view.
- **2026-04-29 Phase 3.6** — QNAP SSH switched from `admin` (default) to `admin123` (custom admin in `administrators` group); orchestrator + dashboard test endpoint updated; pubkey installed at `/share/homes/admin123/.ssh/authorized_keys`.
- **2026-04-29 Phase 3.7** — Lost-input-power warning: 4 apcupsd hook scripts on PVE write `ups_onbattery` / `ups_commlost` rows to `system_alerts` (warn severity, idempotent, best-effort, < 7 s detection from mains loss). `postgresql-client` installed on PVE for trust-auth `psql`. Independent of Phase 4 — fires regardless of SAFETY_MODE.
- **2026-04-30 Phase 4 Part A — auto-recovery infrastructure installed (default OFF, safe).** Marker pattern: `doshutdown` writes `/etc/apcupsd/last_shutdown_reason` just before `shutdown -h now`. On next PVE boot, systemd unit `apcupsd-auto-recover.service` checks `ConditionPathExists` for the marker. If present, runs `doshutdown_auto_recover` (6 gates: master switch / marker age / boot delay / STATUS=ONLINE / online soak / battery charge), and on all-pass delegates to `doshutdown_recover` (WoL QNAP → wait → `mount -a` re-mounts NFS shares → start LXCs/VM). `flock` prevents concurrent runs (boot auto-recovery + dashboard manual Recover button). `check_mains_or_abort()` between phases exits cleanly if mains drop again mid-recovery. **Master switch** (`RECOVER_AUTO=yes` in `recover.conf`) keeps machinery dormant until explicit go-live. `apcupsd-auto-recover.service` is enabled but harmless without the marker file. Dashboard UPS tab → Trigger Settings card extended with **Auto-Recovery Settings** sub-section + made all 11 settings inline-editable with validation (apcupsd 4 ints, SAFETY_MODE flag, apcupsd-at-boot service toggle, recover.conf 1 enum + 4 ints). Live test validated: orchestrator halt sequence + marker write + systemd unit fire on boot + gate 1 exit + marker cleanup + concurrency guard. NFS remount step `[3.5/4]` added after live test exposed gap (analyzer crashed when LXC 100's bind mount pointed at empty `/mnt/qnap-media` because PVE's NFS mount silently failed when QNAP was still off at boot).
- **2026-04-30 Hardening (post-Phase 4 Part A test):** `onboot=1` set on all 7 LXCs + VM 101 (was only 100, 102, 101) so PVE auto-starts every guest on its own boot — `recover.conf` recovery script just adds QNAP WoL + NFS remount on top. apcupsd enabled at boot (was disabled — caused "UPS COMMUNICATION LOST" alert post-test when PVE rebooted without apcupsd auto-starting). Decision recorded in memory `feedback_ups_all_or_nothing.md`: shutdown and recovery always include every device, no per-device selection in production UI, no `onboot=1` subset.
- **(pending)** Phase 4 Part B — going live: BATTERYLEVEL=30 + MINUTES=8 (runtime safety net), `RECOVER_AUTO=yes`, SAFETY_MODE removed, BATTERYLEVEL=95 mains-pull test passed, KILLPOWER + auto-boot verified.
- **(out of scope today)** Phase 5+ — rule engine integration (`state.shared['ups.*']` keys → rules push Pixoo "POWER OUT" preset, etc.), battery-aging alerts.
