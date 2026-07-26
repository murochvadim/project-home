#!/usr/bin/env python3
"""
Panel Service — LXC 100 (192.168.1.138), port 8771.

Serves the Balcony Smart Tablet PWA so the wall panel works WITHOUT the laptop
dashboard being on (the dashboard is firewall-blocked on the LAN and may be off).
Mirrors bobo_game_service.py exactly — same host, same venv, same env, same
Cache-Control discipline.

Endpoints:
  GET  /                     -> the PWA shell (panel/index.html)
  GET  /<path>               -> PWA static (panel.js/css, manifest, mqtt.min.js)
  GET  /health               -> liveness
  GET  /api/panel/config     -> {value: <dashboard_settings.panel>} — pages+tiles+bindings
  GET  /api/panel/pass       -> {value: MQTT_BROWSER_PASS} — dashboard_browser WS pass

The tablet reads config (what tiles to render), subscribes to
`mur/home/device/+/state` for live tile state, and PUBLISHES a tile press to
`mur/home/device/panel/event {dps:{tile:<id>}}`. It NEVER issues raw device
commands — the `Panel Commands` rule (LXC 105) resolves tile->binding server-side.
So this service is read-only (config + pass); all writes are the browser's single
narrow MQTT publish. No command endpoint here on purpose (logic lives on the LXC).

Runs as systemd service panel-service.service. Env from /etc/environment:
DB_PASS + MQTT_BROWSER_PASS (same file bobo-game uses).
"""
import os, logging
from pathlib import Path
import psycopg2, psycopg2.extras, psycopg2.pool
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

PORT        = 8771
STATIC_DIR  = str(Path(__file__).resolve().parent / 'panel')
DB_HOST     = '192.168.1.219'
DB_NAME     = 'home_data'
DB_USER     = 'postgres'
DB_PASS     = os.environ.get('DB_PASS', '')
CONFIG_KEY  = 'panel'
MQTT_BROWSER_PASS = os.environ.get('MQTT_BROWSER_PASS', '')

# ── DB pool (same pattern as bobo_game_service.py / player_service.py) ──
_pool = None
def _get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            1, 4, host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS,
        )
    return _pool

def q(sql, params=None, fetch='all'):
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or ())
            row = None
            if fetch == 'all':
                row = cur.fetchall()
            elif fetch == 'one':
                row = cur.fetchone()
            conn.commit()
            return row
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)

def _err(e):
    log.exception('panel-service error')
    return jsonify({'error': str(e)}), 500

# ── static (the PWA) ───────────────────────────────────────────────
def _nocache(resp):
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/')
def index():
    return _nocache(send_from_directory(STATIC_DIR, 'index.html'))

@app.route('/<path:fn>')
def static_file(fn):
    return _nocache(send_from_directory(STATIC_DIR, fn))

# ── data endpoints ─────────────────────────────────────────────────
@app.route('/health')
def health():
    return jsonify({'ok': True, 'service': 'panel-service', 'port': PORT})

@app.route('/api/panel/config')
def config_get():
    # The full panel config (pages -> tiles -> bindings). The tablet renders tiles
    # from labels and subscribes to each binding's device state for live on/off;
    # it publishes only the tile id for commands (the rule resolves the binding).
    try:
        row = q("SELECT value FROM dashboard_settings WHERE key = %s", (CONFIG_KEY,), fetch='one')
        return jsonify({'value': (row['value'] if row else {'pages': []})})
    except Exception as e:
        return _err(e)

@app.route('/api/panel/pass')
def mqtt_pass():
    # dashboard_browser MQTT-WS password — same {value:...} shape bobo-game serves.
    return jsonify({'value': MQTT_BROWSER_PASS})

if __name__ == '__main__':
    log.info('panel-service starting on :%d (static=%s)', PORT, STATIC_DIR)
    app.run(host='0.0.0.0', port=PORT, threaded=True)
