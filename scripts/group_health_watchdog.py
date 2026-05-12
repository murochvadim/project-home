#!/usr/bin/env python3
"""
Group Freshness Watchdog — LXC 104

Runs every 5 min via cron. Detects when an entire integration group goes
silent while other groups are healthy — catches failures like HA sub-integration
stuck (SmartThings, Ring, Home Connect) or Zigbee2MQTT hanging.

Phase 1: alert-only (writes to system_alerts; does NOT auto-reload anything).
Phase 2 (future): add recovery actions per group.

The existing WS watchdog in the device-agent covers a different layer (the
WebSocket pipe from device-agent ↔ HA). This watchdog sits ABOVE that, looking
at whether actual devices in each group are producing events at expected cadence.
"""

import logging
import sys

import psycopg2

log = logging.getLogger('group-health')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)

DB = {
    'host': '192.168.1.219',
    'port': 5432,
    'database': 'home_data',
    'user': 'postgres',
}

# Per-group expected cadence. Each entry = ((protocol, last_source), config dict).
# `stale_min`: if freshest event > stale_min old AND other groups are fresh → alert.
# `min_devices`: skip if group has fewer devices (noise filter).
GROUPS = [
    # zwave/ha_api: all 13 SmartThings devices go silent together when integration dies
    (('zwave',   'ha_api'),      {'stale_min':  30, 'min_devices': 10, 'label': 'SmartThings zwave'}),
    # ring: doorbell + chime; rare events. Integration died = multi-day silence.
    (('ring',    'ha_api'),      {'stale_min': 720, 'min_devices':  2, 'label': 'Ring (HA)'}),
    # home_connect: BSH appliances. Mixed — Oven every 1 min, Washer every 3 hours.
    # Raising to 6h to avoid false positives on idle appliances.
    (('cloud',   'home_connect'), {'stale_min': 360, 'min_devices':  1, 'label': 'Home Connect (BSH)'}),
    # zigbee/mqtt: chatty when active; quiet houses can idle a few hours
    (('zigbee',  'zigbee'),      {'stale_min': 240, 'min_devices':  1, 'label': 'Zigbee2MQTT'}),
    # Tuya local TCP push: >20 devices, very chatty
    (('local',   'tcp_push'),    {'stale_min':  20, 'min_devices': 10, 'label': 'Tuya local TCP push'}),
    # Tuya local_poll: large group, every few min polling
    (('local',   'local_poll'),  {'stale_min':  30, 'min_devices': 10, 'label': 'Tuya local poll'}),
    # gateway (Tuya sub-devices): rare updates, long threshold
    (('gateway', 'cloud_poll'),  {'stale_min': 180, 'min_devices':  1, 'label': 'Tuya gateway'}),
    # cloud/cloud_poll: mixed — Bedroom Presence chatty, CO alarm + emerg light rare (>2h gaps normal).
    # 2 hours threshold accommodates the slowest normal reporter.
    (('cloud',   'cloud_poll'),  {'stale_min': 120, 'min_devices':  4, 'label': 'Tuya cloud poll'}),
]

OVERALL_FRESH_SEC = 600     # any group fresher than 10 min ⇒ network is fine
ALERT_SOURCE = 'group_health_watchdog'


