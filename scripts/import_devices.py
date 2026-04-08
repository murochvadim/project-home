#!/usr/bin/env python3
"""
Import Tuya devices from devices.json into the devices DB table.
Run on LXC 104 after tinytuya wizard.

Usage:
  python3 import_devices.py [--devices /path/to/devices.json] [--dry-run]
"""

import json
import os
import sys
import argparse
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timezone

DEVICES_JSON = '/opt/device-agent/devices.json'

DB = {
    'host':     '192.168.1.219',
    'port':     5432,
    'database': 'home_data',
    'user':     'postgres',
}

# Tuya category code → (device_type, default protocol)
CATEGORY_MAP = {
    'hps':   ('presence',        'local'),
    'kg':    ('switch',          'local'),
    'clkg':  ('switch',          'local'),
    'dlq':   ('switch',          'local'),
    'cjkg':  ('switch',          'gateway'),
    'tdq':   ('circuit_breaker', 'local'),
    'cz':    ('water_heater',    'local'),
    'cl':    ('curtain',         'gateway'),
    'dj':    ('light',           'local'),
    'dd':    ('light',           'local'),
    'sgbj':  ('siren',           'gateway'),
    'mcs':   ('door_sensor',     'local'),
    'sj':    ('water_sensor',    'cloud'),
    'cobj':  ('co_alarm',        'cloud'),
    'rqbj':  ('gas_detector',    'local'),
    'sfkzq': ('valve',           'gateway'),
    'wnykq': ('remote',          'local'),
    'wxkg':  ('wireless_switch', 'gateway'),
    'wg2':   ('gateway',         'local'),
    'rs':    ('temp_controller', 'local'),
    'qt':    ('scene',           'cloud'),
}

# qt scenes and remotes don't need polling
NO_POLL = {'scene', 'remote', 'gateway'}


def parse_room(name: str) -> str:
    """Best-effort room extraction from device name."""
    keywords = [
        'bedroom', 'living', 'kitchen', 'bathroom', 'hallway', 'corridor',
        'balcony', 'entrance', 'dining', 'sallon', 'salon', 'guy', 'tami',
        'garden', 'office', 'garage', 'laundry',
    ]
    lower = name.lower()
    for kw in keywords:
        if kw in lower:
            return kw.title()
    return ''


def import_devices(devices_path: str, dry_run: bool):
    with open(devices_path) as f:
        raw = json.load(f)

    if isinstance(raw, dict):
        # wizard sometimes wraps in {result: [...]}
        devices = raw.get('result', raw.get('devices', []))
    else:
        devices = raw

    print(f'Loaded {len(devices)} devices from {devices_path}')

    conn = psycopg2.connect(**DB)
    cur = conn.cursor(cursor_factory=RealDictCursor)

    inserted = updated = skipped = 0

    for dev in devices:
        dev_id = dev.get('id') or dev.get('devId')
        if not dev_id:
            print(f'  SKIP — no id: {dev.get("name")}')
            skipped += 1
            continue

        name         = dev.get('name', 'Unknown')
        category     = dev.get('category', '')
        local_ip     = dev.get('ip') or None
        local_key    = dev.get('key') or None
        version      = str(dev.get('version', '')) or None
        product_name = dev.get('product_name', '')
        gateway_id   = dev.get('parent_id') or None
        is_sub       = dev.get('sub', False)

        device_type, protocol = CATEGORY_MAP.get(category, ('unknown', 'local'))

        # Override protocol based on actual data
        if local_ip:
            protocol = 'local' if device_type != 'gateway' else 'local'
        elif is_sub or gateway_id:
            protocol = 'gateway'
        elif not local_ip and device_type not in ('scene',):
            protocol = 'cloud'

        room         = parse_room(name)
        poll_enabled = device_type not in NO_POLL

        if dry_run:
            print(f'  DRY  {dev_id[:20]:20} | {name[:30]:30} | {device_type:15} | {protocol:8} | ip={local_ip} | room={room}')
            continue

        cur.execute('SELECT id FROM devices WHERE id = %s', (dev_id,))
        exists = cur.fetchone()

        if exists:
            cur.execute('''
                UPDATE devices SET
                  name=%(name)s, category=%(category)s, device_type=%(device_type)s,
                  protocol=%(protocol)s, local_ip=%(local_ip)s, local_key=%(local_key)s,
                  gateway_id=%(gateway_id)s, version=%(version)s, product_name=%(product_name)s,
                  room=COALESCE(NULLIF(room,''), %(room)s),
                  updated_at=NOW()
                WHERE id=%(id)s
            ''', {
                'id': dev_id, 'name': name, 'category': category,
                'device_type': device_type, 'protocol': protocol,
                'local_ip': local_ip, 'local_key': local_key,
                'gateway_id': gateway_id, 'version': version,
                'product_name': product_name, 'room': room,
            })
            updated += 1
        else:
            cur.execute('''
                INSERT INTO devices
                  (id, name, vendor, category, device_type, protocol,
                   local_ip, local_key, gateway_id, version, product_name,
                   room, poll_enabled)
                VALUES
                  (%(id)s, %(name)s, 'tuya', %(category)s, %(device_type)s, %(protocol)s,
                   %(local_ip)s, %(local_key)s, %(gateway_id)s, %(version)s, %(product_name)s,
                   %(room)s, %(poll_enabled)s)
            ''', {
                'id': dev_id, 'name': name, 'category': category,
                'device_type': device_type, 'protocol': protocol,
                'local_ip': local_ip, 'local_key': local_key,
                'gateway_id': gateway_id, 'version': version,
                'product_name': product_name, 'room': room,
                'poll_enabled': poll_enabled,
            })
            inserted += 1

    if not dry_run:
        conn.commit()
        print(f'\nDone — inserted: {inserted}, updated: {updated}, skipped: {skipped}')
    else:
        print(f'\nDry run — would insert/update {len(devices) - skipped} devices')

    cur.close()
    conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--devices', default=DEVICES_JSON)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    import_devices(args.devices, args.dry_run)
