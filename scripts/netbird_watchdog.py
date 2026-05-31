#!/usr/bin/env python3
"""
NetBird Tenant Watchdog — LXC 104

Runs every 5 min via cron. Polls the NetBird Management API and writes
alerts to system_alerts when:

  - A peer joins the tenant that isn't in netbird_tenant_settings.trusted_peers
    (tenant-level alert_new_peer must be true to fire)
  - A peer has been offline longer than its per-peer alert_offline_min
    (or the tenant default if the per-peer column is null)
  - A network route stops being announced (the routing peer count
    drops to zero, the route is disabled, or it disappears entirely
    between two polls — tenant-level alert_route_drop must be true)

Auto-resolves the alert when the underlying condition clears, same
pattern as group_health_watchdog.py.

Companion to:
  - GATEWAY agent index: NETBIRD/CLAUDE.md
  - Dashboard surface:   BOILER/dashboard/public/gateway.html
  - Backend endpoints:   /api/gateway/* in BOILER/dashboard/server.js
  - Identity overlay DB: netbird_peers_local (LXC 102)
  - Settings DB:         netbird_tenant_settings (LXC 102)
  - Alerts table:        system_alerts (LXC 102)

Source for the NETBIRD_API_TOKEN: /etc/netbird-watchdog.env (NOT
checked into git, same value as the dashboard's .env). The watchdog
fails loud if the token is missing — no point running otherwise.
"""

import json
import logging
import os
import sys
import urllib.error
import urllib.request

import psycopg2

log = logging.getLogger('netbird-watchdog')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)

# ─── Config ───────────────────────────────────────────────────────
DB = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}
NETBIRD_API_BASE   = 'https://api.netbird.io/api'
NETBIRD_TOKEN      = (os.environ.get('NETBIRD_API_TOKEN') or '').strip()
DEFAULT_OFFLINE_MIN_FALLBACK = 60   # used when neither per-peer nor tenant setting is configured


