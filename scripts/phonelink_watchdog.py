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
import subprocess
import sys

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
