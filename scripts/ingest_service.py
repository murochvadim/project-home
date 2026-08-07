#!/usr/bin/env python3
"""
Ingest Service — LXC 100
Handles media ingestion: scan /mnt/media/, upload files, library CRUD edits.
Inserts new files as status='pending' — analyzer picks them up.
Runs as systemd service: ingest.service
Port: 8767
"""
import os, json, logging, subprocess, threading, time, hashlib
from collections import OrderedDict
from pathlib import Path
from urllib.parse import unquote
from flask import Flask, jsonify, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

PORT             = 8767
MEDIA_MOUNT      = '/mnt/media'
MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024  # 20 GB

app = Flask(__name__)
CORS(app)
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_BYTES
DB_HOST     = '192.168.1.219'
DB_NAME     = 'home_data'
DB_USER     = 'postgres'
DB_PASS     = os.environ.get('DB_PASS', '')
VENV_PY     = '/opt/media-agent/venv/bin/python3'

VIDEO_EXTS     = {'.mp4', '.mkv', '.avi', '.mov', '.ts', '.wmv', '.m4v', '.flv'}
IMAGE_EXTS     = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}
AUDIO_EXTS     = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}
SUPPORTED_EXTS = VIDEO_EXTS | IMAGE_EXTS | AUDIO_EXTS
EXCLUDED_DIRS  = {'.faces', 'tmp'}


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
    bad = False
    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params or ())
                if fetch:
                    return [dict(r) for r in cur.fetchall()]
                return None
    except Exception:
        bad = True
        raise
    finally:
        # try/except/else here would never reach `else` (returns happen inside
        # try) — that's the bug that exhausted the pool after ~5 calls.
        pool.putconn(conn, close=bad)


# ── Path safety helper ───────────────────────────────────────────
def safe_path(rel, base=MEDIA_MOUNT):
    real_base = os.path.realpath(base)
    # Callers send either a path relative to MEDIA_MOUNT (legacy upload flow)
    # or a full path already under it (dashboard edit/delete modal). Detect
    # which and avoid double-prefixing — the previous join('/mnt/media',
    # '/mnt/media/...'.lstrip('/')) yielded '/mnt/media/mnt/media/...' and
    # silently broke DELETE / PATCH for any file referenced by full path.
    if os.path.isabs(rel):
        full = os.path.realpath(rel)
    else:
        full = os.path.realpath(os.path.join(base, rel.lstrip('/')))
    if full != real_base and not full.startswith(real_base + '/'):
        raise ValueError(f'Path traversal attempt: {rel!r}')
    return full


# ── Ingest state ─────────────────────────────────────────────────
_ingest_queue    = []
_ingest_running  = False
_ingest_lock     = threading.Lock()
_ingest_progress = {'total': 0, 'done': 0, 'errors': 0, 'running': False, 'current': None}


# ── SHA256 of a file (only computed for NEW files, in the worker) ──
def sha256(path, chunk=1048576):
    h = hashlib.sha256()
    try:
        with open(path, 'rb') as f:
            while True:
                data = f.read(chunk)
                if not data:
                    break
                h.update(data)
        return h.hexdigest()
    except Exception:
        return None


def _analyzer_auto_on():
    """True when the analyzer's Auto Mode is enabled (analyzer_settings.auto_enabled=1).

    When Auto Mode is OFF, ingest marks new files 'ready' instead of 'pending' so
    the analyzer skips them entirely and the pipeline panel stays green — mirrors
    the analyzer's own master switch (analyzer.py: `if not auto_enabled: idle`).
    ⚠ Consequence: a file ingested while Auto is off is NOT queued, so turning Auto
    back on later will NOT retro-analyze it — it needs a manual Re-run to requeue.
    Fail-safe: on any read error, behave as before (auto ON → 'pending')."""
    try:
        rows = db_query("SELECT value FROM analyzer_settings WHERE key = 'auto_enabled'")
        if not rows:
            return True
        return str(rows[0]['value']).strip() not in ('0', '', 'false', 'False')
    except Exception:
        return True