def main():
    conn = psycopg2.connect(**DB)
    conn.autocommit = True
    cur = conn.cursor()

    # Collect freshness per group using devices.last_seen.
    # Rationale: last_seen updates on every successful poll (for polled protocols)
    # AND on every event arrival (for event-driven protocols). Using MAX(device_events.ts)
    # instead caused false positives on rare-reporter devices (CO alarm, emerg light)
    # that legitimately go hours between state changes while still being polled fine.
    cur.execute("""
        SELECT d.protocol, d.last_source,
               COUNT(d.id) AS devices,
               MAX(d.last_seen) AS freshest,
               EXTRACT(EPOCH FROM (NOW() - MAX(d.last_seen))) / 60 AS age_min
        FROM devices d
        WHERE d.enabled = TRUE AND d.protocol != 'virtual'
        GROUP BY d.protocol, d.last_source
    """)
    rows = cur.fetchall()
    group_map = {(p, s): {'devices': d, 'freshest': f, 'age_min': a}
                 for p, s, d, f, a in rows}

    # Overall health: is ANY group fresh in the last 10 min?
    any_fresh = any(
        g['age_min'] is not None and (g['age_min'] * 60) < OVERALL_FRESH_SEC
        for g in group_map.values()
    )
    if not any_fresh:
        log.warning('No groups fresh in last 10 min — likely a broader outage, skipping per-group checks')
        return

    # Per-group evaluation
    for (protocol, source), cfg in GROUPS:
        group = group_map.get((protocol, source))
        if not group:
            continue
        if group['devices'] < cfg['min_devices']:
            continue

        alert_key = f'group_stale:{protocol}:{source}'
        age = group['age_min']
        stuck = age is None or age > cfg['stale_min']

        if stuck:
            message = (
                f"{cfg['label']} ({protocol}/{source}): {group['devices']} devices silent "
                f"for {age:.0f} min" if age is not None else
                f"{cfg['label']} ({protocol}/{source}): {group['devices']} devices never emitted in 24h"
            )
            # Upsert: write unresolved alert only if one doesn't already exist for this key
            cur.execute("""
                SELECT id FROM system_alerts
                WHERE alert_type = %s AND resolved_at IS NULL
                ORDER BY ts DESC LIMIT 1
            """, (alert_key,))
            existing = cur.fetchone()
            if existing:
                log.info('Already alerting: %s (id=%s)', alert_key, existing[0])
            else:
                cur.execute("""
                    INSERT INTO system_alerts
                        (ts, source, severity, alert_type, affected_agent, message)
                    VALUES (NOW(), %s, 'warn', %s, 'device_agent', %s)
                """, (ALERT_SOURCE, alert_key, message))
                log.warning('RAISED: %s — %s', alert_key, message)
        else:
            # Group healthy — auto-resolve any active alert for this key
            cur.execute("""
                UPDATE system_alerts
                SET resolved_at = NOW()
                WHERE alert_type = %s AND resolved_at IS NULL
            """, (alert_key,))
            if cur.rowcount > 0:
                log.info('RESOLVED: %s (age=%s min, threshold=%s)', alert_key, f'{age:.0f}', cfg['stale_min'])

    # Per-device network reachability checks (separate alert family: network:*).
    check_network_reachability(cur)

    cur.close()
    conn.close()


# ────────────────────────────────────────────────────────────────────────────
# Network-Integration checks (alert family: network:*)
#
# These are PER-DEVICE checks — different from the GROUP checks above which
# fire when an entire integration cohort goes silent. They surface "this one
# device is misbehaving on the LAN" cases that don't move the group needle.
# Renders on Project Network page → System Alerts card and the sidebar's
# "Network Integration" badge.
# ────────────────────────────────────────────────────────────────────────────

# A `protocol='local'` device should have its freshness come from the local
# stack. If `last_source` flips to a cloud channel and stays there, the local
# TCP / push is broken — the device is "online" only via the cloud, which
# masks the failure for HA but breaks rule-engine latency and local-control
# reliability. This is what bit us with the Kitchen Proximity Switch on
# 2026-05-11 — it sat for weeks on a different network, controllable via
# cloud, completely invisible to local checks.
#
# `protocol='gateway'` is EXCLUDED: Tuya sub-devices behind a Tuya WiFi
# gateway (Audible Alarms, Boidem Light, Tami 4, Guy Room Curtain) have no
# direct local TCP path — `cloud_poll` is their normal state, not drift.
# Only top-level `local` protocol devices have a direct local TCP socket
# we expect to use, so only they are candidates for this drift alert.
_LOCAL_PROTOCOLS = ('local',)
# `keepalive` is the normal source for IR remotes (no DPS to poll) and for
# BSH SSE KEEP-ALIVE heartbeats — it's the heartbeat working, not drift.
# `initial` is the boot-time source before any real read lands.
_LOCAL_SOURCES   = ('local_poll', 'tcp_push', 'gateway_push', 'initial', 'keepalive')
# Treat very-fresh devices (under 6 h since last_seen) as transient drift —
# only raise after 6 h continuously cloud-only AND last_seen is via cloud.
_CLOUD_DRIFT_MIN_AGE_H = 6
# Devices known to be cloud-by-design (no local path at all). Skip them — they
# legitimately live in ha_api / cloud_poll and aren't a "drift" case.
_CLOUD_BY_DESIGN_PROTOCOLS = ('cloud', 'zwave', 'ring', 'zigbee', 'esp', 'awtrix',
                              'hasp', 'pixoo', 'alexa', 'vacuum', 'virtual',
                              'home_connect', 'mqtt', 'homekit')


