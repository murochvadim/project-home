#!/usr/bin/env python3
"""
Phone Link ("Link to Windows") Watchdog — LXC 104

Runs every 5 min via cron. SSHes into the Windows laptop (the dashboard host)
and probes the Phone Link app health, then writes alerts to system_alerts:

  - phonelink:offline    — PhoneExperienceHost.exe is not running at all
  - phonelink:crashloop  — PhoneExperienceHost crashed >= CRASH_THRESHOLD
                           times in the last 15 min (the failure mode the
                           2026-06-18/19 Windows App Runtime update caused —
                           a managed crash on launch, exception 0xe0434352).
                           Fix is reset + re-register the app.
  - phonelink:disconnected — PhoneExperienceHost is running but has NO
                           established TCP:443 to the Microsoft relay for
                           >= DISCONNECT_MATURE_SEC (app open but can't send —
                           the 85-min SILENT outage on 2026-06-24 that the
                           offline/crashloop checks both missed). Maturity is
                           tracked via a timestamp file because this process has
                           no memory between cron runs; the timer counts only
                           contiguous awake-and-bad time (a skipped/asleep pass
                           restarts it). Auto-resolves when the relay returns.

Auto-resolves each alert when the condition clears — same pattern as
group_health_watchdog.py / netbird_watchdog.py.

IMPORTANT — laptop-asleep is NOT an alert. The dashboard host is WiFi-only and
sleeps; when the SSH probe can't reach it we simply skip this pass and leave
the existing alert state untouched (so a sleeping laptop never false-fires
phonelink:offline). Laptop reachability itself is already covered by the
backup-script reachability check.

The probe reads the same three signals used to diagnose the 2026-06-22
incident:
  1. PhoneExperienceHost.exe running?
  2. An established TCP:443 connection to a non-LAN address (the Microsoft
     relay) from that PID — proves the app is actually linked, not just open.
  3. Count of Application Error (1000) crashes for PhoneExperienceHost in the
     last 15 min (crash-loop detection).

Companion to:
  - Dashboard surface: Project Health → System Alerts card (auto) + the
    "Link to Windows" cell in the System Status > Services section
    (derived in server.js /api/health/status from these alerts).
  - Alerts table:      system_alerts (LXC 102)

This watchdog only sees the LAPTOP side. A flaky phone-side send (Samsung
suspending Link to Windows) shows the laptop green and is NOT detectable here.
"""

import base64
import logging
import os
import subprocess
import sys
import time

import psycopg2

log = logging.getLogger('phonelink-watchdog')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

# ─── Config ───────────────────────────────────────────────────────
DB = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}
LAPTOP          = 'muroc@192.168.1.128'
SSH_OPTS        = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                   '-o', 'StrictHostKeyChecking=accept-new']
CRASH_THRESHOLD = 3        # crashes in 15 min → crashloop
SOURCE          = 'phonelink_watchdog'
AGENT           = 'phonelink'

# "disconnected" = app running but NOT connected to the Microsoft relay (can't
# send). Must persist this long before alarming. Tracked via a timestamp file
# because this process keeps NO memory between 5-min cron runs.
DISCONNECT_MATURE_SEC = 600     # ~10 min (≈ 2-3 consecutive 5-min passes)
POST_WAKE_GRACE_SEC   = 600     # EXTRA grace on top of maturity when the disconnect
                                # began right after a wake. Phone Link is routinely
                                # slow (5-15 min) to re-establish the relay after the
                                # laptop wakes from sleep, and it self-heals — so a
                                # post-wake disconnect only alarms if it persists past
                                # MATURE+GRACE (~20 min). A genuine long outage still
                                # fires; normal wake-up reconnects no longer do.
SKIP_GAP_SEC          = 450     # if the previous bad pass was longer ago than
                                # this, a pass was skipped (laptop asleep) → the
                                # maturity timer restarts (counts only contiguous
                                # awake-and-bad time, so sleep can't false-fire it)
STATE_DIR             = '/var/lib/phonelink-watchdog'
RELAY_DOWN_FILE       = os.path.join(STATE_DIR, 'relay_down_since')
LAST_PASS_FILE        = os.path.join(STATE_DIR, 'last_pass')   # heartbeat — ts of the
                                # last COMPLETED probe. A gap > SKIP_GAP_SEC since this
                                # means a pass was skipped (laptop asleep) = we woke.