# ── Ingest one file — 'ready' when Auto Mode off (skip analyzer), else 'pending' ─
def ingest_file(full_path, file_hash, size_bytes):
    rows = db_query('SELECT path FROM media_library WHERE file_hash = %s', (file_hash,))
    if rows:
        return {'skipped': 'duplicate', 'existing': rows[0]['path']}
    ext       = Path(full_path).suffix.lower()
    raw_title = Path(full_path).stem
    file_type = 'audio' if ext in AUDIO_EXTS else ('image' if ext in IMAGE_EXTS else 'video')
    # Auto Mode OFF → 'ready' (skip the analyzer); ON → 'pending' (analyzer picks it up).
    status = 'pending' if _analyzer_auto_on() else 'ready'
    db_query(
        'INSERT INTO media_library (path, title, type, size_bytes, file_hash, status) '
        'VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (file_hash) DO NOTHING',
        (full_path, raw_title, file_type, size_bytes, file_hash, status),
        fetch=False
    )
    return {'ok': True, 'path': full_path}


# ── Ingest worker ─────────────────────────────────────────────────
# Hashes each NEW file here (off the request thread) then registers it. Only new
# files reach the queue — see scan() — so the expensive SHA256 runs on the small
# backlog, never the whole 97 GB library. This is what un-stalls the pipeline.
def run_ingest_worker():
    global _ingest_running
    # _ingest_running already set True by caller before thread start
    _ingest_progress['running'] = True
    try:
        while True:
            with _ingest_lock:
                if not _ingest_queue:
                    break
                item = _ingest_queue.pop(0)
            _ingest_progress['current'] = Path(item['path']).name
            try:
                h = sha256(item['path'])
                if not h:
                    raise IOError('hash failed (unreadable/vanished)')
                ingest_file(item['path'], h, item['size_bytes'])
            except Exception as e:
                log.error(f'ingest_file error for {item.get("path")}: {e}')
                _ingest_progress['errors'] += 1
            _ingest_progress['done'] += 1
    finally:
        _ingest_progress['current'] = None
        _ingest_progress['running'] = False
        _ingest_running = False


# ── Health ────────────────────────────────────────────────────────
@app.route('/health')
def health():
    try:
        db_query('SELECT 1')
        db_ok = True
    except Exception:
        db_ok = False
    return jsonify({
        'ok': db_ok, 'service': 'ingest', 'port': PORT,
        'db': 'ok' if db_ok else 'error',
        'scanning': _ingest_progress['running'],
        'scan_progress': _ingest_progress,
    })


# ── POST /api/media/scan ─────────────────────────────────────────
# INCREMENTAL scan (2026-08-05 rewrite). The old path shelled out to
# scan_library.py which SHA256-hashed the ENTIRE ~97 GB library on every run —
# that exceeded the 600 s subprocess timeout, so POST /scan 500'd and NOTHING was
# ingested after 2026-07-04 (and cron stacked ~10 concurrent scans because the
# "running" flag was set only AFTER the slow subprocess). Now: set the guard
# FIRST, do a cheap walk+stat (~0.6 s, NO hashing), diff by PATH against
# media_library (path is the PK), queue only NEW paths, and hash them in the
# background worker. A scan returns in ~1 s and can never hit the timeout.
@app.route('/api/media/scan', methods=['POST'])
def scan():
    global _ingest_running
    if _ingest_running:
        return jsonify({'ok': False, 'message': 'Scan already running', 'progress': _ingest_progress})
    _ingest_running = True   # GUARD FIRST — before any slow work — so cron re-POSTs can't stack scans
    try:
        # Cheap discovery: walk + stat only (no hashing). Same excludes as scan_library.py.
        found = {}   # path -> size_bytes
        for root, dirs, files in os.walk(MEDIA_MOUNT):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in EXCLUDED_DIRS]
            for fname in files:
                if fname.startswith('.'):
                    continue
                if os.path.splitext(fname)[1].lower() not in SUPPORTED_EXTS:
                    continue
                full = os.path.join(root, fname)
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    continue
                if sz == 0:
                    continue
                found[full] = sz

        # Diff by PATH (path is the media_library PK). New path -> ingest; known path -> skip.
        known = {row['path'] for row in db_query('SELECT path FROM media_library')}
        new_files = [{'path': p, 'size_bytes': s} for p, s in found.items() if p not in known]

        with _ingest_lock:
            _ingest_queue.clear()
            _ingest_queue.extend(new_files)
        _ingest_progress['total']   = len(new_files)
        _ingest_progress['done']    = 0
        _ingest_progress['errors']  = 0
        _ingest_progress['current'] = None

        if new_files:
            # Worker hashes each new file then registers it; its finally clears _ingest_running.
            threading.Thread(target=run_ingest_worker, daemon=True).start()
        else:
            _ingest_running = False   # nothing to do — release the guard now
        return jsonify({'ok': True, 'found': len(found), 'queued': len(new_files), 'progress': _ingest_progress})
    except Exception as e:
        _ingest_running = False       # release the guard on any failure before the worker starts
        log.error(f'scan error: {e}', exc_info=True)
        return jsonify({'error': 'scan failed — check server logs'}), 500