# ─── NetBird API helpers ──────────────────────────────────────────
def nb_get(path):
    """GET a NetBird API path; returns parsed JSON or raises on non-2xx."""
    req = urllib.request.Request(
        f'{NETBIRD_API_BASE}{path}',
        headers={
            'Authorization': f'Token {NETBIRD_TOKEN}',
            'Accept':        'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


# ─── system_alerts helpers ────────────────────────────────────────
def upsert_alert(cur, alert_type, severity, affected_agent, message):
    """Match the upsert pattern used by group_health_watchdog: keep one
    active alert per alert_type; on recurrence, refresh ts + message."""
    cur.execute(
        "SELECT id FROM system_alerts WHERE alert_type = %s AND resolved_at IS NULL",
        (alert_type,),
    )
    row = cur.fetchone()
    if row:
        cur.execute(
            "UPDATE system_alerts SET ts = NOW(), message = %s WHERE id = %s",
            (message, row[0]),
        )
    else:
        cur.execute(
            """INSERT INTO system_alerts
               (ts, source, severity, alert_type, affected_agent, message)
               VALUES (NOW(), %s, %s, %s, %s, %s)""",
            ('netbird_watchdog', severity, alert_type, affected_agent, message),
        )


def resolve_alert(cur, alert_type):
    """Mark any active alert with this alert_type as resolved."""
    cur.execute(
        "UPDATE system_alerts SET resolved_at = NOW() "
        "WHERE alert_type = %s AND resolved_at IS NULL",
        (alert_type,),
    )


def resolve_alerts_matching(cur, prefix, keep_keys):
    """For all active alerts whose alert_type starts with `prefix`, resolve
    those whose suffix is NOT in keep_keys. Used to clean up alerts for
    peers / routes that no longer match any active condition."""
    cur.execute(
        "SELECT id, alert_type FROM system_alerts "
        "WHERE alert_type LIKE %s AND resolved_at IS NULL",
        (prefix + '%',),
    )
    for alert_id, atype in cur.fetchall():
        suffix = atype[len(prefix):]
        if suffix not in keep_keys:
            cur.execute(
                "UPDATE system_alerts SET resolved_at = NOW() WHERE id = %s",
                (alert_id,),
            )


# ─── Main pass ────────────────────────────────────────────────────
def run():
    if not NETBIRD_TOKEN:
        log.error('NETBIRD_API_TOKEN not set — refusing to run without auth')
        sys.exit(2)

    try:
        peers = nb_get('/peers')
    except urllib.error.HTTPError as e:
        log.error('NetBird API peers fetch HTTP %s: %s', e.code, e.read()[:200])
        sys.exit(3)
    except Exception as e:
        log.error('NetBird API peers fetch failed: %s', e)
        sys.exit(3)

    try:
        networks = nb_get('/networks')
    except Exception as e:
        log.warning('NetBird API networks fetch failed (route-drop check will skip): %s', e)
        networks = None

    conn = psycopg2.connect(**DB)
    conn.autocommit = False
    cur = conn.cursor()

    # Tenant settings + per-peer overlay
    cur.execute(
        "SELECT alert_new_peer, alert_route_drop, trusted_peers "
        "FROM netbird_tenant_settings WHERE id = 1"
    )
    row = cur.fetchone() or (True, True, [])
    alert_new_peer, alert_route_drop, trusted_peers = row
    trusted_set = set(trusted_peers or [])

    cur.execute(
        "SELECT peer_id, alert_offline_min, user_name "
        "FROM netbird_peers_local"
    )
    overlay = {r[0]: {'alert_offline_min': r[1], 'user_name': r[2]} for r in cur.fetchall()}

    # ── 1. New-peer alerts ───────────────────────────────────────
    if alert_new_peer:
        for p in peers:
            pid = p.get('id')
            if not pid:
                continue
            if pid in trusted_set:
                resolve_alert(cur, f'netbird:new_peer:{pid}')
                continue
            label = p.get('name') or pid
            fqdn  = p.get('dns_label') or p.get('hostname') or ''
            ip    = p.get('ip') or ''
            upsert_alert(
                cur,
                f'netbird:new_peer:{pid}',
                'warn',
                'netbird',
                f'Untrusted peer in tenant: {label} ({fqdn}, NetBird IP {ip}). '
                'Add to trusted_peers in netbird_tenant_settings to silence.',
            )
        # Cleanup: resolve new_peer alerts for peers that vanished from the tenant
        live_pids = {p.get('id') for p in peers if p.get('id')}
        resolve_alerts_matching(cur, 'netbird:new_peer:', live_pids)
    else:
        # Toggle off → resolve everything previously raised
        cur.execute(
            "UPDATE system_alerts SET resolved_at = NOW() "
            "WHERE alert_type LIKE 'netbird:new_peer:%%' AND resolved_at IS NULL"
        )

    # ── 2. Peer-offline alerts ───────────────────────────────────
    import datetime
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    offline_keep = set()
    for p in peers:
        pid = p.get('id')
        if not pid:
            continue
        threshold_min = (overlay.get(pid) or {}).get('alert_offline_min')
        if threshold_min is None:
            # Tenant fallback isn't surfaced yet as a column; use a project default.
            threshold_min = DEFAULT_OFFLINE_MIN_FALLBACK
        if threshold_min <= 0:
            resolve_alert(cur, f'netbird:peer_offline:{pid}')
            continue
        if p.get('connected'):
            resolve_alert(cur, f'netbird:peer_offline:{pid}')
            continue
        ls_str = p.get('last_seen')
        if not ls_str:
            continue
        try:
            ls = datetime.datetime.fromisoformat(ls_str.replace('Z', '+00:00'))
        except ValueError:
            continue
        mins_offline = (now_utc - ls).total_seconds() / 60.0
        if mins_offline >= threshold_min:
            offline_keep.add(pid)
            user = (overlay.get(pid) or {}).get('user_name') or '?'
            label = p.get('name') or pid
            upsert_alert(
                cur,
                f'netbird:peer_offline:{pid}',
                'warn',
                'netbird',
                f'Peer {label} (user {user}) offline {int(mins_offline)} min '
                f'(threshold {int(threshold_min)} min).',
            )
        else:
            resolve_alert(cur, f'netbird:peer_offline:{pid}')

    # ── 3. Route-drop alerts ─────────────────────────────────────
    # A network is "down" when EITHER the routing_peers_count field on
    # /networks reads 0, OR /networks/<id>/routers returns no entries
    # with enabled=true. Cross-checking both guards against the API
    # silently renaming/removing routing_peers_count (which would
    # otherwise flip every network into a false-positive route_dropped
    # alert with the previous single-field check).
    if networks is not None and alert_route_drop:
        for n in networks:
            nid = n.get('id')
            if not nid:
                continue
            routing_peers_count = n.get('routing_peers_count')
            # Independent routers fetch — if it fails, fall back to the
            # field-only check rather than flipping false-positive.
            active_routers = None
            try:
                rts = nb_get(f'/networks/{nid}/routers')
                active_routers = sum(1 for r in (rts or []) if r.get('enabled', True))
            except Exception as e:
                log.warning(
                    'route-drop: /networks/%s/routers fetch failed (%s) — falling back to field-only check',
                    nid, e,
                )
            # Drop = both signals agree on "no active routers", OR one
            # signal says 0 and the other is unavailable. If signals
            # disagree (one says 0, other says >0), prefer the optimistic
            # reading (don't fire) to avoid false positives during API
            # races. NetBird settles within a few seconds typically.
            if active_routers is not None and routing_peers_count is not None:
                is_down = (active_routers == 0 and routing_peers_count == 0)
            elif active_routers is not None:
                is_down = (active_routers == 0)
            elif routing_peers_count is not None:
                is_down = (routing_peers_count == 0)
            else:
                # Neither signal available — skip; can't tell.
                is_down = False
            if is_down:
                upsert_alert(
                    cur,
                    f'netbird:route_dropped:{nid}',
                    'warn',
                    'netbird',
                    f'NetBird network "{n.get("name") or nid}" has no active routing peers — route is down.',
                )
            else:
                resolve_alert(cur, f'netbird:route_dropped:{nid}')
        # Cleanup: resolve route_dropped alerts for networks that vanished entirely.
        live_nids = {n.get('id') for n in networks if n.get('id')}
        resolve_alerts_matching(cur, 'netbird:route_dropped:', live_nids)
    elif networks is not None and not alert_route_drop:
        cur.execute(
            "UPDATE system_alerts SET resolved_at = NOW() "
            "WHERE alert_type LIKE 'netbird:route_dropped:%%' AND resolved_at IS NULL"
        )

    conn.commit()
    cur.close()
    conn.close()
    log.info(
        'Pass complete: %d peers, %d networks; offline_alerts=%d',
        len(peers), len(networks or []), len(offline_keep),
    )


if __name__ == '__main__':
    try:
        run()
    except Exception:
        log.exception('Watchdog pass failed')
        sys.exit(1)