# PowerShell probe — emits one line: "PLW alive=<0|1> relay=<0|1> crashes=<n>"
PROBE_PS = r'''
$ErrorActionPreference='SilentlyContinue'
$p = Get-Process PhoneExperienceHost
$alive = 0; if ($p) { $alive = 1 }
$relay = 0
if ($p) {
  $c = Get-NetTCPConnection | Where-Object { $_.OwningProcess -in $p.Id -and $_.State -eq 'Established' -and $_.RemotePort -eq 443 -and $_.RemoteAddress -notmatch '^(127\.|::1|192\.168\.|10\.|fe80)' }
  if ($c) { $relay = 1 }
}
$crashes = (Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error';StartTime=(Get-Date).AddMinutes(-15)} | Where-Object { $_.Message -match 'PhoneExperienceHost' } | Measure-Object).Count
Write-Output ("PLW alive=$alive relay=$relay crashes=$crashes")
'''


# ─── system_alerts helpers (match group/netbird watchdog) ─────────
def upsert_alert(cur, alert_type, severity, message):
    cur.execute(
        "SELECT id FROM system_alerts WHERE alert_type = %s AND resolved_at IS NULL",
        (alert_type,),
    )
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE system_alerts SET ts = NOW(), message = %s WHERE id = %s",
                    (message, row[0]))
    else:
        cur.execute(
            """INSERT INTO system_alerts (ts, source, severity, alert_type, affected_agent, message)
               VALUES (NOW(), %s, %s, %s, %s, %s)""",
            (SOURCE, severity, alert_type, AGENT, message),
        )


def resolve_alert(cur, alert_type):
    cur.execute(
        "UPDATE system_alerts SET resolved_at = NOW() WHERE alert_type = %s AND resolved_at IS NULL",
        (alert_type,),
    )


# ─── disconnected-state tracking (timestamp file — no cross-run memory) ────
def _read_disc_state():
    """Returns (first_bad_ts, last_pass_ts, mature_sec). mature_sec carries this
    episode's maturity threshold (incl. any post-wake grace). Legacy 2-field files
    fall back to the default maturity."""
    try:
        with open(RELAY_DOWN_FILE) as f:
            parts = f.read().split()
            mature = float(parts[2]) if len(parts) >= 3 else float(DISCONNECT_MATURE_SEC)
            return float(parts[0]), float(parts[1]), mature
    except (OSError, ValueError, IndexError):
        return None, None, float(DISCONNECT_MATURE_SEC)


def _write_disc_state(first_bad, last_pass, mature_sec):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(RELAY_DOWN_FILE, 'w') as f:
            f.write(f'{first_bad} {last_pass} {mature_sec}')
    except OSError as e:
        log.warning('could not write relay-down state file: %s', e)


def _read_last_pass():
    """Timestamp of the last COMPLETED probe pass, or None."""
    try:
        with open(LAST_PASS_FILE) as f:
            return float(f.read().strip())
    except (OSError, ValueError):
        return None


def _write_last_pass(ts):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LAST_PASS_FILE, 'w') as f:
            f.write(str(ts))
    except OSError as e:
        log.warning('could not write last-pass file: %s', e)


def _clear_disc_state():
    try:
        os.remove(RELAY_DOWN_FILE)
    except OSError:
        pass


# ─── Laptop probe ─────────────────────────────────────────────────
def probe_laptop():
    """Run the PowerShell probe on the laptop over SSH.
    Returns dict {alive, relay, crashes} or None if the laptop is unreachable
    (asleep / off) — caller skips the pass on None (no false alerts)."""
    # UTF-16LE base64 → powershell -EncodedCommand: zero quoting headaches.
    enc = base64.b64encode(PROBE_PS.encode('utf-16-le')).decode('ascii')
    cmd = ['ssh'] + SSH_OPTS + [LAPTOP, 'powershell', '-NoProfile', '-EncodedCommand', enc]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        log.warning('probe timed out — laptop slow/asleep; skipping pass')
        return None
    if out.returncode != 0:
        log.warning('probe SSH failed (rc=%s) — laptop unreachable/asleep; skipping pass. stderr=%s',
                    out.returncode, (out.stderr or '').strip()[:200])
        return None
    line = next((l for l in out.stdout.splitlines() if l.startswith('PLW ')), None)
    if not line:
        log.warning('probe returned no PLW line; skipping pass. stdout=%s', (out.stdout or '').strip()[:200])
        return None
    try:
        kv = dict(part.split('=', 1) for part in line[4:].split())
        return {'alive': int(kv['alive']), 'relay': int(kv['relay']), 'crashes': int(kv['crashes'])}
    except (ValueError, KeyError) as e:
        log.warning('probe parse failed (%s): %r', e, line)
        return None


