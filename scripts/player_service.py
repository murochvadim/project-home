#!/usr/bin/env python3
"""
Player Service — LXC 100
Handles media browsing, search, playback, faces, library read.
TV/soundbar control proxied to tv_control.py on port 8765.
Runs as systemd service: player.service
Port: 8766
"""
import os, json, logging, subprocess, threading, time, re, sqlite3, signal, random
import numpy as np
from collections import OrderedDict
from pathlib import Path
from urllib.parse import unquote, quote as _urlq
from flask import Flask, jsonify, request, Response, send_file, send_from_directory
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

PORT           = 8766
MEDIA_MOUNT    = '/mnt/media'
DB_HOST        = '192.168.1.219'
DB_NAME        = 'home_data'
DB_USER        = 'postgres'
DB_PASS        = os.environ.get('DB_PASS', '')
VENV_PY        = '/opt/media-agent/venv/bin/python3'
TV_CONTROL_URL = 'http://127.0.0.1:8765'

SAMSUNG_TV_IP   = '192.168.1.129'
SAMSUNG_TV_PORT = 9197
SAMSUNG_AV_PATH = '/upnp/control/AVTransport1'
TV_URL          = f'http://{SAMSUNG_TV_IP}:{SAMSUNG_TV_PORT}{SAMSUNG_AV_PATH}'
MEDIA_LXC_IP    = '192.168.1.138'

# Samsung 990C Soundbar — Chromecast-capable (Google Cast protocol on
# port 8009). Used for audio playback to bypass the TV's broken UPnP music
# app. Video still goes to the TV via UPnP (which works).
SOUNDBAR_IP   = '192.168.1.149'
SOUNDBAR_NAME = 'Samsung Soundbar'

MINIDLNA_DB = '/var/cache/minidlna/files.db'
MINIDLNA_PID = '/run/minidlna/minidlna.pid'

IMAGE_EXTS     = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}
AUDIO_EXTS     = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}

THUMB_CACHE     = OrderedDict()
THUMB_CACHE_MAX = 200


# ── Search session ───────────────────────────────────────────────
_search_session = {'results': [], 'timestamp': 0}


# ── DB connection pool ───────────────────────────────────────────
import psycopg2, psycopg2.extras, psycopg2.pool

_db_pool      = None
_db_pool_lock = threading.Lock()

def _get_pool():
    global _db_pool
    if _db_pool is None:
        with _db_pool_lock:
            if _db_pool is None:
                _db_pool = psycopg2.pool.ThreadedConnectionPool(
                    1, 5,
                    host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS,
                    connect_timeout=10
                )
    return _db_pool

def db_query(sql, params=None, fetch=True):
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params or ())
                if fetch:
                    return [dict(r) for r in cur.fetchall()]
                return None
    finally:
        pool.putconn(conn)


# ── Path safety helper ───────────────────────────────────────────
def safe_path(rel, base=MEDIA_MOUNT):
    real_base = os.path.realpath(base)
    full = os.path.realpath(os.path.join(base, rel.lstrip('/')))
    if full != real_base and not full.startswith(real_base + '/'):
        raise ValueError(f'Path traversal attempt: {rel!r}')
    return full


# ── DLNA helpers ──────────────────────────────────────────────────
def dlna_soap(action, body_xml, timeout=10):
    """POST a SOAP body to the TV's AVTransport endpoint. Returns (ok, body)
    so callers can detect TV-unreachable failures instead of silently
    treating empty / 5xx responses as success."""
    soap = (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        '<s:Body>' + body_xml + '</s:Body></s:Envelope>'
    )
    tmp = f'/tmp/dlna_{action}_{int(time.time()*1000)}.xml'
    with open(tmp, 'w') as f:
        f.write(soap)
    try:
        r = subprocess.run(
            ['curl', '-sS', '--fail-with-body', '-X', 'POST', TV_URL,
             '-H', 'Content-Type: text/xml; charset="utf-8"',
             '-H', f'SOAPACTION: "urn:schemas-upnp-org:service:AVTransport:1#{action}"',
             '--data', f'@{tmp}'],
            capture_output=True, text=True, timeout=timeout
        )
        ok = (r.returncode == 0 and '<s:Fault>' not in r.stdout)
        return ok, r.stdout
    except subprocess.TimeoutExpired:
        return False, ''
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

def minidlna_id(full_path):
    for attempt in range(2):
        conn = sqlite3.connect(MINIDLNA_DB)
        try:
            cur = conn.execute('SELECT id FROM details WHERE path=?', (full_path,))
            row = cur.fetchone()
        finally:
            conn.close()
        if row:
            return str(row[0])
        try:
            with open(MINIDLNA_PID) as _pf:
                os.kill(int(_pf.read().strip()), signal.SIGHUP)
        except Exception as e:
            log.warning('minidlna SIGHUP failed: %s', e)
        time.sleep(2)
    return None