def check_network_reachability(cur):
    # 1) network:device_cloud_only — local/gateway devices whose freshness is
    #    coming via cloud instead of local stack. Requires the alert state to
    #    have persisted ≥ 6 h to avoid flapping on transient reboots.
    cur.execute("""
        SELECT d.id, d.name, d.protocol, d.last_source,
               EXTRACT(EPOCH FROM (NOW() - d.last_seen)) / 3600 AS hours_since_seen,
               d.last_seen
        FROM devices d
        WHERE d.enabled = TRUE
          AND d.protocol = ANY(%s)
          AND (d.last_source IS NULL OR d.last_source NOT IN %s)
    """, (list(_LOCAL_PROTOCOLS), _LOCAL_SOURCES))
    candidates = cur.fetchall()
    drift_seen = set()
    for dev_id, name, protocol, last_source, hours, last_seen in candidates:
        alert_key = f'network:device_cloud_only:{dev_id}'
        # First time we observe a device in the drifted state, just record the
        # alert (resolved=NULL) so we can measure how long it's been. Subsequent
        # ticks just leave it alone. We use the existing alert's ts as the
        # "first detected" anchor — only re-raise / leave-be after threshold.
        cur.execute("""
            SELECT id, ts, resolved_at,
                   EXTRACT(EPOCH FROM (NOW() - ts)) / 3600 AS hours_open
            FROM system_alerts
            WHERE alert_type = %s
            ORDER BY ts DESC LIMIT 1
        """, (alert_key,))
        existing = cur.fetchone()
        message = (
            f"{name}: protocol='{protocol}' but last_source='{last_source}' — "
            f"local TCP / push channel broken, device only reachable via cloud. "
            f"last_seen={hours:.1f} h ago. "
            f"Action: check WiFi, factory-reset + re-pair on home network."
        ) if hours is not None else (
            f"{name}: protocol='{protocol}' but last_source='{last_source}' — "
            f"local TCP / push channel broken; never seen since last restart."
        )
        if existing is None:
            # First detection — insert pending (no alert raised yet; will mature
            # after threshold). Severity = 'info' acts as a quiet marker.
            cur.execute("""
                INSERT INTO system_alerts
                    (ts, source, severity, alert_type, affected_agent, message)
                VALUES (NOW(), %s, 'info', %s, 'device_agent', %s)
            """, (ALERT_SOURCE, alert_key, '[pending drift detection] ' + message))
            log.info('PENDING: %s — observed cloud-only state, will mature after %sh',
                     alert_key, _CLOUD_DRIFT_MIN_AGE_H)
        else:
            alert_id, _ts, resolved_at, hours_open = existing
            if resolved_at is not None:
                # Was resolved; device drifted again. Re-open with fresh ts.
                cur.execute("""
                    UPDATE system_alerts SET resolved_at = NULL, ts = NOW(),
                           severity = 'info', message = %s
                    WHERE id = %s
                """, ('[pending drift detection] ' + message, alert_id))
                log.info('RE-PENDING: %s (previously resolved)', alert_key)
            elif hours_open is not None and hours_open >= _CLOUD_DRIFT_MIN_AGE_H:
                # Has been pending for the threshold — promote to warn-level.
                # Update message with current hours_since_seen too.
                cur.execute("""
                    UPDATE system_alerts SET severity = 'warn', message = %s
                    WHERE id = %s AND severity != 'warn'
                """, (message, alert_id))
                if cur.rowcount > 0:
                    log.warning('RAISED: %s — drifted for %.1f h', alert_key, hours_open)
            # else: keep waiting (info-level until threshold)
        drift_seen.add(alert_key)

    # Auto-resolve any drift alerts for devices that returned to local source.
    cur.execute("""
        SELECT id, alert_type FROM system_alerts
        WHERE alert_type LIKE 'network:device_cloud_only:%' AND resolved_at IS NULL
    """)
    for alert_id, alert_type in cur.fetchall():
        if alert_type not in drift_seen:
            cur.execute("UPDATE system_alerts SET resolved_at = NOW() WHERE id = %s", (alert_id,))
            log.info('RESOLVED: %s — device returned to local source', alert_type)

    # 2) network:lan_silent — known device MAC missing from net_devices for > 7 days.
    #    Detects devices that quietly fell off the LAN entirely (powered off,
    #    moved to a different network, hardware failure). Excludes cloud-by-design
    #    devices that don't have a local LAN identity.
    cur.execute("""
        SELECT d.id, d.name, d.mac::text, n.last_seen,
               EXTRACT(EPOCH FROM (NOW() - n.last_seen)) / 86400 AS days_silent
        FROM devices d
        LEFT JOIN net_devices n ON LOWER(n.mac::text) = LOWER(d.mac::text)
        WHERE d.enabled = TRUE
          AND d.mac IS NOT NULL
          AND d.protocol != ALL(%s)
          AND (n.last_seen IS NULL OR n.last_seen < NOW() - INTERVAL '7 days')
    """, (list(_CLOUD_BY_DESIGN_PROTOCOLS),))
    silent_seen = set()
    for dev_id, name, mac, last_seen, days in cur.fetchall():
        alert_key = f'network:lan_silent:{dev_id}'
        silent_seen.add(alert_key)
        message = (
            f"{name} (MAC {mac}): not seen on LAN for {days:.0f} days. "
            f"Action: power-cycle device, or check WiFi pairing."
        ) if days is not None else (
            f"{name} (MAC {mac}): never seen on LAN. "
            f"Action: device may have a different MAC after factory reset; verify."
        )
        cur.execute("""
            SELECT id FROM system_alerts
            WHERE alert_type = %s AND resolved_at IS NULL
            ORDER BY ts DESC LIMIT 1
        """, (alert_key,))
        if cur.fetchone() is None:
            cur.execute("""
                INSERT INTO system_alerts
                    (ts, source, severity, alert_type, affected_agent, message)
                VALUES (NOW(), %s, 'warn', %s, 'network', %s)
            """, (ALERT_SOURCE, alert_key, message))
            log.warning('RAISED: %s — %s', alert_key, message)

    cur.execute("""
        SELECT id, alert_type FROM system_alerts
        WHERE alert_type LIKE 'network:lan_silent:%' AND resolved_at IS NULL
    """)
    for alert_id, alert_type in cur.fetchall():
        if alert_type not in silent_seen:
            cur.execute("UPDATE system_alerts SET resolved_at = NOW() WHERE id = %s", (alert_id,))
            log.info('RESOLVED: %s — MAC returned to LAN', alert_type)

    # 3) network:stale_local — device row claims a local last_source but the
    #    channel hasn't actually delivered anything in > 6 h. Catches the case
    #    where last_source is stuck on local_poll/tcp_push/gateway_push from
    #    long ago but the connection is silently dead now. Distinct from
    #    `device_cloud_only` because the source HASN'T flipped to cloud —
    #    it's just frozen. Example: Pentagon light (last_source=local_poll,
    #    last_seen=26h ago) — looks fine to drift-check but is dead.
    cur.execute("""
        SELECT d.id, d.name, d.protocol, d.last_source,
               EXTRACT(EPOCH FROM (NOW() - d.last_seen)) / 3600 AS hours_stale
        FROM devices d
        WHERE d.enabled = TRUE
          AND d.protocol = 'local'
          AND d.last_source IN ('local_poll','tcp_push','gateway_push')
          AND d.last_seen < NOW() - INTERVAL '6 hours'
    """)
    stale_seen = set()
    for dev_id, name, protocol, last_source, hours in cur.fetchall():
        alert_key = f'network:stale_local:{dev_id}'
        stale_seen.add(alert_key)
        message = (
            f"{name}: claims last_source='{last_source}' but no fresh reading "
            f"in {hours:.0f} h. Local channel is frozen — re-pair WiFi, check "
            f"power, or factory-reset."
        )
        cur.execute("""
            SELECT id FROM system_alerts
            WHERE alert_type = %s AND resolved_at IS NULL
            ORDER BY ts DESC LIMIT 1
        """, (alert_key,))
        if cur.fetchone() is None:
            cur.execute("""
                INSERT INTO system_alerts
                    (ts, source, severity, alert_type, affected_agent, message)
                VALUES (NOW(), %s, 'warn', %s, 'network', %s)
            """, (ALERT_SOURCE, alert_key, message))
            log.warning('RAISED: %s — %s', alert_key, message)
    cur.execute("""
        SELECT id, alert_type FROM system_alerts
        WHERE alert_type LIKE 'network:stale_local:%' AND resolved_at IS NULL
    """)
    for alert_id, alert_type in cur.fetchall():
        if alert_type not in stale_seen:
            cur.execute("UPDATE system_alerts SET resolved_at = NOW() WHERE id = %s", (alert_id,))
            log.info('RESOLVED: %s — fresh reading received', alert_type)

    # 4) network:ip_collision — two distinct MACs BOTH seen within the last
    #    10 minutes at the same IP. Distinct from DHCP-reassignment churn
    #    (where the previous occupant stops responding within seconds of
    #    losing its lease) — here we genuinely observe two device radios
    #    answering for the same IP simultaneously. Symptoms: dropped commands,
    #    cross-talk, ARP cache thrash.
    #
    #    Keyed by IP (not by MAC) — one alert per colliding IP regardless of
    #    how many MACs collide. Message lists every MAC involved.
    cur.execute("""
        WITH fresh AS (
            SELECT ip, mac::text AS mac,
                   EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS sec_ago
            FROM net_devices
            WHERE last_seen > NOW() - INTERVAL '10 minutes'
        )
        SELECT ip::text AS ip,
               STRING_AGG(mac || ' (' || sec_ago || 's ago)', ', '
                          ORDER BY sec_ago) AS mac_list
        FROM fresh
        GROUP BY ip
        HAVING COUNT(*) > 1
    """)
    collision_seen = set()
    for ip, mac_list in cur.fetchall():
        # IP can have ':' in IPv6; we only deal with IPv4 here but normalize to
        # safe alert-key chars anyway.
        ip_key = ip.replace(':', '_')
        alert_key = f'network:ip_collision:{ip_key}'
        collision_seen.add(alert_key)
        message = (
            f"IP {ip}: {mac_list}. Multiple devices answering simultaneously — "
            f"will cause command drops + cross-talk. Action: identify which "
            f"device should hold the IP, factory-reset the loser to force a "
            f"new DHCP lease."
        )
        cur.execute("""
            SELECT id FROM system_alerts
            WHERE alert_type = %s AND resolved_at IS NULL
            ORDER BY ts DESC LIMIT 1
        """, (alert_key,))
        if cur.fetchone() is None:
            cur.execute("""
                INSERT INTO system_alerts
                    (ts, source, severity, alert_type, affected_agent, message)
                VALUES (NOW(), %s, 'warn', %s, 'network', %s)
            """, (ALERT_SOURCE, alert_key, message))
            log.warning('RAISED: %s — %s', alert_key, message)
    cur.execute("""
        SELECT id, alert_type FROM system_alerts
        WHERE alert_type LIKE 'network:ip_collision:%' AND resolved_at IS NULL
    """)
    for alert_id, alert_type in cur.fetchall():
        if alert_type not in collision_seen:
            cur.execute("UPDATE system_alerts SET resolved_at = NOW() WHERE id = %s", (alert_id,))
            log.info('RESOLVED: %s — collision cleared', alert_type)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log.exception('group-health watchdog failed: %s', e)
        sys.exit(1)
