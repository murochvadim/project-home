#!/usr/bin/env python3
"""TUYA_LOCAL Phase 1 — derive dps_config.<ch>.dps_on/dps_off recipes for local
Tuya switch-like devices so on/off can dispatch locally (no cloud).

DRY-RUN by default: prints the full proposal (AUTO recipes + the MANUAL list) and
writes NOTHING. Pass --commit to write the AUTO recipes only (merged into each
device's existing dps_config; never touches cloud_authoritative_dps or the MANUAL
devices). Idempotent — channels that already have a recipe are left as-is.

Run on LXC 104 (has psycopg2 + DB trust to LXC 102):
  python3 tuya_local_phase1_derive.py            # dry-run
  python3 tuya_local_phase1_derive.py --commit   # write AUTO
"""
import sys
import json
import psycopg2
import psycopg2.extras

DB = dict(host='192.168.1.219', dbname='home_data', user='postgres', password='')

SWITCH_TYPES = ('switch', 'light', 'circuit_breaker', 'water_heater')

# Safety-critical / special devices — never auto-write; a human confirms the DPS.
FORCE_MANUAL = {'8 Gang Switch', 'Boiler Valve', 'Boiler Switch'}
# Already controlled another way — leave entirely.
SKIP_DEVICES = {'My Bathroom Color'}
# Multi-gang channels that are NOT plain relays (countdown/scene/mode/cloud).
SKIP_CHANNELS = {'7', '8'}
# Single-channel config datapoint that rides alongside the real DPS 1.
CONFIG_DECOY_DPS = {'41'}


def bool_keys(last_state):
    return {k for k, v in (last_state or {}).items() if isinstance(v, bool)}


def existing_recipe_channels(dps_config):
    out = set()
    for ch, cfg in (dps_config or {}).items():
        if isinstance(cfg, dict) and isinstance(cfg.get('dps_on'), dict):
            out.add(ch)
    return out


def derive(dev):
    """Return (auto, manual, done) where
       auto = {channel: {'dps_on':{k:True}, 'dps_off':{k:False}}},
       manual = [reason strings], done = [channels already having a recipe]."""
    name = dev['name']
    dt = dev['device_type']
    cc = dev['channel_config'] or {}
    ls = dev['last_state'] or {}
    dcfg = dev['dps_config'] or {}
    cloud_auth = set(dcfg.get('cloud_authoritative_dps') or [])
    bks = bool_keys(ls)
    done = existing_recipe_channels(dcfg)

    if name in SKIP_DEVICES:
        return {}, ['SKIP: controlled via HA, leave as-is'], list(done)
    if name in FORCE_MANUAL:
        return {}, ['FORCED MANUAL: safety-critical / special — confirm DPS by hand'], list(done)

    auto, manual = {}, []

    if cc:  # multi-gang
        for ch in sorted(cc.keys()):
            if ch in done:
                continue
            if ch in cloud_auth:
                manual.append(f'ch{ch}: cloud-authoritative — keep on cloud')
                continue
            if ch in SKIP_CHANNELS:
                manual.append(f'ch{ch}: skip (7/8 = countdown/scene/mode, not a relay)')
                continue
            if ch in bks:
                auto[ch] = {'dps_on': {ch: True}, 'dps_off': {ch: False}}
            else:
                manual.append(f'ch{ch}: not a boolean DPS in last_state (bool={sorted(bks)})')
    else:  # single-channel
        if 'power' in done:
            pass
        elif dt == 'light':
            if '20' in bks and '1' in bks:
                manual.append(f'light: DPS 1 AND 20 both boolean — test which toggles the bulb')
            elif '20' in bks:
                auto['power'] = {'dps_on': {'20': True}, 'dps_off': {'20': False}}
            elif '1' in bks:
                auto['power'] = {'dps_on': {'1': True}, 'dps_off': {'1': False}}
            else:
                manual.append(f'light: no DPS 1/20 boolean (bool={sorted(bks)})')
        else:
            if '1' in bks:
                others = bks - CONFIG_DECOY_DPS - cloud_auth - {'1'}
                if others:
                    manual.append(f'multiple booleans besides DPS 1: {sorted(others)} — verify')
                else:
                    auto['power'] = {'dps_on': {'1': True}, 'dps_off': {'1': False}}
            else:
                manual.append(f'no DPS 1 boolean (bool={sorted(bks)})')

    return auto, manual, list(done)


def main():
    commit = '--commit' in sys.argv
    conn = psycopg2.connect(**DB)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """SELECT id, name, device_type, channel_config, last_state, dps_config
           FROM devices
           WHERE protocol='local' AND device_type IN %s AND enabled IS NOT FALSE
           ORDER BY (channel_config <> '{}'::jsonb) DESC, name""",
        (SWITCH_TYPES,),
    )
    rows = cur.fetchall()

    auto_devs, manual_devs, done_devs = [], [], []
    writes = []  # (id, name, new_dps_config)

    for dev in rows:
        auto, manual, done = derive(dev)
        if auto:
            merged = dict(dev['dps_config'] or {})
            for ch, recipe in auto.items():
                base = dict(merged.get(ch) or {})
                base.update(recipe)
                merged[ch] = base
            writes.append((dev['id'], dev['name'], merged))
            auto_devs.append((dev['name'], auto, manual))
        elif manual:
            manual_devs.append((dev['name'], manual))
        if done and not auto:
            done_devs.append((dev['name'], done))

    print('=' * 72)
    print(f'TUYA_LOCAL Phase 1 derivation  ({len(rows)} switch-like local devices)')
    print(f'mode: {"COMMIT (writing AUTO)" if commit else "DRY-RUN (no writes)"}')
    print('=' * 72)

    print(f'\n--- AUTO ({len(auto_devs)} devices) — will get a recipe ---')
    for name, auto, manual in auto_devs:
        parts = ', '.join(f'{ch}->{list(r["dps_on"].keys())[0]}' for ch, r in sorted(auto.items()))
        extra = f'   [+ manual: {"; ".join(manual)}]' if manual else ''
        print(f'  {name:34s}  {parts}{extra}')

    print(f'\n--- MANUAL ({len(manual_devs)} devices) — NOT written, confirm by hand ---')
    for name, manual in manual_devs:
        print(f'  {name:34s}  {"; ".join(manual)}')

    if done_devs:
        print(f'\n--- ALREADY DONE ({len(done_devs)}) ---')
        for name, done in done_devs:
            print(f'  {name:34s}  channels {done}')

    if commit:
        for dev_id, name, merged in writes:
            cur.execute('UPDATE devices SET dps_config=%s WHERE id=%s',
                        (json.dumps(merged), dev_id))
        conn.commit()
        print(f'\nCOMMITTED {len(writes)} device recipes.')
    else:
        print(f'\nDRY-RUN — nothing written. {len(writes)} devices would get recipes.')
        print('Re-run with --commit to write the AUTO recipes.')

    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