# ─── Main pass ────────────────────────────────────────────────────
def run():
    st = probe_laptop()
    if st is None:
        return  # laptop unreachable/asleep — leave alert state untouched

    conn = psycopg2.connect(**DB)
    conn.autocommit = False
    cur = conn.cursor()

    relay_txt = 'connected to relay' if st['relay'] else 'NOT connected to relay'
    now = time.time()
    # Did we just wake? A gap > SKIP_GAP_SEC since the last completed pass means a
    # pass was skipped in between (laptop asleep/unreachable) → Phone Link is in its
    # slow post-wake relay-reconnect window. Read BEFORE we overwrite the heartbeat.
    _prev_pass = _read_last_pass()
    just_woke  = _prev_pass is not None and (now - _prev_pass) > SKIP_GAP_SEC

    # 1. offline — process not running
    if not st['alive']:
        upsert_alert(cur, 'phonelink:offline', 'warn',
                     'Phone Link (Link to Windows) is not running on the laptop '
                     '(PhoneExperienceHost.exe down). Open Phone Link to relaunch; '
                     'if it crashes on launch see phonelink:crashloop.')
    else:
        resolve_alert(cur, 'phonelink:offline')

    # 2. crashloop — repeated faults (the Windows-update breakage signature)
    if st['crashes'] >= CRASH_THRESHOLD:
        upsert_alert(cur, 'phonelink:crashloop', 'warn',
                     f'Phone Link crash-looping: PhoneExperienceHost faulted {st["crashes"]} '
                     'times in 15 min (likely a Windows App Runtime / Store update broke it, '
                     'as on 2026-06-19). Fix: reset + re-register the YourPhone app, or reinstall.')
    else:
        resolve_alert(cur, 'phonelink:crashloop')

    # 3. disconnected — app running but NOT connected to the relay (can't send),
    #    sustained >= DISCONNECT_MATURE_SEC. Maturity tracked via a timestamp
    #    file (this process has no cross-run memory). Skipped when offline
    #    (alive=0) — phonelink:offline already covers a fully-down app.
    if st['alive'] and not st['relay']:
        first_bad, last_pass, mature = _read_disc_state()
        if first_bad is None or (last_pass and now - last_pass > SKIP_GAP_SEC):
            first_bad = now            # new episode (or restart after a skipped/asleep gap)
            # If this disconnect began right after a wake, give Phone Link extra time
            # to re-establish the relay before alarming. Baked into the episode's
            # maturity so the grace persists for the whole episode, not just this pass.
            mature = float(DISCONNECT_MATURE_SEC + (POST_WAKE_GRACE_SEC if just_woke else 0))
            if just_woke:
                log.info('disconnect started right after a wake (gap %ds) — extending '
                         'maturity to %ds (~%d min) for this episode',
                         int(now - _prev_pass), int(mature), int(mature // 60))
        _write_disc_state(first_bad, now, mature)
        down_for = now - first_bad
        if down_for >= mature:
            mins = int(down_for // 60)
            upsert_alert(cur, 'phonelink:disconnected', 'warn',
                         f'Phone Link is running but NOT connected to the Microsoft relay for '
                         f'~{mins} min — messages/pictures cannot send even though the app looks '
                         'open. Restart Phone Link (kill PhoneExperienceHost + relaunch); if that '
                         'does not restore it, reset + re-register the YourPhone / CrossDevice apps.')
        else:
            log.info('relay down %ds (< %ds maturity%s) — not alarming yet',
                     int(down_for), int(mature),
                     ' [post-wake grace]' if mature > DISCONNECT_MATURE_SEC else '')
    else:
        _clear_disc_state()
        resolve_alert(cur, 'phonelink:disconnected')

    # Heartbeat — record this completed pass so the NEXT pass can detect a skipped
    # pass (laptop asleep) in between. Written for every completed pass; only skips
    # (probe None, early-return above) leave a gap.
    _write_last_pass(now)

    conn.commit()
    cur.close()
    conn.close()
    log.info('Pass complete: alive=%s relay=%s crashes=%s (%s)',
             st['alive'], st['relay'], st['crashes'], relay_txt)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        log.exception('Watchdog pass failed')
        sys.exit(1)
