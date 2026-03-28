#!/usr/bin/env python3
import requests, psycopg2, pytz
from datetime import datetime
HA_URL = 'http://192.168.1.110:8123/api/states/'
HA_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkY2JjN2JkNWQ1MTc0NDFhYmJlN2UyNTBlNzE1MzVkZiIsImlhdCI6MTc3MzkzNzQ4OCwiZXhwIjoyMDg5Mjk3NDg4fQ.kTMwELeMkLUl4yk4VJ9yD8dq-G-FBYhHUEP352sLczc'
PG_CONF = {'host':'192.168.1.219', 'port':5432, 'dbname':'home_data', 'user':'postgres', 'password':'p2R3yT+x'}

SENSORS = {
    'boiler_temp': 'sensor.analog_temperature_from_digital',
    'panel_temp':  'sensor.collectors_temperature_enhanced',
    'valve_state': 'switch.boiler_valve_switch_switch_1'
}

def get_val(sid):
    try:
        r = requests.get(HA_URL + sid, headers={'Authorization': f'Bearer {HA_TOKEN}'}, timeout=5)
        data = r.json()
        v = data.get('state')
        if v in [None, 'unknown', 'unavailable']: return None
        if sid.startswith('switch.'): return v.lower() in ['on', 'open', 'true']
        return float(v)
    except: return None

if __name__ == "__main__":
    now = datetime.now(pytz.utc)
    row = {'ts': now}
    for k, sid in SENSORS.items():
        row[k] = get_val(sid)

    conn = psycopg2.connect(**PG_CONF)
    cur = conn.cursor()
    cur.execute(
        'INSERT INTO raw_data (ts, boiler_temp, panel_temp, valve_state) VALUES (%s,%s,%s,%s)',
        (row['ts'], row['boiler_temp'], row['panel_temp'], row['valve_state'])
    )
    cur.execute("INSERT INTO sync_signals (source) VALUES ('ha_to_pg')")
    conn.commit()
    print('Success! Inserted row:', row)
    cur.close()
    conn.close()
