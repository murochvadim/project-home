#!/usr/bin/env python3
"""
BoBo Game Service — LXC 100 (192.168.1.138), port 8770.

Serves the balcony-TV BoBo game so it runs WITHOUT the laptop dashboard being on.
Static: the standalone game shell (bobo.html + bobo-game.js + mqtt.min.js) from ./bobo/.
Data: 6 small endpoints backed by Postgres (LXC 102) — the SAME response/request shapes
the dashboard uses, so the shared bobo-game.js just swaps BOBO_CFG URLs (no fork).

Board input still comes straight from MQTT-WS on LXC 107 (laptop-independent). Scores land
in ph_bobo (Personal Health, keyed by profile_id) — a balance-board ACTIVITY, not a test.

Runs as systemd service bobo-game.service. Env from /etc/environment: DB_PASS + MQTT_BROWSER_PASS.
"""
import os, json, logging
from pathlib import Path
import psycopg2, psycopg2.extras, psycopg2.pool
import paho.mqtt.publish as mqtt_publish
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

PORT        = 8770
STATIC_DIR  = str(Path(__file__).resolve().parent / 'bobo')
DB_HOST     = '192.168.1.219'
DB_NAME     = 'home_data'
DB_USER     = 'postgres'
DB_PASS     = os.environ.get('DB_PASS', '')
SETTINGS_KEY = 'medical.bobo_game'
MQTT_BROWSER_PASS = os.environ.get('MQTT_BROWSER_PASS', '')

# ESP-board config push (calibration wizard) — publish params to the board's /config topic,
# same as the dashboard's /api/esp/boards/<id>/parameters. esp_boards user has write ACL.
MQTT_HOST     = '192.168.1.189'
MQTT_PORT     = 1883
ESP_MQTT_USER = 'esp_boards'
ESP_MQTT_PASS = os.environ.get('ESP_BOARDS_MQTT_PASS', '')
ESP_CONFIG_TOPIC = 'mur/home/esp/balcony_bridge/config'

# ── DB pool (same pattern as player_service.py) ────────────────────
_pool = None
def _get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            1, 6, host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS,
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
    log.exception('bobo-game error')
    return jsonify({'error': str(e)}), 500

# ── static (the game) ──────────────────────────────────────────────
def _nocache(resp):
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/')
def index():
    return _nocache(send_from_directory(STATIC_DIR, 'bobo.html'))

@app.route('/<path:fn>')
def static_file(fn):
    return _nocache(send_from_directory(STATIC_DIR, fn))

# ── data endpoints (mirror the dashboard shapes) ───────────────────
@app.route('/health')
def health():
    return jsonify({'ok': True, 'service': 'bobo-game', 'port': PORT})

@app.route('/api/bobo/mqtt-pass')
def mqtt_pass():
    # dashboard_browser MQTT-WS password (audit #1) — same {value:...} shape the dashboard serves.
    return jsonify({'value': MQTT_BROWSER_PASS})

@app.route('/api/bobo/players')
def players():
    try:
        rows = q("SELECT id, name FROM household_users WHERE active IS NOT FALSE ORDER BY name")
        return jsonify(rows)
    except Exception as e:
        return _err(e)

@app.route('/api/bobo/settings')
def settings_get():
    try:
        row = q("SELECT value FROM dashboard_settings WHERE key = %s", (SETTINGS_KEY,), fetch='one')
        return jsonify({'value': (row['value'] if row else {})})
    except Exception as e:
        return _err(e)

