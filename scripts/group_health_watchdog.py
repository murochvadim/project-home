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

    cur.close()
    conn.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log.exception('group-health watchdog failed: %s', e)
        sys.exit(1)