# ── GET /api/media/scan/progress ─────────────────────────────────
@app.route('/api/media/scan/progress')
def scan_progress():
    return jsonify(_ingest_progress)


# ── POST /api/media/upload ────────────────────────────────────────
@app.route('/api/media/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f          = request.files['file']
    rel_file   = (request.form.get('relativePath') or f.filename or '').lstrip('/')
    ext        = Path(rel_file).suffix.lower()
    if ext not in SUPPORTED_EXTS:
        return jsonify({'error': f'Unsupported file type: {ext!r}'}), 400
    target_dir = (request.form.get('targetPath') or '').strip('/')
    if not target_dir:
        # Auto-route by extension when caller didn't supply targetPath.
        # Keeps root clean — uploads land in Music/Videos/Photos by type.
        # Type-based routing matches the 2026-05-17 migration that split
        # the legacy flat /mnt/media/ layout into 3 typed top-level folders.
        if ext in AUDIO_EXTS:   target_dir = 'Music'
        elif ext in VIDEO_EXTS: target_dir = 'Videos'
        elif ext in IMAGE_EXTS: target_dir = 'Photos'
    combined   = os.path.join(target_dir, rel_file) if target_dir else rel_file
    try:
        remote_path = safe_path(combined)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    remote_dir = os.path.dirname(remote_path)
    try:
        os.makedirs(remote_dir, exist_ok=True)
        f.save(remote_path)
        return jsonify({'ok': True, 'path': remote_path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── PATCH /api/media/library ──────────────────────────────────────
@app.route('/api/media/library', methods=['PATCH'])
def library_update():
    raw_path = request.args.get('path', '')
    if not raw_path:
        return jsonify({'error': 'path required'}), 400
    try:
        file_path = safe_path(raw_path, MEDIA_MOUNT)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    body = request.json or {}
    person = body.get('person') or None
    if person is not None:
        if not isinstance(person, list) or not all(isinstance(p, str) and 0 < len(p) <= 50 for p in person):
            return jsonify({'error': 'person must be a list of non-empty strings (max 50 chars each)'}), 400
    try:
        db_query(
            'UPDATE media_library SET '
            'person=COALESCE(%s,person), event=COALESCE(%s,event), year=COALESCE(%s,year), '
            'location=COALESCE(%s,location), search_text=COALESCE(%s,search_text) '
            'WHERE path=%s',
            (person, body.get('event') or None, body.get('year') or None,
             body.get('location') or None, body.get('search_text') or None, file_path),
            fetch=False
        )
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── DELETE /api/media/library ─────────────────────────────────────
@app.route('/api/media/library', methods=['DELETE'])
def library_delete():
    raw_path = request.args.get('path', '')
    if not raw_path:
        return jsonify({'error': 'path required'}), 400
    try:
        file_path = safe_path(raw_path, MEDIA_MOUNT)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    try:
        # Collect person names for this file BEFORE deletion
        name_rows = db_query(
            'SELECT DISTINCT person_name FROM face_crops WHERE file_path=%s AND person_name IS NOT NULL',
            (file_path,), fetch=True
        )
        affected_names = [r['person_name'] for r in name_rows]

        # Delete face crop images from disk
        crop_rows = db_query('SELECT crop_path FROM face_crops WHERE file_path=%s', (file_path,))
        for c in crop_rows:
            try:
                if c['crop_path']: os.remove(c['crop_path'])
            except Exception:
                pass
        db_query('DELETE FROM face_crops WHERE file_path=%s', (file_path,), fetch=False)
        db_query('DELETE FROM media_library WHERE path=%s', (file_path,), fetch=False)

        # Remove person_embeddings for people with no remaining crops anywhere
        for name in affected_names:
            remaining = db_query(
                'SELECT COUNT(*) as cnt FROM face_crops WHERE person_name=%s',
                (name,), fetch=True
            )
            if remaining and int(remaining[0]['cnt']) == 0:
                db_query('DELETE FROM person_embeddings WHERE name=%s', (name,), fetch=False)

        deleted_file = False
        if os.path.isfile(file_path):
            os.remove(file_path)
            deleted_file = True
        return jsonify({'ok': True, 'deleted_file': deleted_file})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    log.info(f'Ingest service starting on port {PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=False)
