#!/opt/Agents-agent/venv/bin/python3
"""
Weather Collection Script — runs every hour via cron.
Collects IMS weather + balcony sensors from HA and stores in:
  raw_weather       — current conditions (hourly)
  raw_weather_daily — daily forecast entries (once per day at 06:00)
"""

import os
import sys
import logging
from datetime import datetime, date

import psycopg2
import requests
import pytz

# ── Config ────────────────────────────────────────────────────────────────────
TIMEZONE  = pytz.timezone('Asia/Jerusalem')
DB_CONFIG = {
    'host':     '192.168.1.219',
    'database': 'home_data',
    'user':     'postgres',
    'port':     5432,
}
HA_URL   = 'http://192.168.1.110:8123'
HA_TOKEN = os.environ.get('HA_TOKEN', '')

HA_HEADERS = {
    'Authorization': f'Bearer {HA_TOKEN}',
    'Content-Type':  'application/json',
}

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler('/var/log/collect-weather.log'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)

# ── HA helpers ────────────────────────────────────────────────────────────────
def ha_state(entity_id):
    r = requests.get(f'{HA_URL}/api/states/{entity_id}', headers=HA_HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()

def safe_float(val):
    try:
        f = float(val)
        return None if f < -900 else f   # IMS uses -999 for unavailable
    except (TypeError, ValueError):
        return None

def safe_int(val):
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return None

# ── Collect current conditions ─────────────────────────────────────────────
def collect_hourly(conn):
    log.info('Collecting hourly weather...')

    ims     = ha_state('weather.ims_weather')
    temp_s  = ha_state('sensor.balcony_motion_temperature')
    uv_s    = ha_state('sensor.balcony_motion_uv_index')
    illum_s = ha_state('sensor.balcony_motion_illuminance')
    hum_s   = ha_state('sensor.balcony_motion_humidity')

    a = ims.get('attributes', {})

    row = {
        'condition':           ims.get('state'),
        'temp_ims':            safe_float(a.get('temperature')),
        'humidity_ims':        safe_int(a.get('humidity')),
        'uv_index_ims':        safe_float(a.get('uv_index')),
        'wind_speed':          safe_float(a.get('wind_speed')),
        'uv_index_balcony':    safe_float(uv_s.get('state')),
        'temp_balcony':        safe_float(temp_s.get('state')),
        'illuminance_balcony': safe_int(illum_s.get('state')),
        'humidity_balcony':    safe_float(hum_s.get('state')),
    }

    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO raw_weather
              (condition, temp_ims, humidity_ims, uv_index_ims, wind_speed,
               uv_index_balcony, temp_balcony, illuminance_balcony, humidity_balcony)
            VALUES
              (%(condition)s, %(temp_ims)s, %(humidity_ims)s, %(uv_index_ims)s, %(wind_speed)s,
               %(uv_index_balcony)s, %(temp_balcony)s, %(illuminance_balcony)s, %(humidity_balcony)s)
        """, row)
    conn.commit()
    log.info(f"Hourly row inserted: {row['condition']} {row['temp_ims']}°C UV={row['uv_index_ims']}")

# ── Collect daily forecast (only at 06:00) ────────────────────────────────
def collect_daily(conn):
    now_il = datetime.now(TIMEZONE)
    if now_il.hour != 6:
        log.info(f'Skipping daily forecast (hour={now_il.hour}, only runs at 06:00)')
        return

    log.info('Collecting daily forecast...')

    # Use HA weather.get_forecasts service via REST API
    r = requests.post(
        f'{HA_URL}/api/services/weather/get_forecasts',
        headers=HA_HEADERS,
        json={'entity_id': 'weather.ims_weather', 'type': 'daily'},
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()

    # Response: list of service call results, first item has the forecast
    forecasts = []
    if isinstance(data, list) and data:
        forecasts = data[0].get('attributes', {}).get('forecast', [])
    elif isinstance(data, dict):
        forecasts = data.get('weather.ims_weather', {}).get('forecast', [])

    if not forecasts:
        log.warning('No daily forecast data returned from HA')
        return

    with conn.cursor() as cur:
        for entry in forecasts:
            fd = entry.get('datetime', '')[:10]   # "2026-03-27T00:00:00+00:00" → "2026-03-27"
            cur.execute("""
                INSERT INTO raw_weather_daily
                  (forecast_date, condition, temp_high, temp_low, precipitation_prob)
                VALUES (%s, %s, %s, %s, %s)
            """, (
                fd,
                entry.get('condition'),
                safe_float(entry.get('temperature')),
                safe_float(entry.get('templow')),
                safe_int(entry.get('precipitation_probability')),
            ))
    conn.commit()
    log.info(f'Daily forecast inserted: {len(forecasts)} entries')

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
    except Exception as e:
        log.error(f'DB connection failed: {e}')
        sys.exit(1)

    try:
        collect_hourly(conn)
        collect_daily(conn)
    except Exception as e:
        log.error(f'Collection error: {e}')
    finally:
        conn.close()

if __name__ == '__main__':
    main()
