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
| `/etc/apcupsd/doshutdown` (PVE) | The orchestrator. SAFETY_MODE-gated. On real fire: best-effort SSH `poweroff` to QNAP as `admin123@192.168.1.155` (key auth via `/root/.ssh/id_ed25519_ups`) → parallel `pct shutdown` LXCs → parallel `qm shutdown` VMs (HA gets `--timeout 60`) → wait → `shutdown -h now`. |
| `/etc/apcupsd/SAFETY_MODE` (PVE) | If present: orchestrator logs and exits without shutting anything down. Default state until going live. |
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

In addition, `runHealthChecks()` in `server.js` reads the same latest `ups_status` row and surfaces it as `r.ups = { ok, status, battery_pct, runtime_min, line_volt, battery_volt, age_sec, stale }` on `/api/health/status`. This drives the **UPS** cell in the Project Health → System Status card (Infrastructure section, clickable to open the UPS tab) AND is counted by the sidebar Status badge in `alerts-monitor.js` — so a `COMMLOST` (USB unplugged) or stalled poller flips the top-left "Smart Home" indicator to red `⚠ N issues` on every page within 60 s.

## SAFETY_MODE semantics

The orchestrator at `/etc/apcupsd/doshutdown` checks for `/etc/apcupsd/SAFETY_MODE` as its first action. If the file exists, it logs and exits. Removing the file is a single action that flips the orchestrator from "log-only" to "real shutdown on next BATTERYLEVEL trigger."

| State | What happens on BATTERYLEVEL trigger |
|---|---|
| `SAFETY_MODE` flag present | Log entry written to `/var/log/apcupsd_shutdown.log`, no commands run, no shutdown |
| `SAFETY_MODE` flag absent | Real orchestrator runs: SSH `poweroff` QNAP → `pct shutdown` LXCs → `qm shutdown` VMs → `shutdown -h now` PVE |

**The dashboard "Remove SAFETY_MODE" button is the gate to going live.**

## Going-live procedure

When user is physically ready (UPS charged + PVE plugged into UPS output + BIOS verified):

1. **Install the orchestrator's SSH pubkey on QNAP** (already done 2026-04-29 — kept here for re-deploy / hardware-swap reference):
   ```bash
   # QNAP user used by the orchestrator: admin123 (custom admin account in `administrators` group, NOT the default `admin`).
   # Append to /share/homes/admin123/.ssh/authorized_keys (perms 700 on dir, 600 on file):
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKAWBnlevV/wO+n/tLxoaNQ23KrrzFdR/TzrPOWSfNY4 ups-orchestrator@pve 2026-04-29
   ```
   The orchestrator script (`/etc/apcupsd/doshutdown`) and the `_ups_test_qnap_ssh` dashboard endpoint both SSH as `admin123@192.168.1.155`. If the username ever changes again, update both sides — `grep -rn "admin123@192.168.1.155"` finds them.
2. **Bump `BATTERYLEVEL`**: edit `/etc/apcupsd/apcupsd.conf` on PVE, change `BATTERYLEVEL 5` → `30`, then `systemctl restart apcupsd`.
3. **Enable apcupsd at boot**: `systemctl enable apcupsd` on PVE (currently disabled).
4. **Click "Remove SAFETY_MODE"** on the dashboard UPS tab.
5. **Verify**: dashboard "Test orchestrator (DRY RUN)" should now show real commands (or just `[1/3] poweroff QNAP` log entries since orchestrator no longer short-circuits).
6. **BATTERYLEVEL=95 mains-pull test** — temporarily set `BATTERYLEVEL=95`, restart apcupsd, unplug mains for ~30 s. Watch full orchestrator fire. After PVE halts and KILLPOWER cuts UPS output, plug mains back in: verify UPS auto-restarts AND PVE auto-boots (BIOS "Restore on Power Loss" must be on).
7. **Reset to production**: `BATTERYLEVEL=30`, restart apcupsd. System is live.

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
- **(pending)** Phase 4 — going live: BATTERYLEVEL=30, SAFETY_MODE removed, BATTERYLEVEL=95 test passed, KILLPOWER + auto-boot verified.
- **(out of scope today)** Phase 5+ — rule engine integration (`state.shared['ups.*']` keys → rules push Pixoo "POWER OUT" preset, etc.), battery-aging alerts.
