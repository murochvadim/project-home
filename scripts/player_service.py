#!/usr/bin/env python3
"""
Player Service — LXC 100
Handles media browsing, search, playback, faces, library read.
TV/soundbar control proxied to tv_control.py on port 8765.
Runs as systemd service: player.service
Port: 8766
"""
import os, json, logging, subprocess, threading, time, re, sqlite3, signal
import numpy as np
from collections import OrderedDict
from pathlib import Path
from urllib.parse import unquote
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

MINIDLNA_DB = '/var/cache/minidlna/files.db'
MINIDLNA_PID = '/run/minidlna/minidlna.pid'

IMAGE_EXTS     = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}
AUDIO_EXTS     = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}

THUMB_CACHE     = OrderedDict()
THUMB_CACHE_MAX = 200


# ── Search session ───────────────────────────────────────────────
_search_session = {'results': [], 'timestamp': 0}

EMBED_SCRIPT = '/opt/media-agent/embed_crop.py'


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
    full = os.path.realpath(os.path.join(base, rel.lstrip('/')))
    if not full.startswith(os.path.realpath(base)):
        raise ValueError(f'Path traversal attempt: {rel!r}')
    return full


# ── DLNA helpers ──────────────────────────────────────────────────
def dlna_soap(action, body_xml):
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
            ['curl', '-s', '-X', 'POST', TV_URL,
             '-H', 'Content-Type: text/xml; charset="utf-8"',
             '-H', f'SOAPACTION: "urn:schemas-upnp-org:service:AVTransport:1#{action}"',
             '--data', f'@{tmp}'],
            capture_output=True, text=True, timeout=10
        )
        return r.stdout
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
def _wake_and_play(full_path, ext, title, dlna_id, stream_url=None):
    import urllib.request as ureq
    try:
        ureq.urlopen(
            ureq.Request(f'{TV_CONTROL_URL}/media/command',
                         data=json.dumps({'entity': 'tv', 'command': 'turn_on'}).encode(),
                         headers={'Content-Type': 'application/json'}, method='POST'),
            timeout=5
        )
    except Exception:
        pass
    time.sleep(3)
    _audio_exts    = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}
    is_audio       = ('.' + ext.lower()) in _audio_exts
    if stream_url is None:
        stream_url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext}'
    stream_url_xml = xml_escape(stream_url)
    title_xml      = xml_escape(title)
    dlna_class     = 'object.item.audioItem.musicTrack' if is_audio else 'object.item.videoItem'
    dlna_soap('SetAVTransportURI',
        f'<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
        f'<InstanceID>0</InstanceID><CurrentURI>{stream_url_xml}</CurrentURI>'
        f'<CurrentURIMetaData>'
        f'<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        f'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        f'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        f'<item id="{dlna_id or "1"}" parentID="0" restricted="1">'
        f'<dc:title>{title_xml}</dc:title>'
        f'<upnp:class>{dlna_class}</upnp:class>'
        f'<res>{stream_url_xml}</res></item></DIDL-Lite>'
        f'</CurrentURIMetaData></u:SetAVTransportURI>'
    )
    time.sleep(1)
    dlna_soap('Play',
        '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
        '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>'
    )


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
    if not file_path or not os.path.realpath(file_path).startswith(os.path.realpath(MEDIA_MOUNT)):
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
    name      = (body.get('name') or '').strip()
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
        start = int(m.group(1)) if m else 0
        end   = int(m.group(2)) if m and m.group(2) else size - 1
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
    try:
        full_path = safe_path(rel_path)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    ext      = Path(rel_path).suffix.lstrip('.') or 'mp4'
    basename = Path(rel_path).stem

    if ('.' + ext.lower()) in AUDIO_EXTS:
        stream_url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_path}'
        threading.Thread(target=_wake_and_play, args=(full_path, ext, basename, None), kwargs={'stream_url': stream_url}, daemon=True).start()
    else:
        dlna_id = minidlna_id(full_path)
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

    if ('.' + ext.lower()) in AUDIO_EXTS:
        stream_url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_path}'
        threading.Thread(target=_wake_and_play, args=(full_path, ext, title, None), kwargs={'stream_url': stream_url}, daemon=True).start()
    else:
        dlna_id = minidlna_id(full_path)
        if not dlna_id:
            return jsonify({'error': f'Not indexed by MiniDLNA: {title}'}), 404
        threading.Thread(target=_wake_and_play, args=(full_path, ext, title, dlna_id), daemon=True).start()
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
        xml = dlna_soap('GetPositionInfo',
            '<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:GetPositionInfo>'
        )
        def parse_secs(t):
            p = (t or '').split(':')
            return int(p[0])*3600 + int(p[1])*60 + int(p[2]) if len(p) == 3 else 0

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




if __name__ == '__main__':
    log.info(f'Player service starting on port {PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=False)