# ── XML escape helper ─────────────────────────────────────────────
def xml_escape(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


# ── Shared play helper (runs in background thread) ────────────────
# Generation counter — every entry to _wake_and_play bumps it and captures
# its own value. Periodically checked inside long waits so a newer call
# (Next button, user clicks Play on a different item, watcher auto-advance)
# can abort the in-flight one without two threads sending interleaved SOAP
# commands to the TV. Caused mid-queue NO_MEDIA_PRESENT lockups when Next
# was pressed before the previous track finished its setup sequence.
_play_gen_lock = threading.Lock()
_play_gen = 0
def _next_play_gen():
    global _play_gen
    with _play_gen_lock:
        _play_gen += 1
        return _play_gen
def _is_play_gen_current(gen):
    with _play_gen_lock:
        return gen == _play_gen


def _wait_for_tv_ready(max_wait_sec=15):
    """Poll TV's AVTransport endpoint until it accepts SOAP requests, or until
    max_wait_sec elapses. Returns True on ready, False on timeout. Replaces a
    static time.sleep(3) that was sometimes too short (intermittent failures
    when the TV was cold) and sometimes wastefully long."""
    deadline = time.time() + max_wait_sec
    probe = ('<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
             '<InstanceID>0</InstanceID></u:GetTransportInfo>')
    while time.time() < deadline:
        ok, _ = dlna_soap('GetTransportInfo', probe, timeout=2)
        if ok:
            return True
        time.sleep(0.5)
    return False


def _wake_and_play(full_path, ext, title, dlna_id, stream_url=None):
    import urllib.request as ureq
    my_gen = _next_play_gen()
    def _aborted():
        return not _is_play_gen_current(my_gen)
    try:
        ureq.urlopen(
            ureq.Request(f'{TV_CONTROL_URL}/media/command',
                         data=json.dumps({'entity': 'tv', 'command': 'turn_on'}).encode(),
                         headers={'Content-Type': 'application/json'}, method='POST'),
            timeout=5
        )
    except Exception:
        pass
    # Active wait — return as soon as TV's UPnP service answers. Beats the
    # old static sleep(3) which was the main source of "plays sometimes,
    # silent sometimes" behaviour: 3 s was a lucky-guess timing.
    ready = _wait_for_tv_ready(max_wait_sec=15)
    if not ready:
        log.warning(f"_wake_and_play: TV did not respond within 15s for {title!r} — sending commands anyway")
    # UPnP AVTransport state machine: Samsung rejects SetAVTransportURI /
    # Play when transport is PLAYING. Force STOPPED before loading a new
    # URI. Fail-silent — fresh boots are already STOPPED and Stop returns
    # an error in that case, which is fine.
    dlna_soap('Stop',
        '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
        '<InstanceID>0</InstanceID></u:Stop>'
    )
    # Actively wait for STOPPED. Samsung doesn't actually finish tearing
    # down the previous track for ~2-3 s after Stop returns.
    for _ in range(20):
        if _aborted():
            log.info(f"_wake_and_play: aborted (newer play queued) — dropping {title!r}")
            return
        if _get_transport_state() in ('STOPPED', 'NO_MEDIA_PRESENT', 'UNKNOWN'):
            break
        time.sleep(0.25)
    if _aborted():
        return
    time.sleep(0.5)
    is_audio       = ('.' + ext.lower()) in AUDIO_EXTS
    if stream_url is None:
        stream_url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext}'
    stream_url_xml = xml_escape(stream_url)
    title_xml      = xml_escape(title)
    dlna_class     = 'object.item.audioItem.musicTrack' if is_audio else 'object.item.videoItem'
    # Unique DIDL item id per call — Samsung dedups SetAVTransportURI when
    # the metadata id matches the previous track's, causing mid-queue
    # transitions to silently not refresh the stream URL on the TV side.
    item_id = dlna_id or f"item-{int(time.time() * 1000)}"
    ok_set, _ = dlna_soap('SetAVTransportURI',
        f'<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
        f'<InstanceID>0</InstanceID><CurrentURI>{stream_url_xml}</CurrentURI>'
        f'<CurrentURIMetaData>'
        f'<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        f'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        f'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        f'<item id="{item_id}" parentID="0" restricted="1">'
        f'<dc:title>{title_xml}</dc:title>'
        f'<upnp:class>{dlna_class}</upnp:class>'
        f'<res>{stream_url_xml}</res></item></DIDL-Lite>'
        f'</CurrentURIMetaData></u:SetAVTransportURI>'
    )
    if not ok_set:
        log.warning(f"_wake_and_play: SetAVTransportURI failed for {title!r}")
    # Wait for the URI to settle before sending Play. SetAVTransportURI on
    # Samsung TVs briefly bounces transport into TRANSITIONING while the new
    # URI is parsed. Play during that window is the bug — TV accepts it but
    # never actually starts streaming.
    for _ in range(20):
        if _aborted():
            return
        if _get_transport_state() in ('STOPPED', 'NO_MEDIA_PRESENT'):
            break
        time.sleep(0.25)
    if _aborted():
        return
    play_body = ('<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                 '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>')
    ok_play = False
    for attempt in range(3):
        if _aborted():
            return
        ok_play, _ = dlna_soap('Play', play_body)
        if ok_play:
            break
        time.sleep(1)
        log.info(f"_wake_and_play: Play retry {attempt + 1}/3 for {title!r}")
    if not ok_play:
        log.warning(f"_wake_and_play: Play failed for {title!r} after 3 retries")
    # SOAP 200 OK doesn't guarantee the TV actually started playing — it
    # can accept the call and silently fail to fetch / decode the stream.
    # Verify by polling transport state for up to 6 s; if we never reach
    # PLAYING, log a loud warning so the failure mode is visible in journal.
    confirmed = False
    state = 'UNKNOWN'
    for _ in range(6):
        if _aborted():
            return
        time.sleep(1)
        state = _get_transport_state()
        if state == 'PLAYING':
            confirmed = True
            break
        if state in ('STOPPED', 'NO_MEDIA_PRESENT'):
            log.warning(f"_wake_and_play: TV settled in {state} (not PLAYING) for {title!r} — stream URL or codec likely rejected by TV")
            break
    if not confirmed and not _aborted():
        log.warning(f"_wake_and_play: never observed PLAYING for {title!r} (last state={state!r})")


# ── Health ────────────────────────────────────────────────────────
@app.route('/health')
def health():
    try:
        db_query('SELECT 1')
        db_ok = True
    except Exception:
        db_ok = False
    return jsonify({'ok': db_ok, 'service': 'player', 'port': PORT, 'db': 'ok' if db_ok else 'error'})


# ── TV state + command (proxy to tv_control.py port 8765) ─────────
@app.route('/api/media/state')
def media_state():
    import urllib.request
    try:
        with urllib.request.urlopen(f'{TV_CONTROL_URL}/media/state', timeout=5) as r:
            return Response(r.read(), status=r.status, mimetype='application/json')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/media/command', methods=['POST'])
def media_command():
    import urllib.request, urllib.error
    if not request.json:
        return jsonify({'error': 'JSON body required'}), 400
    try:
        data = json.dumps(request.json).encode()
        req  = urllib.request.Request(
            f'{TV_CONTROL_URL}/media/command', data=data,
            headers={'Content-Type': 'application/json'}, method='POST'
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return Response(r.read(), status=r.status, mimetype='application/json')
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/media/search ─────────────────────────────────────────
@app.route('/api/media/search')
def search():
    global _search_session
    q = (request.args.get('q') or '').strip()
    if not q:
        return jsonify({'error': 'q required'}), 400
    try:
        rows = db_query(
            "SELECT path, title, type, person, event, year, duration_sec, last_played "
            "FROM media_library "
            "WHERE to_tsvector('english', coalesce(search_text,'')) @@ plainto_tsquery('english', %s) "
            "   OR (%s != 'not_recognized' AND %s = ANY(person)) "
            "ORDER BY added_at DESC LIMIT 15",
            (q, q, q)
        )
        results = [dict(r, number=i + 1) for i, r in enumerate(rows)]
        _search_session = {'results': results, 'timestamp': time.time()}
        return jsonify({'query': q, 'count': len(results), 'results': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/media/search/session ────────────────────────────────
@app.route('/api/media/search/session')
def search_session():
    return jsonify(_search_session)


# ── GET /api/media/library/<path> (single record) ────────────────
@app.route('/api/media/library/<path:encoded_path>')
def library_single(encoded_path):
    file_path = unquote(encoded_path)
    try:
        rows = db_query(
            'SELECT path, title, type, person, event, year, location, '
            'search_text, duration_sec, resolution, size_bytes, added_at, last_played, status '
            'FROM media_library WHERE path=%s',
            (file_path,)
        )
        if not rows:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(rows[0])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/media/library ────────────────────────────────────────
@app.route('/api/media/library')
def library():
    try:
        limit  = min(int(request.args.get('limit', 100)), 500)
        offset = int(request.args.get('offset', 0))
        filter_type         = request.args.get('type', '')
        filter_unrecognized = request.args.get('unrecognized', '')

        where, params = [], []
        if filter_type:
            where.append('type = %s')
            params.append(filter_type)
        if filter_unrecognized:
            where.append("'not_recognized' = ANY(person)")

        where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''
        rows = db_query(
            f'SELECT path, title, type, person, event, year, location, '
            f'duration_sec, resolution, size_bytes, file_hash, added_at, last_played, search_text '
            f'FROM media_library {where_sql} ORDER BY added_at DESC LIMIT %s OFFSET %s',
            params + [limit, offset]
        )
        total_rows = db_query(f'SELECT COUNT(*) as cnt FROM media_library {where_sql}', params)
        total = total_rows[0]['cnt'] if total_rows else 0
        return jsonify({'rows': rows, 'total': total, 'limit': limit, 'offset': offset})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/faces/clusters ───────────────────────────────────────
@app.route('/api/faces/clusters')
def faces_clusters():
    try:
        rows = db_query(
            "SELECT cluster_id, COUNT(*) as face_count, COUNT(DISTINCT file_path) as file_count "
            "FROM face_crops "
            "WHERE cluster_id IS NOT NULL AND person_name IS NULL "
            "GROUP BY cluster_id ORDER BY face_count DESC"
        )
        best_crops = db_query(
            "SELECT DISTINCT ON (cluster_id) cluster_id, crop_path "
            "FROM face_crops "
            "WHERE cluster_id IS NOT NULL AND person_name IS NULL "
            "ORDER BY cluster_id, (bbox_x2-bbox_x1)*(bbox_y2-bbox_y1) DESC"
        )
        crop_map = {r['cluster_id']: os.path.basename(r['crop_path'])
                    for r in best_crops if r.get('crop_path')}
        emb_rows = db_query(
            "SELECT cluster_id, embedding FROM face_crops "
            "WHERE cluster_id IS NOT NULL AND person_name IS NULL "
            "AND array_length(embedding, 1) = 512"
        )
        from collections import defaultdict
        cluster_embs = defaultdict(list)
        for r in emb_rows:
            if r.get('embedding'):
                cluster_embs[r['cluster_id']].append(r['embedding'])
        def _confidence(embs):
            if len(embs) == 0:
                return None
            if len(embs) == 1:
                return None
            mat = np.array(embs, dtype=np.float32)
            norms = np.linalg.norm(mat, axis=1, keepdims=True)
            norms[norms == 0] = 1
            mat = mat / norms
            centroid = mat.mean(axis=0)
            cn = np.linalg.norm(centroid)
            if cn == 0:
                return None
            centroid = centroid / cn
            return float(np.mean(mat @ centroid))
        result = [{
            'cluster_id': r['cluster_id'],
            'face_count': r['face_count'],
            'file_count': r['file_count'],
            'crop_file':  crop_map.get(r['cluster_id']),
            'confidence': _confidence(cluster_embs.get(r['cluster_id'], [])),
        } for r in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/faces/label ─────────────────────────────────────────
@app.route('/api/faces/label', methods=['POST'])
def faces_label():
    body       = request.json or {}
    cluster_id = body.get('cluster_id')
    name       = re.sub(r'[^a-z0-9 ]', '', (body.get('name') or '').strip().lower())
    if not cluster_id or not name:
        return jsonify({'error': 'cluster_id and name required'}), 400
    try:
        db_query(
            "UPDATE face_crops SET person_name=%s WHERE cluster_id=%s",
            (name, cluster_id), fetch=False
        )
        files = db_query(
            "SELECT DISTINCT file_path FROM face_crops WHERE cluster_id=%s", (cluster_id,)
        )
        for f in files:
            db_query(
                "UPDATE media_library SET "
                "person = CASE WHEN person = '{not_recognized}' THEN ARRAY[%s] "
                "              ELSE array_append(person, %s) END, "
                "search_text = TRIM(REGEXP_REPLACE(coalesce(search_text,'') || ' ' || %s, '\\s+', ' ', 'g')) "
                "WHERE path=%s AND NOT (%s = ANY(person))",
                (name, name, name, f['file_path'], name), fetch=False
            )
        # Save best embedding (highest det_score) to person_embeddings for post-rerun auto-matching
        best = db_query(
            "SELECT embedding, det_score FROM face_crops "
            "WHERE cluster_id=%s AND embedding IS NOT NULL AND array_length(embedding,1)=512 "
            "ORDER BY det_score DESC NULLS LAST LIMIT 1",
            (cluster_id,), fetch=True
        )
        if best and best[0].get('embedding'):
            db_query(
                "INSERT INTO person_embeddings (name, embedding, det_score) VALUES (%s, %s, %s) "
                "ON CONFLICT (name) DO UPDATE SET embedding=EXCLUDED.embedding, det_score=EXCLUDED.det_score, added_at=NOW()",
                (name, best[0]['embedding'], best[0].get('det_score')), fetch=False
            )
        return jsonify({'ok': True, 'name': name, 'files_updated': len(files)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/faces/people ─────────────────────────────────────────
@app.route('/api/faces/people')
def faces_people():
    try:
        rows = db_query(
            "SELECT person_name, COUNT(*) as face_count, COUNT(DISTINCT file_path) as file_count "
            "FROM face_crops WHERE person_name IS NOT NULL AND person_name != '_skipped' "
            "GROUP BY person_name ORDER BY person_name"
        )
        best_crops = db_query(
            "SELECT DISTINCT ON (person_name) person_name, crop_path "
            "FROM face_crops "
            "WHERE person_name IS NOT NULL AND person_name != '_skipped' "
            "ORDER BY person_name, (bbox_x2-bbox_x1)*(bbox_y2-bbox_y1) DESC"
        )
        crop_map = {r['person_name']: os.path.basename(r['crop_path'])
                    for r in best_crops if r.get('crop_path')}
        emb_rows = db_query(
            "SELECT person_name, embedding FROM face_crops "
            "WHERE person_name IS NOT NULL AND person_name != '_skipped' AND array_length(embedding, 1) = 512"
        )
        from collections import defaultdict
        person_embs = defaultdict(list)
        for r in emb_rows:
            if r.get('embedding'):
                person_embs[r['person_name']].append(r['embedding'])
        def _conf(embs):
            if len(embs) == 0:
                return None
            if len(embs) == 1:
                return None
            mat = np.array(embs, dtype=np.float32)
            norms = np.linalg.norm(mat, axis=1, keepdims=True)
            norms[norms == 0] = 1
            mat = mat / norms
            centroid = mat.mean(axis=0)
            cn = np.linalg.norm(centroid)
            if cn == 0:
                return None
            centroid = centroid / cn
            return float(np.mean(mat @ centroid))
        pe_rows = db_query("SELECT name, det_score FROM person_embeddings")
        pe_score_map = {r['name']: r['det_score'] for r in pe_rows}
        result = [{
            'name':       r['person_name'],
            'face_count': r['face_count'],
            'file_count': r['file_count'],
            'crop_file':  crop_map.get(r['person_name']),
            'confidence': _conf(person_embs.get(r['person_name'], [])),
            'det_score':  pe_score_map.get(r['person_name']),
        } for r in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/faces/rename ────────────────────────────────────────
@app.route('/api/faces/rename', methods=['POST'])
def faces_rename():
    body     = request.json or {}
    old_name = re.sub(r'[^a-z0-9 ]', '', (body.get('old_name') or '').strip().lower())
    new_name = re.sub(r'[^a-z0-9 ]', '', (body.get('new_name') or '').strip().lower())
    if not old_name or not new_name:
        return jsonify({'error': 'old_name and new_name required'}), 400
    if old_name == new_name:
        return jsonify({'ok': True}), 200
    try:
        db_query("UPDATE face_crops SET person_name=%s WHERE person_name=%s",
                 (new_name, old_name), fetch=False)
        db_query(
            "UPDATE person_embeddings SET name=%s, added_at=NOW() WHERE name=%s",
            (new_name, old_name), fetch=False
        )
        db_query(
            "UPDATE media_library SET "
            "person = array_replace(person, %s, %s), "
            "search_text = TRIM(REGEXP_REPLACE(REPLACE(coalesce(search_text,''), %s, %s), '\\s+', ' ', 'g')) "
            "WHERE %s = ANY(person)",
            (old_name, new_name, old_name, new_name, old_name), fetch=False
        )
        return jsonify({'ok': True, 'old_name': old_name, 'new_name': new_name})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/faces/people/<name>/crops ───────────────────────────
@app.route('/api/faces/people/<name>/crops')
def faces_person_crops(name):
    try:
        rows = db_query(
            "SELECT id, crop_path, file_path, frame_sec, embedding "
            "FROM face_crops WHERE person_name=%s ORDER BY file_path, frame_sec",
            (name,)
        )
        import numpy as np
        embs_valid = [(i, np.array(r['embedding'], dtype=float))
                      for i, r in enumerate(rows) if r['embedding']]
        confidence_map = {}
        if len(embs_valid) >= 2:
            mat = np.array([e for _, e in embs_valid], dtype=float)
            norms = np.linalg.norm(mat, axis=1, keepdims=True)
            norms[norms == 0] = 1
            mat_n = mat / norms
            centroid = mat_n.mean(axis=0)
            cn = np.linalg.norm(centroid)
            if cn > 0: centroid /= cn
            for i, e in embs_valid:
                n = np.linalg.norm(e)
                sim = float(np.dot(e / n, centroid)) if n > 0 else 0.0
                confidence_map[rows[i]['id']] = round(max(0.0, min(1.0, sim)), 3)
        result = []
        for r in rows:
            cp = r['crop_path'] or ''
            result.append({
                'id':         r['id'],
                'crop_file':  os.path.basename(cp),
                'file_path':  r['file_path'],
                'file_name':  os.path.basename(r['file_path'] or ''),
                'frame_sec':  r['frame_sec'],
                'confidence': confidence_map.get(r['id']),
            })
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── DELETE /api/faces/crop/<id> ───────────────────────────────────
@app.route('/api/faces/crop/<int:crop_id>', methods=['DELETE'])
def faces_delete_crop(crop_id):
    try:
        rows = db_query("SELECT file_path, person_name FROM face_crops WHERE id=%s", (crop_id,))
        if not rows:
            return jsonify({'error': 'not found'}), 404
        file_path   = rows[0]['file_path']
        person_name = rows[0]['person_name']

        # Delete crop file from disk
        crop_rows = db_query("SELECT crop_path FROM face_crops WHERE id=%s", (crop_id,))
        if crop_rows and crop_rows[0]['crop_path']:
            try: os.unlink(crop_rows[0]['crop_path'])
            except Exception as e: log.warning('crop unlink failed: %s', e)

        db_query("DELETE FROM face_crops WHERE id=%s", (crop_id,), fetch=False)

        # If this person has no more crops for this file, remove from media_library
        if person_name and file_path:
            remaining = db_query(
                "SELECT COUNT(*) as cnt FROM face_crops WHERE file_path=%s AND person_name=%s",
                (file_path, person_name)
            )
            if remaining and remaining[0]['cnt'] == 0:
                db_query(
                    "UPDATE media_library SET "
                    "person = array_remove(person, %s), "
                    "search_text = TRIM(REGEXP_REPLACE(REPLACE(search_text, %s, ''), '\\s+', ' ', 'g')) "
                    "WHERE path=%s",
                    (person_name, person_name, file_path), fetch=False
                )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── DELETE /api/faces/people/<name> ──────────────────────────────
@app.route('/api/faces/people/<name>', methods=['DELETE'])
def faces_forget(name):
    try:
        name = re.sub(r'[^a-z0-9 ]', '', name.strip().lower())
        if not name:
            return jsonify({'error': 'invalid name'}), 400
        db_query("UPDATE face_crops SET person_name=NULL WHERE person_name=%s", (name,), fetch=False)
        db_query("DELETE FROM person_embeddings WHERE name=%s", (name,), fetch=False)
        db_query(
            "UPDATE media_library SET "
            "person = array_remove(person, %s), "
            "search_text = TRIM(REGEXP_REPLACE(REPLACE(coalesce(search_text,''), %s, ''), '\\s+', ' ', 'g')) "
            "WHERE %s = ANY(person)",
            (name, name, name), fetch=False
        )
        db_query(
            "UPDATE media_library SET person = '{not_recognized}' "
            "WHERE person = '{}' AND type != 'audio'",
            fetch=False
        )
        return jsonify({'ok': True, 'name': name})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/faces/crop/<filename> ───────────────────────────────
@app.route('/api/faces/crop/<filename>')
def faces_crop(filename):
    if not re.match(r'^[a-f0-9]{32}\.jpg$', filename):
        return jsonify({'error': 'invalid filename'}), 400
    crop_path = os.path.join('/mnt/media/.faces', filename)
    if not os.path.isfile(crop_path):
        return jsonify({'error': 'not found'}), 404
    return send_file(crop_path, mimetype='image/jpeg')


# ── GET /api/faces/frame/<id> ────────────────────────────────────
@app.route('/api/faces/frame/<int:face_id>')
def faces_frame(face_id):
    """Extract full video frame at the face's timestamp and return as JPEG."""
    try:
        rows = db_query("SELECT file_path, frame_sec FROM face_crops WHERE id=%s", (face_id,))
        if not rows:
            return jsonify({'error': 'not found'}), 404
        row = rows[0]
        file_path = row['file_path']
        frame_sec = row['frame_sec']
        if frame_sec is None:
            # it's an image — serve directly
            if not os.path.isfile(file_path):
                return jsonify({'error': 'file not found'}), 404
            return send_file(file_path, mimetype='image/jpeg')
        if not os.path.isfile(file_path):
            return jsonify({'error': 'video not found'}), 404
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp_path = tmp.name
        try:
            r = subprocess.run([
                'ffmpeg', '-y', '-ss', str(frame_sec),
                '-i', file_path,
                '-frames:v', '1', '-q:v', '3',
                tmp_path
            ], capture_output=True, timeout=15)
            if r.returncode != 0 or not os.path.isfile(tmp_path):
                return jsonify({'error': 'frame extraction failed'}), 500
            return send_file(tmp_path, mimetype='image/jpeg')
        finally:
            try: os.unlink(tmp_path)
            except: pass
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/faces/video-frame ───────────────────────────────────
@app.route('/api/faces/video-frame')
def faces_video_frame():
    """Extract a frame from any video at a given second. ?path=...&sec=..."""
    file_path = request.args.get('path', '')
    try:
        sec = float(request.args.get('sec', 0))
    except ValueError:
        return jsonify({'error': 'invalid sec'}), 400
    if not file_path or not os.path.realpath(file_path).startswith(os.path.realpath(MEDIA_MOUNT) + '/'):
        return jsonify({'error': 'invalid path'}), 400
    if not os.path.isfile(file_path):
        return jsonify({'error': 'file not found'}), 404
    import subprocess, tempfile
    with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        r = subprocess.run([
            'ffmpeg', '-y', '-ss', str(sec),
            '-i', file_path,
            '-frames:v', '1', '-q:v', '3',
            tmp_path
        ], capture_output=True, timeout=15)
        if r.returncode != 0 or not os.path.isfile(tmp_path):
            return jsonify({'error': 'frame extraction failed'}), 500
        return send_file(tmp_path, mimetype='image/jpeg')
    finally:
        try: os.unlink(tmp_path)
        except: pass


# ── POST /api/faces/manual-crop ──────────────────────────────────
@app.route('/api/faces/manual-crop', methods=['POST'])
def faces_manual_crop():
    """
    User drew a box on the full frame. Extract that region, get embedding, save.
    Body: { file_path, frame_sec, x1_frac, y1_frac, x2_frac, y2_frac, name }
    Fractions are 0.0–1.0 relative to the displayed image dimensions.
    """
    body      = request.json or {}
    file_path = body.get('file_path', '')
    frame_sec = body.get('frame_sec')
    x1f = float(body.get('x1_frac', 0)); y1f = float(body.get('y1_frac', 0))
    x2f = float(body.get('x2_frac', 1)); y2f = float(body.get('y2_frac', 1))
    name      = (body.get('name') or '').strip()
    if not file_path or not name:
        return jsonify({'error': 'file_path and name required'}), 400
    if not os.path.isfile(file_path):
        return jsonify({'error': 'video/image not found'}), 404
    try:
        import cv2, numpy as np, uuid as _uuid

        # Extract frame
        if frame_sec is not None:
            cap = cv2.VideoCapture(file_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(float(frame_sec) * fps))
            ok, frame = cap.read()
            cap.release()
            if not ok or frame is None:
                return jsonify({'error': 'could not read frame'}), 500
        else:
            frame = cv2.imread(file_path)
            if frame is None:
                return jsonify({'error': 'could not read image'}), 500

        h, w = frame.shape[:2]
        x1 = max(0, int(x1f * w)); y1 = max(0, int(y1f * h))
        x2 = min(w, int(x2f * w)); y2 = min(h, int(y2f * h))
        if x2 - x1 < 10 or y2 - y1 < 10:
            return jsonify({'error': 'selection too small'}), 400

        crop = frame[y1:y2, x1:x2]
        crop_112 = cv2.resize(crop, (112, 112))

        # Save crop image
        os.makedirs('/mnt/media/.faces', exist_ok=True)
        fname = _uuid.uuid4().hex + '.jpg'
        crop_path = os.path.join('/mnt/media/.faces', fname)
        cv2.imwrite(crop_path, crop_112, [cv2.IMWRITE_JPEG_QUALITY, 85])

        # Insert face_crop with empty embedding placeholder.
        # Analyzer will compute the real embedding on its next pass.
        db_query(
            "INSERT INTO face_crops "
            "(file_path, frame_sec, bbox_x1, bbox_y1, bbox_x2, bbox_y2, crop_path, embedding, person_name) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,ARRAY[]::FLOAT8[],%s)",
            (file_path, frame_sec, x1, y1, x2, y2, crop_path, name),
            fetch=False
        )

        # Propagate to media_library
        db_query(
            "UPDATE media_library SET "
            "person = array_append(person, %s), "
            "search_text = TRIM(REGEXP_REPLACE(search_text || ' ' || %s, '\\s+', ' ', 'g')) "
            "WHERE path=%s AND NOT (%s = ANY(COALESCE(person, ARRAY[]::TEXT[])))",
            (name, name, file_path, name), fetch=False
        )

        return jsonify({'ok': True, 'crop_file': fname})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/faces/unmatched ─────────────────────────────────────
@app.route('/api/faces/unmatched')
def faces_unmatched():
    try:
        rows = db_query(
            "SELECT id, crop_path, file_path, frame_sec, det_score "
            "FROM face_crops "
            "WHERE cluster_id IS NULL AND person_name IS NULL "
            "ORDER BY id"
        )
        result = []
        for r in rows:
            cp = r['crop_path'] or ''
            fname = os.path.basename(cp)
            result.append({
                'id':        r['id'],
                'crop_file': fname,
                'file_name': os.path.basename(r['file_path'] or ''),
                'frame_sec': r['frame_sec'],
                'det_score': r['det_score'],
            })
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/faces/skip ─────────────────────────────────────────
@app.route('/api/faces/skip', methods=['POST'])
def faces_skip():
    """Permanently mark an unmatched face as skipped (person_name='_skipped')."""
    body    = request.json or {}
    face_id = body.get('face_id')
    if not face_id:
        return jsonify({'error': 'face_id required'}), 400
    try:
        db_query(
            "UPDATE face_crops SET person_name='_skipped' WHERE id=%s AND cluster_id IS NULL",
            (face_id,), fetch=False
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/faces/assign ────────────────────────────────────────
@app.route('/api/faces/assign', methods=['POST'])
def faces_assign():
    """Assign a single unmatched face crop to a person name."""
    body      = request.json or {}
    face_id   = body.get('face_id')
    name      = re.sub(r'[^a-z0-9 ]', '', (body.get('name') or '').strip().lower())
    if not face_id or not name:
        return jsonify({'error': 'face_id and name required'}), 400
    try:
        db_query(
            "UPDATE face_crops SET person_name=%s WHERE id=%s AND cluster_id IS NULL",
            (name, face_id), fetch=False
        )
        # propagate to media_library
        file_rows = db_query("SELECT file_path FROM face_crops WHERE id=%s", (face_id,))
        if file_rows:
            fp = file_rows[0]['file_path']
            db_query(
                "UPDATE media_library SET "
                "person = array_append(person, %s), "
                "search_text = TRIM(REGEXP_REPLACE(search_text || ' ' || %s, '\\s+', ' ', 'g')) "
                "WHERE path=%s AND NOT (%s = ANY(COALESCE(person, ARRAY[]::TEXT[])))",
                (name, name, fp, name), fetch=False
            )
        # Save best embedding (highest det_score) to person_embeddings
        best = db_query(
            "SELECT embedding, det_score FROM face_crops "
            "WHERE person_name=%s AND embedding IS NOT NULL AND array_length(embedding,1)=512 "
            "ORDER BY det_score DESC NULLS LAST LIMIT 1",
            (name,), fetch=True
        )
        if best and best[0].get('embedding'):
            db_query(
                "INSERT INTO person_embeddings (name, embedding, det_score) VALUES (%s, %s, %s) "
                "ON CONFLICT (name) DO UPDATE SET embedding=EXCLUDED.embedding, det_score=EXCLUDED.det_score, added_at=NOW()",
                (name, best[0]['embedding'], best[0].get('det_score')), fetch=False
            )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Analyzer settings helpers ────────────────────────────────────
ANALYZER_DEFAULTS = {
    # auto mode
    'auto_enabled':           1,
    'auto_frame_interval':    60,
    'auto_face_score_min':    0.60,
    'auto_cluster_every':     10,
    # manual mode
    'manual_batch_size':      1,
    'manual_frame_interval':  30,
    'manual_face_score_min':  0.50,
    'manual_cluster_eps':     0.70,
}

def ensure_analyzer_settings():
    db_query("""
        CREATE TABLE IF NOT EXISTS analyzer_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """, fetch=False)
    for k, v in ANALYZER_DEFAULTS.items():
        db_query(
            "INSERT INTO analyzer_settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO NOTHING",
            (k, str(v)), fetch=False
        )

def get_analyzer_settings():
    ensure_analyzer_settings()
    rows = db_query("SELECT key, value FROM analyzer_settings")
    settings = dict(ANALYZER_DEFAULTS)
    for r in rows:
        k, v = r['key'], r['value']
        if k in settings:
            settings[k] = type(ANALYZER_DEFAULTS[k])(v)
    return settings


# ── GET /api/analyzer/settings ────────────────────────────────────
@app.route('/api/analyzer/settings')
def analyzer_settings_get():
    try:
        s = get_analyzer_settings()
        # include descriptions for UI
        return jsonify(s)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/analyzer/settings ───────────────────────────────────
@app.route('/api/analyzer/settings', methods=['POST'])
def analyzer_settings_post():
    body = request.json or {}
    try:
        ensure_analyzer_settings()
        for k, v in body.items():
            if k not in ANALYZER_DEFAULTS:
                continue
            db_query(
                "INSERT INTO analyzer_settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
                (k, str(v)), fetch=False
            )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/analyzer/status ──────────────────────────────────────
@app.route('/api/analyzer/status')
def analyzer_status():
    try:
        rows = db_query("SELECT status, COUNT(*) as cnt FROM media_library GROUP BY status")
        counts   = {r['status']: r['cnt'] for r in rows}
        total    = sum(counts.values())
        last_log = db_query("SELECT ts, decision, error FROM analyzer_log ORDER BY ts DESC LIMIT 1")
        face_rows = db_query(
            "SELECT "
            "  COUNT(*) FILTER (WHERE cluster_id IS NULL)     AS unassigned, "
            "  COUNT(*) FILTER (WHERE cluster_id IS NOT NULL AND person_name IS NULL) AS unlabeled, "
            "  COUNT(*) FILTER (WHERE person_name IS NOT NULL) AS named "
            "FROM face_crops"
        )
        faces = face_rows[0] if face_rows else {'unassigned': 0, 'unlabeled': 0, 'named': 0}
        return jsonify({
            'pending':    counts.get('pending', 0),
            'processing': counts.get('processing', 0),
            'searchable': counts.get('searchable', 0),
            'ready':      counts.get('ready', 0),
            'error':      counts.get('error', 0),
            'total':      total,
            'last_run':   last_log[0] if last_log else None,
            'faces': {
                'unassigned': faces['unassigned'],
                'unlabeled':  faces['unlabeled'],
                'named':      faces['named'],
            },
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/analyzer/rerun ──────────────────────────────────────
@app.route('/api/analyzer/rerun', methods=['POST'])
def analyzer_rerun():
    """Delete all face crops (no duplicates on re-detect), reset files to pending.
    rerun_keep_people setting controls whether person[] on files is preserved or cleared."""
    try:
        all_rows = db_query("SELECT path FROM media_library", fetch=True)
        missing  = [r['path'] for r in all_rows if not os.path.isfile(r['path'])]

        # Delete ALL face crops (existing + missing) to avoid duplicate embeddings on re-detect
        all_crops = db_query("SELECT crop_path FROM face_crops", fetch=True)
        for c in all_crops:
            try:
                if c['crop_path']: os.remove(c['crop_path'])
            except Exception as e:
                log.warning('crop removal failed %s: %s', c.get('crop_path'), e)
        db_query("DELETE FROM face_crops", fetch=False)

        # Remove media_library rows for files no longer on disk
        if missing:
            db_query("DELETE FROM media_library WHERE path = ANY(%s)", (missing,), fetch=False)
            # Clean person_embeddings: remove people no longer referenced in any remaining file
            db_query(
                "DELETE FROM person_embeddings WHERE name NOT IN ("
                "  SELECT DISTINCT unnest(person) FROM media_library "
                "  WHERE person IS NOT NULL AND person != '{not_recognized}'"
                ")",
                fetch=False
            )

        # Reset remaining files to pending — do not touch person[]
        rows = db_query(
            "UPDATE media_library SET status='pending' "
            "WHERE status IN ('ready','searchable','error','pending') RETURNING path",
            fetch=True
        )
        return jsonify({'ok': True, 'count': len(rows), 'removed_missing': len(missing)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/analyzer/trigger-clustering ─────────────────────────
@app.route('/api/analyzer/trigger-clustering', methods=['POST'])
def trigger_clustering():
    """Write a sentinel row to analyzer_log that signals the analyzer to run clustering next loop."""
    try:
        db_query(
            "INSERT INTO analyzer_log (ts, decision, error, next_ts) "
            "VALUES (NOW(), 'cluster_requested', 'NO ERROR', NOW())",
            fetch=False
        )
        return jsonify({'ok': True, 'message': 'Clustering will run on next analyzer loop (≤5s)'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/media/browse ─────────────────────────────────────────
@app.route('/api/media/browse')
def browse():
    rel_path = (request.args.get('path') or '').strip('/')
    try:
        full_path = safe_path(rel_path) if rel_path else os.path.realpath(MEDIA_MOUNT)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    try:
        entries = []
        for entry in os.scandir(full_path):
            s = entry.stat(follow_symlinks=False)
            entries.append({
                'name':  entry.name,
                'type':  'dir' if entry.is_dir() else 'file',
                'size':  s.st_size,
                'mtime': s.st_mtime,
                'ext':   os.path.splitext(entry.name)[1].lower()
            })
        entries.sort(key=lambda x: (x['type'] != 'dir', x['name'].lower()))
        return jsonify({'path': rel_path, 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ── GET /api/media/stream/<path> ─────────────────────────────────
@app.route('/api/media/stream/<path:rel_path>')
def stream_file(rel_path):
    try:
        full_path = safe_path(rel_path)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if not os.path.isfile(full_path):
        return '', 404
    ext  = Path(full_path).suffix.lstrip('.').lower()
    mime = {
        'mp3': 'audio/mpeg', 'flac': 'audio/flac', 'wav': 'audio/wav',
        'ogg': 'audio/ogg', 'aac': 'audio/aac', 'm4a': 'audio/mp4', 'wma': 'audio/x-ms-wma',
    }.get(ext, 'application/octet-stream')
    size = os.path.getsize(full_path)
    range_header = request.headers.get('Range')
    if range_header:
        import re as _re
        m = _re.match(r'bytes=(\d+)-(\d*)', range_header)
        if not m:
            return Response('Invalid Range header', 416, headers={'Content-Range': f'bytes */{size}'})
        start = int(m.group(1))
        end   = int(m.group(2)) if m.group(2) else size - 1
        length = end - start + 1
        def generate():
            with open(full_path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
        return Response(generate(), 206, headers={
            'Content-Range': f'bytes {start}-{end}/{size}',
            'Accept-Ranges': 'bytes', 'Content-Length': str(length),
            'Content-Type': mime,
        })
    return send_from_directory(os.path.dirname(full_path), os.path.basename(full_path), mimetype=mime)


# ── GET /api/media/thumb ──────────────────────────────────────────
@app.route('/api/media/thumb')
def thumb():
    rel_path = (request.args.get('path') or '').lstrip('/')
    if not rel_path:
        return '', 400
    ext = os.path.splitext(rel_path)[1].lower()
    if ext not in IMAGE_EXTS:
        return '', 404
    try:
        full_path = safe_path(rel_path)
    except ValueError:
        return '', 400

    cached = THUMB_CACHE.get(rel_path)
    if cached and time.time() - cached['ts'] < 300:
        THUMB_CACHE.move_to_end(rel_path)
        return Response(cached['data'], mimetype=cached['mime'])

    try:
        with open(full_path, 'rb') as f:
            data = f.read()
        mime = {'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp'}.get(ext.lstrip('.'), 'image/jpeg')
        THUMB_CACHE[rel_path] = {'data': data, 'mime': mime, 'ts': time.time()}
        THUMB_CACHE.move_to_end(rel_path)
        if len(THUMB_CACHE) > THUMB_CACHE_MAX:
            THUMB_CACHE.popitem(last=False)
        return Response(data, mimetype=mime)
    except Exception:
        return '', 404


# ── POST /api/media/play ──────────────────────────────────────────
@app.route('/api/media/play', methods=['POST'])
def play():
    rel_path = (request.json or {}).get('relPath', '').lstrip('/')
    if not rel_path:
        return jsonify({'error': 'relPath required'}), 400
    # Manual single-item play clears any active queue — user's manual
    # selection wins over the running playlist. Watcher thread no-ops
    # next tick when it sees _play_queue is None.
    with _queue_lock:
        globals()['_play_queue'] = None
    try:
        full_path = safe_path(rel_path)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    ext      = Path(rel_path).suffix.lstrip('.') or 'mp4'
    basename = Path(rel_path).stem

    # Audio → Cast → soundbar (TV's UPnP music app is broken for queues).
    # Video → UPnP → TV (works fine).
    is_audio = ('.' + ext.lower()) in AUDIO_EXTS
    dlna_id = minidlna_id(full_path)
    if is_audio:
        if dlna_id:
            url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext}'
        else:
            rel_enc = '/'.join(_urlq(seg) for seg in rel_path.split('/'))
            url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_enc}'
        threading.Thread(target=_cast_play_url, args=(url, basename), daemon=True).start()
    else:
        if not dlna_id:
            return jsonify({'error': f'Not indexed by MiniDLNA: {basename}'}), 404
        threading.Thread(target=_wake_and_play, args=(full_path, ext, basename, dlna_id), daemon=True).start()
    return jsonify({'ok': True, 'item': basename}), 202


# ── POST /api/media/play-number ───────────────────────────────────
@app.route('/api/media/play-number', methods=['POST'])
def play_number():
    try:
        num = int((request.json or {}).get('number', 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'number must be an integer'}), 400
    if not num:
        return jsonify({'error': 'number required'}), 400
    if time.time() - _search_session['timestamp'] > 600:
        return jsonify({'error': 'Search session expired — search again first'}), 400
    item = next((r for r in _search_session['results'] if r.get('number') == num), None)
    if not item:
        return jsonify({'error': f'No item #{num} in current results'}), 404

    full_path = item['path']
    rel_path  = full_path.replace(MEDIA_MOUNT + '/', '')
    ext       = Path(rel_path).suffix.lstrip('.') or 'mp4'
    title     = item.get('title') or Path(rel_path).stem

    try:
        db_query('UPDATE media_library SET last_played=NOW() WHERE path=%s', (full_path,), fetch=False)
    except Exception as e:
        log.debug('last_played update failed: %s', e)

    is_audio = ('.' + ext.lower()) in AUDIO_EXTS
    dlna_id = minidlna_id(full_path)
    if is_audio:
        if dlna_id:
            url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext}'
        else:
            rel_enc = '/'.join(_urlq(seg) for seg in rel_path.split('/'))
            url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_enc}'
        threading.Thread(target=_cast_play_url, args=(url, title), daemon=True).start()
    elif dlna_id:
        threading.Thread(target=_wake_and_play, args=(full_path, ext, title, dlna_id), daemon=True).start()
    else:
        return jsonify({'error': f'Not indexed by MiniDLNA: {title}'}), 404
    return jsonify({'ok': True, 'playing': title, 'number': num}), 202


# ── POST /api/media/show-results ──────────────────────────────────
@app.route('/api/media/show-results', methods=['POST'])
def show_results():
    body    = request.json or {}
    results = body.get('results', [])
    query   = body.get('query', '')
    if not results:
        return jsonify({'error': 'results required'}), 400
    try:
        payload = json.dumps({'query': query, 'results': results})
        r = subprocess.run(
            [VENV_PY, '/opt/media-agent/gen_results.py', payload],
            capture_output=True, text=True, timeout=30
        )
        if r.returncode != 0:
            return jsonify({'error': r.stderr}), 500

        img_url     = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/results-image'
        img_url_xml = xml_escape(img_url)

        dlna_soap('SetAVTransportURI',
            f'<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            f'<InstanceID>0</InstanceID><CurrentURI>{img_url_xml}</CurrentURI>'
            f'<CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>'
        )
        time.sleep(0.5)
        dlna_soap('Play',
            '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>'
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/media/position ───────────────────────────────────────
@app.route('/api/media/position')
def position():
    try:
        _ok, xml = dlna_soap('GetPositionInfo',
            '<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:GetPositionInfo>'
        )
        def parse_secs(t):
            try:
                p = (t or '').split(':')
                return int(p[0])*3600 + int(p[1])*60 + int(p[2]) if len(p) == 3 else 0
            except (ValueError, IndexError):
                return 0

        dur_str = (re.search(r'<TrackDuration[^>]*>([^<]+)<', xml) or [None, '0:00:00'])[1]
        pos_str = (re.search(r'<RelTime[^>]*>([^<]+)<', xml) or [None, '0:00:00'])[1]
        dur_s   = parse_secs(dur_str)
        pos_s   = parse_secs(pos_str)
        return jsonify({
            'position': pos_s, 'duration': dur_s,
            'posStr': pos_str, 'durStr': dur_str,
            'percent': round(pos_s / dur_s * 100) if dur_s > 0 else 0
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/media/pause ─────────────────────────────────────────
@app.route('/api/media/pause', methods=['POST'])
def pause():
    try:
        dlna_soap('Pause',
            '<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:Pause>'
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/media/resume ────────────────────────────────────────
@app.route('/api/media/resume', methods=['POST'])
def resume():
    try:
        dlna_soap('Play',
            '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>'
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/media/seek ──────────────────────────────────────────
@app.route('/api/media/seek', methods=['POST'])
def seek():
    try:
        secs = max(0, int((request.json or {}).get('to', 0)))
    except (TypeError, ValueError):
        return jsonify({'error': 'to must be an integer (seconds)'}), 400
    h      = secs // 3600
    m      = (secs % 3600) // 60
    s      = secs % 60
    target = f'{h}:{m:02d}:{s:02d}'
    try:
        dlna_soap('Seek',
            f'<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            f'<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{target}</Target></u:Seek>'
        )
        return jsonify({'ok': True, 'target': target})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/media/stop ──────────────────────────────────────────
@app.route('/api/media/stop', methods=['POST'])
def stop():
    try:
        dlna_soap('Stop',
            '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:Stop>'
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── GET /api/media/results-image ─────────────────────────────────
@app.route('/api/media/results-image')
def results_image():
    png_path = '/mnt/media/tmp/search_results.png'
    if not os.path.isfile(png_path):
        return '', 404
    return send_file(png_path, mimetype='image/png')


# ── Playlists CRUD (Phase 1) ─────────────────────────────────────
# User-created playlists of /mnt/media items. Items stored as JSONB
# array of {path, title, type, duration_sec?}. Playback wiring lives
# in a separate Phase 2 (queue manager + auto-advance via DLNA event
# subscription).

@app.route('/api/playlists', methods=['GET'])
def playlists_list():
    try:
        rows = db_query(
            "SELECT id, name, description, items, "
            "  jsonb_array_length(items) AS item_count, "
            "  created_at, updated_at "
            "FROM media_playlists ORDER BY updated_at DESC"
        )
        return jsonify(rows)
    except Exception as e:
        log.exception('playlists_list')
        return jsonify({'error': str(e)}), 500


@app.route('/api/playlists', methods=['POST'])
def playlists_create():
    body = request.get_json(silent=True) or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    description = body.get('description') or None
    items = body.get('items') or []
    if not isinstance(items, list):
        return jsonify({'error': 'items must be an array'}), 400
    try:
        rows = db_query(
            "INSERT INTO media_playlists (name, description, items) "
            "VALUES (%s, %s, %s::jsonb) RETURNING id, name, items, created_at",
            (name, description, json.dumps(items)),
        )
        if not rows:
            return jsonify({'error': 'insert returned no rows'}), 500
        return jsonify(rows[0])
    except Exception as e:
        log.exception('playlists_create')
        return jsonify({'error': str(e)}), 500


@app.route('/api/playlists/<int:pid>', methods=['PATCH'])
def playlists_update(pid):
    body = request.get_json(silent=True) or {}
    sets, params = [], []
    if 'name' in body:
        v = (body['name'] or '').strip()
        if not v:
            return jsonify({'error': 'name cannot be empty'}), 400
        sets.append('name = %s'); params.append(v)
    if 'description' in body:
        sets.append('description = %s'); params.append(body['description'] or None)
    if 'items' in body:
        if not isinstance(body['items'], list):
            return jsonify({'error': 'items must be an array'}), 400
        sets.append('items = %s::jsonb'); params.append(json.dumps(body['items']))
    if not sets:
        return jsonify({'error': 'no fields to update'}), 400
    sets.append('updated_at = NOW()')
    params.append(pid)
    try:
        rows = db_query(
            f"UPDATE media_playlists SET {', '.join(sets)} WHERE id = %s "
            "RETURNING id, name, description, items, updated_at",
            tuple(params),
        )
        if not rows:
            return jsonify({'error': 'playlist not found'}), 404
        return jsonify(rows[0])
    except Exception as e:
        log.exception('playlists_update')
        return jsonify({'error': str(e)}), 500


@app.route('/api/playlists/<int:pid>', methods=['DELETE'])
def playlists_delete(pid):
    try:
        rows = db_query(
            "DELETE FROM media_playlists WHERE id = %s RETURNING id",
            (pid,),
        )
        if not rows:
            return jsonify({'error': 'playlist not found'}), 404
        return jsonify({'ok': True, 'deleted_id': pid})
    except Exception as e:
        log.exception('playlists_delete')
        return jsonify({'error': str(e)}), 500


# ── Queue manager + playback ────────────────────────────────────
# Single in-memory queue (one playback target at a time). Audio plays
# through the soundbar via Cast (gapless auto-advance via the Cast media
# status FINISHED event). Single-item /api/media/play clears the queue so
# manual selection wins over queue.

_queue_lock = threading.Lock()
_play_queue = None                       # dict or None


# ── Chromecast (Samsung Soundbar) audio playback ─────────────────────
# The TV's UPnP music app can't switch tracks mid-session. Soundbar speaks
# the Cast protocol natively, which has reliable queue + gapless playback.
# Audio plays here; video still goes to the TV via UPnP.
import pychromecast
_cast_lock = threading.Lock()
_cast_obj = None   # pychromecast.Chromecast singleton
_cast_browser = None
_cast_status_listener = None


class _CastStatusListener:
    """Catches Cast media-status updates. Advance to the next queue item
    only when the CURRENT track has been observed PLAYING and then
    transitions to IDLE with FINISHED reason. The 'saw_playing for this
    track' gate stops rapid spurious advances during track-load
    transitions (Cast briefly hits IDLE between SetMedia calls)."""
    def __init__(self):
        self._saw_playing_for_idx = None  # which queue idx we've confirmed playing for
    def new_media_status(self, status):
        cur = getattr(status, 'player_state', None)
        # Snapshot current queue idx under the lock — we may need it twice.
        with _queue_lock:
            q_idx = _play_queue.get('current_idx') if _play_queue else None
        if cur == 'PLAYING' and q_idx is not None:
            self._saw_playing_for_idx = q_idx
            return
        if cur == 'IDLE':
            reason = getattr(status, 'idle_reason', None)
            # Advance only if we previously confirmed PLAYING for THIS idx
            # AND Cast reports the track actually finished.
            if (reason == 'FINISHED'
                    and q_idx is not None
                    and self._saw_playing_for_idx == q_idx):
                self._saw_playing_for_idx = None  # disarm until next track plays
                try:
                    _cast_advance_queue()
                except Exception:
                    log.exception('cast: advance after FINISHED failed')
    def load_media_failed(self, item, error_code):
        log.warning(f"cast: load_media_failed item={item} err={error_code}")


def _get_cast():
    """Return a live Chromecast object. Reconnects on disconnect. Caches
    the connection module-level so we don't pay discovery cost per call."""
    global _cast_obj, _cast_browser, _cast_status_listener
    with _cast_lock:
        if _cast_obj is not None:
            try:
                # cheap liveness probe
                if _cast_obj.socket_client and _cast_obj.socket_client.is_connected:
                    return _cast_obj
            except Exception:
                pass
            try:
                _cast_obj.disconnect(blocking=False)
            except Exception:
                pass
            _cast_obj = None
        chromecasts, browser = pychromecast.get_listed_chromecasts(
            friendly_names=[SOUNDBAR_NAME],
            known_hosts=[SOUNDBAR_IP],
        )
        if not chromecasts:
            raise RuntimeError(f'Soundbar not discoverable at {SOUNDBAR_IP}')
        cast = chromecasts[0]
        cast.wait(timeout=15)
        listener = _CastStatusListener()
        cast.media_controller.register_status_listener(listener)
        _cast_obj = cast
        _cast_browser = browser
        _cast_status_listener = listener
        log.info(f"cast: connected to {cast.name}")
        return cast


def _cast_play_url(url, title, mime='audio/mpeg'):
    """Single-track play on the soundbar. Blocks briefly until Cast accepts
    the URL (no waiting for actual audio to start — Cast handles that)."""
    cast = _get_cast()
    mc = cast.media_controller
    mc.play_media(url, mime, title=title)
    try:
        mc.block_until_active(timeout=10)
    except Exception:
        log.warning('cast: block_until_active timed out (Cast may still be starting)')


def _cast_advance_queue():
    """Called by the Cast status listener when a track finishes naturally.
    Plays the next item in our in-memory _play_queue (or loops/clears)."""
    with _queue_lock:
        if not _play_queue:
            return
        cur = _play_queue['current_idx']
        items = _play_queue['items']
        repeat = _play_queue['repeat']
        next_idx = cur + 1
        if next_idx >= len(items):
            if repeat:
                next_idx = 0
            else:
                log.info('cast: playlist finished — clearing queue')
                globals()['_play_queue'] = None
                return
    _play_queue_item_cast(next_idx)


def _play_queue_item_cast(idx):
    """Play queue item idx through Cast (audio) or fall back to UPnP (video).
    Updates _play_queue['current_idx'] under the lock and fires _cast_play_url
    or _wake_and_play as appropriate. No TV-side Stop / KEY_RETURN gymnastics
    needed because Cast handles track switching cleanly."""
    with _queue_lock:
        if not _play_queue or idx < 0 or idx >= len(_play_queue['items']):
            return False
        item = _play_queue['items'][idx]
        _play_queue['current_idx'] = idx
        _play_queue['started_at'] = time.time()
        _play_queue['current_path'] = item.get('path', '')
        _total = len(_play_queue['items'])
    path = item.get('path', '')
    if not path or not os.path.isfile(path):
        log.warning(f"cast: file missing, skipping — {path}")
        # Auto-skip to next track instead of stalling.
        with _queue_lock:
            total = _total
            repeat = _play_queue['repeat'] if _play_queue else False
        next_idx = idx + 1
        if next_idx >= total:
            if repeat:
                return _play_queue_item_cast(0)
            with _queue_lock:
                globals()['_play_queue'] = None
            return False
        return _play_queue_item_cast(next_idx)
    ext_dot = os.path.splitext(path)[1].lower()
    title = item.get('title') or os.path.basename(path)
    try:
        if ext_dot in AUDIO_EXTS:
            # Audio → Cast → soundbar. Use MiniDLNA URL when indexed (more
            # robust MIME / Range handling than our Flask stream).
            dlna_id = minidlna_id(path)
            if dlna_id:
                ext_bare = ext_dot.lstrip('.') or 'mp3'
                url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext_bare}'
            else:
                rel = path[len(MEDIA_MOUNT):].lstrip('/') if path.startswith(MEDIA_MOUNT) else path.lstrip('/')
                rel_enc = '/'.join(_urlq(seg) for seg in rel.split('/'))
                url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_enc}'
            _cast_play_url(url, title)
            log.info(f"cast: playing {idx + 1}/{_total} — {title}")
        else:
            # Video → existing UPnP path to TV.
            dlna_id = minidlna_id(path)
            if not dlna_id:
                log.warning(f"queue: no DLNA id for {path} — stopping queue")
                with _queue_lock:
                    globals()['_play_queue'] = None
                return False
            ext_bare = ext_dot.lstrip('.') or 'mp4'
            threading.Thread(target=_wake_and_play, args=(path, ext_bare, title, dlna_id), daemon=True).start()
            log.info(f"queue: dispatched (TV) {idx + 1}/{_total} — {title}")
        return True
    except Exception:
        log.exception('cast: play failed')
        return False


def _get_transport_state():
    """Query Samsung TV via DLNA GetTransportInfo. Returns PLAYING / STOPPED /
    PAUSED_PLAYBACK / TRANSITIONING / NO_MEDIA_PRESENT / UNKNOWN."""
    body = ('<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:GetTransportInfo>')
    try:
        _ok, resp = dlna_soap('GetTransportInfo', body)
        m = re.search(r'<CurrentTransportState>([^<]+)</CurrentTransportState>', resp or '')
        if m:
            return m.group(1).strip()
    except Exception:
        log.exception('_get_transport_state')
    return 'UNKNOWN'




@app.route('/api/playlists/<int:pid>/play', methods=['POST'])
def playlist_play(pid):
    """Start playing a playlist. Body: {shuffle?: bool, repeat?: bool,
    start_idx?: int}. Sets up the queue + starts the first track via DLNA."""
    body = request.get_json(silent=True) or {}
    shuffle = bool(body.get('shuffle', False))
    repeat = bool(body.get('repeat', False))
    start_idx = int(body.get('start_idx', 0) or 0)
    try:
        rows = db_query(
            "SELECT name, items FROM media_playlists WHERE id = %s",
            (pid,),
        )
        if not rows:
            return jsonify({'error': 'playlist not found'}), 404
        name = rows[0]['name']
        items = rows[0]['items']
        if not isinstance(items, list) or not items:
            return jsonify({'error': 'playlist is empty'}), 400
        play_items = list(items)
        if shuffle:
            random.shuffle(play_items)
        if not (0 <= start_idx < len(play_items)):
            start_idx = 0
        with _queue_lock:
            globals()['_play_queue'] = {
                'playlist_id':   pid,
                'playlist_name': name,
                'items':         play_items,
                'current_idx':   start_idx,
                'shuffle':       shuffle,
                'repeat':        repeat,
                'started_at':    time.time(),
                'current_path':  play_items[start_idx].get('path', ''),
            }
        # Apply preset volume before playback starts — soundbar's Cast
        # reference level is hot, so each playlist starts at the user's
        # preferred level instead of whatever the last session left.
        try:
            preset = _get_cast_preset_volume()
            cast = _get_cast()
            cast.set_volume(preset)
        except Exception:
            log.exception('cast preset volume apply')
        # No watcher needed — Cast's media-status listener handles
        # end-of-track and triggers _cast_advance_queue() natively.
        _play_queue_item_cast(start_idx)
        return jsonify({
            'ok':           True,
            'playlist_id':  pid,
            'queue_size':   len(play_items),
            'current_idx':  start_idx,
            'current_item': play_items[start_idx],
            'shuffle':      shuffle,
            'repeat':       repeat,
        })
    except Exception as e:
        log.exception('playlist_play')
        return jsonify({'error': str(e)}), 500


def _get_cast_preset_volume():
    """Read preset start volume from dashboard_settings. Stored as a float
    string 0.0-1.0 under key 'media.cast_preset_volume'. Defaults to 0.3
    (soundbar's Cast loudness reference is hot — 30% feels close to TV
    speaker level)."""
    try:
        rows = db_query("SELECT value FROM dashboard_settings WHERE key = 'media.cast_preset_volume'")
        if rows and rows[0].get('value'):
            return max(0.0, min(1.0, float(rows[0]['value'])))
    except Exception:
        log.exception('preset volume read')
    return 0.3


def _set_cast_preset_volume(level):
    db_query(
        "INSERT INTO dashboard_settings (key, value) VALUES ('media.cast_preset_volume', %s) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (str(level),),
        fetch=False,
    )


@app.route('/api/cast/volume', methods=['GET', 'POST'])
def cast_volume():
    """GET → current Cast app volume + preset (0.0-1.0).
    POST → set Cast app volume; optionally body.save=true to persist as preset.
    Cast volume is independent of soundbar's physical buttons — adjusting
    here keeps the Cast session alive."""
    if request.method == 'POST':
        body = request.get_json(silent=True) or {}
        try:
            level = float(body.get('level', 0.3))
        except (TypeError, ValueError):
            return jsonify({'error': 'level must be a number 0..1'}), 400
        level = max(0.0, min(1.0, level))
        try:
            cast = _get_cast()
            cast.set_volume(level)
        except Exception as e:
            return jsonify({'error': f'cast unavailable: {e}'}), 503
        if body.get('save'):
            try:
                _set_cast_preset_volume(level)
            except Exception:
                log.exception('preset volume save')
        return jsonify({'ok': True, 'level': level})
    # GET
    preset = _get_cast_preset_volume()
    try:
        cast = _get_cast()
        cur = float(getattr(cast.status, 'volume_level', preset) or preset)
    except Exception:
        cur = preset
    return jsonify({'level': cur, 'preset': preset})


@app.route('/api/queue/mode', methods=['POST'])
def queue_mode():
    """Update shuffle/repeat on the ACTIVE queue mid-playback. Allows the
    card toggles to affect the running queue, not just the next Play click.
    Body: {shuffle?: bool, repeat?: bool, playlist_id?: int}. When
    playlist_id is given, the update is ignored if the active queue is
    for a different playlist (so toggling Card B doesn't change Card A's
    running queue)."""
    body = request.get_json(silent=True) or {}
    with _queue_lock:
        if not _play_queue:
            return jsonify({'ok': True, 'active': False})
        pid_filter = body.get('playlist_id')
        if pid_filter is not None and int(pid_filter) != _play_queue.get('playlist_id'):
            return jsonify({'ok': True, 'active': False, 'reason': 'different playlist'})
        if 'shuffle' in body:
            _play_queue['shuffle'] = bool(body['shuffle'])
        if 'repeat' in body:
            _play_queue['repeat'] = bool(body['repeat'])
        return jsonify({
            'ok':      True,
            'active':  True,
            'shuffle': _play_queue['shuffle'],
            'repeat':  _play_queue['repeat'],
        })


@app.route('/api/queue/status', methods=['GET'])
def queue_status():
    with _queue_lock:
        if not _play_queue:
            return jsonify({'active': False})
        items = _play_queue['items']
        cur = _play_queue['current_idx']
        cast_vol = None
        cast_pos = None
        cast_dur = None
        cast_state = None
        try:
            cast = _get_cast()
            cast_vol = float(getattr(cast.status, 'volume_level', 0.0) or 0.0)
            mc = cast.media_controller
            # Force a fresh GET_STATUS request — without this, current_time
            # only updates when Cast pushes status (sporadic during playback),
            # so polling returns stale 0s and the client-side progress bar
            # keeps resetting.
            try:
                mc.update_status()
            except Exception:
                pass
            ms = mc.status
            cast_pos = float(getattr(ms, 'current_time', 0) or 0)
            cast_dur = float(getattr(ms, 'duration', 0) or 0)
            cast_state = getattr(ms, 'player_state', None)
        except Exception:
            pass
        return jsonify({
            'active':        True,
            'playlist_id':   _play_queue['playlist_id'],
            'playlist_name': _play_queue['playlist_name'],
            'current_idx':   cur,
            'total':         len(items),
            'current_item':  items[cur] if 0 <= cur < len(items) else None,
            'shuffle':       _play_queue['shuffle'],
            'cast_volume':   cast_vol,
            'cast_position': cast_pos,
            'cast_duration': cast_dur,
            'cast_state':    cast_state,
            'repeat':        _play_queue['repeat'],
        })


@app.route('/api/queue/next', methods=['POST'])
def queue_next():
    with _queue_lock:
        if not _play_queue:
            return jsonify({'error': 'no active queue'}), 400
        cur = _play_queue['current_idx']
        items = _play_queue['items']
        repeat = _play_queue['repeat']
    next_idx = cur + 1
    if next_idx >= len(items):
        if not repeat:
            return jsonify({'error': 'end of playlist'}), 400
        next_idx = 0
    # Cast handles mid-queue switches natively — no Stop+wait needed.
    _play_queue_item_cast(next_idx)
    return jsonify({'ok': True, 'current_idx': next_idx})


@app.route('/api/queue/prev', methods=['POST'])
def queue_prev():
    with _queue_lock:
        if not _play_queue:
            return jsonify({'error': 'no active queue'}), 400
        cur = _play_queue['current_idx']
    if cur <= 0:
        return jsonify({'error': 'at start of playlist'}), 400
    _play_queue_item_cast(cur - 1)
    return jsonify({'ok': True, 'current_idx': cur - 1})


@app.route('/api/queue/stop', methods=['POST'])
def queue_stop():
    with _queue_lock:
        globals()['_play_queue'] = None
    # Stop Cast playback on the soundbar.
    try:
        cast = _get_cast()
        cast.media_controller.stop()
    except Exception:
        log.exception('queue_stop: cast stop failed')
    # Also stop UPnP on the TV in case a video was playing.
    try:
        body = ('<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                '<InstanceID>0</InstanceID></u:Stop>')
        dlna_soap('Stop', body)
    except Exception:
        pass
    return jsonify({'ok': True})




if __name__ == '__main__':
    log.info(f'Player service starting on port {PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=False)
