#!/usr/bin/env python3
import os
import requests, psycopg2, pytz
from datetime import datetime
HA_URL   = 'http://192.168.1.110:8123/api/states/'
HA_TOKEN = os.environ.get('HA_TOKEN', '')
PG_CONF  = {'host': '192.168.1.219', 'port': 5432, 'dbname': 'home_data',
            'user': 'postgres', 'password': os.environ.get('DB_PASS', '')}

SENSORS = {
    'boiler_temp': 'sensor.analog_temperature_from_digital',
    'panel_temp':  'sensor.collectors_temperature_enhanced',
    'valve_state': 'switch.boiler_valve_switch_switch_1'
}

def get_val(sid):
    try:
        r = requests.get(HA_URL + sid, headers={'Authorization': f'Bearer {HA_TOKEN}'}, timeout=5)
        r.raise_for_status()
        data = r.json()
        v = data.get('state')
        if v in [None, 'unknown', 'unavailable']: return None
        if sid.startswith('switch.'): return v.lower() in ['on', 'open', 'true']
        return float(v)
    except Exception as e:
        logging.getLogger(__name__).warning(f'get_val({sid}): {e}')
        return None

if __name__ == "__main__":
    import logging, sys
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    log = logging.getLogger(__name__)

    if not HA_TOKEN:
        log.error('HA_TOKEN not set — check /etc/environment')
        sys.exit(1)

    now = datetime.now(pytz.utc)
    row = {'ts': now}
    for k, sid in SENSORS.items():
        row[k] = get_val(sid)

    # Don't insert or wake boiler agent if critical sensors are missing
    if row['boiler_temp'] is None and row['panel_temp'] is None:
        log.warning(f'Both temperatures are None — skipping insert: {row}')
        sys.exit(0)

    try:
        with psycopg2.connect(**PG_CONF) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'INSERT INTO raw_data (ts, boiler_temp, panel_temp, valve_state) VALUES (%s,%s,%s,%s)',
                    (row['ts'], row['boiler_temp'], row['panel_temp'], row['valve_state'])
                )
                cur.execute("INSERT INTO sync_signals (source) VALUES ('ha_to_pg')")
            conn.commit()
        log.info(f'Inserted row: {row}')
    except Exception as e:
        log.error(f'DB insert failed: {e}')
        sys.exit(1)