@app.route('/api/bobo/settings', methods=['POST'])
def settings_post():
    # Client (bobo-game.js saveSettings) already read-merge-writes the full value; we upsert it
    # verbatim — identical to the dashboard's /api/dashboard-settings POST (audit #2/#3).
    try:
        body = request.get_json(force=True, silent=True) or {}
        val = body.get('value', {})
        q("""INSERT INTO dashboard_settings (key, value) VALUES (%s, %s::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""",
          (SETTINGS_KEY, json.dumps(val)), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/bobo/recent')
def recent():
    try:
        # BoBo is a Personal Health activity (ph_bobo, keyed by profile_id) — NOT a
        # medical test. Shaped like the old test-results rows for the menu's "Recent".
        rows = q("""SELECT b.id, 'balance' AS test_type, b.measured_at AS tested_at,
                           b.details AS results, jsonb_build_object('game', b.game) AS meta,
                           b.created_at, p.user_id, h.name AS member_name
                      FROM ph_bobo b
                      JOIN ph_profiles p ON p.id = b.profile_id
                      LEFT JOIN household_users h ON h.id = p.user_id
                     ORDER BY b.measured_at DESC
                     LIMIT 20""")
        return jsonify(rows)
    except Exception as e:
        return _err(e)

@app.route('/api/bobo/score', methods=['POST'])
def score():
    try:
        b = request.get_json(force=True, silent=True) or {}
        results = b.get('results')
        if not isinstance(results, dict):
            return jsonify({'error': 'results (object) required'}), 400
        uid = b.get('user_id')
        try:
            uid = int(uid) if uid not in (None, '') else None
        except (TypeError, ValueError):
            uid = None
        # Burned calories = MET(level) × latest body weight × duration. Stored on the results row;
        # skipped if the player has no weight logged in Personal Health (card then shows "—").
        if uid is not None and results.get('calories') is None:
            try:
                wrow = q("""SELECT m.weight_kg FROM ph_measurements m
                            JOIN ph_profiles p ON p.id = m.profile_id
                            WHERE p.user_id = %s ORDER BY m.measured_at DESC LIMIT 1""",
                         (uid,), fetch='one')
                w = float(wrow['weight_kg']) if wrow and wrow.get('weight_kg') is not None else None
                dur = float(results.get('duration_s') or 0)
                if w and dur > 0:
                    met = {'easy': 2.5, 'medium': 3.0, 'hard': 3.5}.get(results.get('level'), 3.0)
                    results['calories'] = round(met * w * dur / 3600.0)
            except Exception:
                log.exception('bobo calories calc failed')
        # Store in ph_bobo (Personal Health), keyed by profile_id resolved from the
        # household user_id. First-class the graphable fields; keep the full blob in details.
        meta = b.get('meta') or {}
        game = meta.get('game') or results.get('game')
        def _n(v):
            try:
                return float(v) if v not in (None, '') else None
            except (TypeError, ValueError):
                return None
        row = q("""INSERT INTO ph_bobo (profile_id, game, level, score, duration_s, calories, details)
                   SELECT p.id, %s, %s, %s, %s, %s, %s::jsonb
                     FROM ph_profiles p WHERE p.user_id = %s
                   RETURNING id, profile_id, measured_at AS tested_at, details AS results, created_at""",
                (game, results.get('level'), _n(results.get('score')), _n(results.get('duration_s')),
                 _n(results.get('calories')), json.dumps(results), uid), fetch='one')
        if not row:
            return jsonify({'error': 'no Personal Health profile for that user'}), 400
        return jsonify(row)
    except Exception as e:
        return _err(e)

# ── calibration wizard endpoints (parity with the dashboard) ───────
def _ds_get(key):
    row = q("SELECT value FROM dashboard_settings WHERE key = %s", (key,), fetch='one')
    return {'value': (row['value'] if row else {})}

def _ds_set(key, val):
    q("""INSERT INTO dashboard_settings (key, value) VALUES (%s, %s::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""",
      (key, json.dumps(val)), fetch='none')

@app.route('/api/bobo/esp-params', methods=['POST'])
def esp_params():
    # Publish calibration params to the ESP board's /config topic (board saves to EEPROM).
    try:
        params = request.get_json(force=True, silent=True) or {}
        mqtt_publish.single(ESP_CONFIG_TOPIC, json.dumps(params), qos=1,
                            hostname=MQTT_HOST, port=MQTT_PORT,
                            auth={'username': ESP_MQTT_USER, 'password': ESP_MQTT_PASS})
        return jsonify({'ok': True, 'published': ESP_CONFIG_TOPIC, 'keys': list(params.keys())})
    except Exception as e:
        return _err(e)

@app.route('/api/bobo/cal')
def cal_get():
    try: return jsonify(_ds_get('medical.bobo_cal'))
    except Exception as e: return _err(e)

@app.route('/api/bobo/cal', methods=['POST'])
def cal_post():
    try:
        b = request.get_json(force=True, silent=True) or {}
        _ds_set('medical.bobo_cal', b.get('value', {}))
        return jsonify({'ok': True})
    except Exception as e: return _err(e)

@app.route('/api/bobo/tune')
def tune_get():
    try: return jsonify(_ds_get('medical.bobo_tune'))
    except Exception as e: return _err(e)

@app.route('/api/bobo/tune', methods=['POST'])
def tune_post():
    try:
        b = request.get_json(force=True, silent=True) or {}
        _ds_set('medical.bobo_tune', b.get('value', {}))
        return jsonify({'ok': True})
    except Exception as e: return _err(e)

if __name__ == '__main__':
    log.info('bobo-game service starting on :%d (static=%s)', PORT, STATIC_DIR)
    app.run(host='0.0.0.0', port=PORT, threaded=True)
