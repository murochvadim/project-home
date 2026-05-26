#!/usr/bin/env python3
"""
Analyzer Agent — LXC 100
Picks up status='pending' records from media_library and enriches them:
  Phase 1: Haiku metadata + ffprobe (fast) → status='searchable'
  Phase 2: InsightFace face detection + clustering (slow) → status='ready'
Runs as systemd service: analyzer.service
"""
import os, json, logging, subprocess, threading, time, uuid, re
import concurrent.futures
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────
MEDIA_MOUNT   = '/mnt/media'
FACES_DIR     = '/mnt/media/.faces'
DB_HOST       = '192.168.1.219'
DB_NAME       = 'home_data'
DB_USER       = 'postgres'
DB_PASS       = os.environ.get('DB_PASS', '')
ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
VENV_PY       = '/opt/media-agent/venv/bin/python3'

VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.ts', '.wmv', '.m4v', '.flv'}
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}
AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'}

FACE_TOP_N      = 10    # max faces to keep per file
FACE_CROP_SIZE  = 112   # crop resolution px
CLUSTER_MIN_PTS = 2     # minimum faces to form a cluster
CLUSTER_EVERY   = 10    # run clustering every N files processed
COSINE_MATCH    = 0.45  # cosine similarity threshold to match face to existing named cluster
SLEEP_SEC       = 5     # sleep between files when queue is empty
PHASE_TIMEOUT   = 300   # max seconds per phase before giving up

# ── Settings (read from DB, fall back to these defaults) ──────────
SETTINGS_DEFAULTS = {
    'auto_enabled':        1,
    'auto_frame_interval': 60,
    'auto_face_score_min': 0.60,
    'auto_cluster_every':  10,
    'manual_batch_size':   1,
    'manual_frame_interval': 30,
    'manual_face_score_min': 0.50,
    'manual_cluster_eps':  0.70,
}

def load_settings():
    try:
        rows = db_query("SELECT key, value FROM analyzer_settings")
        s = dict(SETTINGS_DEFAULTS)
        for r in rows:
            k, v = r['key'], r['value']
            if k in s:
                s[k] = type(SETTINGS_DEFAULTS[k])(v)
        return s
    except Exception:
        return dict(SETTINGS_DEFAULTS)

# ── DB pool ───────────────────────────────────────────────────────
import psycopg2, psycopg2.extras, psycopg2.pool

_pool = None
_pool_lock = threading.Lock()

def get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    1, 5,
                    host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS,
                    connect_timeout=10
                )
    return _pool

def db_query(sql, params=None, fetch=True):
    pool = get_pool()
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


# ── Haiku metadata ────────────────────────────────────────────────
def haiku_metadata(raw_title, folder_path):
    import anthropic
    safe_title  = re.sub(r'[^\w\s.\-()\']', ' ', str(raw_title)[:200]).strip()
    safe_folder = re.sub(r'[^\w\s./\-]',    ' ', str(folder_path)[:200]).strip()
    prompt = (
        'You are a media metadata extractor. Given a filename and folder path, '
        'extract metadata and return ONLY a JSON object.\n'
        f'Input: filename="{safe_title}", folder="{safe_folder}"\n'
        'Rules:\n'
        '- person: array of English names (transliterate Hebrew/Russian). Empty array if none.\n'
        '- event: English lowercase (wedding/birthday/vacation/holiday/graduation/etc). null if unclear.\n'
        '- year: integer 4-digit year if found. null if not found.\n'
        '- location: English lowercase city/place. null if unclear.\n'
        '- search_text: space-separated English terms (names + event + location + year)\n'
        'Return ONLY: {"person":[],"event":null,"year":null,"location":null,"search_text":""}'
    )
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
        result = client.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=256,
            messages=[{'role': 'user', 'content': prompt}]
        )
        raw = result.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return json.loads(raw)
    except Exception as e:
        log.warning(f'haiku_metadata failed: {e}')
        return {'person': [], 'event': None, 'year': None, 'location': None, 'search_text': ''}


# ── ffprobe ───────────────────────────────────────────────────────
def ffprobe_info(full_path):
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', full_path],
            capture_output=True, text=True, timeout=60
        )
        probe   = json.loads(r.stdout or '{}')
        streams = probe.get('streams', [])
        video   = next((s for s in streams if s.get('codec_type') == 'video'), None)
        audio   = next((s for s in streams if s.get('codec_type') == 'audio'), None)
        stream  = video or audio or (streams[0] if streams else None)
        duration   = round(float(stream['duration'])) if stream and stream.get('duration') else None
        resolution = f"{video['width']}x{video['height']}" if video else None
        return duration, resolution
    except Exception as e:
        log.warning(f'ffprobe failed for {full_path}: {e}')
        return None, None


# ── InsightFace ───────────────────────────────────────────────────
_app_face = None
_face_lock = threading.Lock()

def get_face_app():
    global _app_face
    if _app_face is None:
        with _face_lock:
            if _app_face is None:
                from insightface.app import FaceAnalysis
                _app_face = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
                _app_face.prepare(ctx_id=0, det_size=(640, 640))
    return _app_face

def detect_faces(img_bgr, face_score_min=0.5):
    """Returns list of faces sorted by bbox area desc, filtered by score."""
    app = get_face_app()
    faces = app.get(img_bgr)
    faces = [f for f in faces if getattr(f, 'det_score', 1.0) >= face_score_min]
    # sort by bbox area descending (largest = closest to camera)
    def bbox_area(f):
        b = f.bbox.astype(int)
        return (b[2] - b[0]) * (b[3] - b[1])
    faces.sort(key=bbox_area, reverse=True)
    return faces[:FACE_TOP_N]

def crop_face(img_bgr, face):
    """Crop face region, resize to 112x112, return as bytes."""
    import cv2, numpy as np
    b = face.bbox.astype(int)
    x1, y1, x2, y2 = max(0, b[0]), max(0, b[1]), min(img_bgr.shape[1], b[2]), min(img_bgr.shape[0], b[3])
    crop = img_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    crop = cv2.resize(crop, (FACE_CROP_SIZE, FACE_CROP_SIZE))
    ok, buf = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return bytes(buf) if ok else None

def save_crop(img_data):
    """Save crop bytes to /mnt/media/.faces/<uuid>.jpg, return filename."""
    os.makedirs(FACES_DIR, exist_ok=True)
    fname = uuid.uuid4().hex + '.jpg'
    fpath = os.path.join(FACES_DIR, fname)
    with open(fpath, 'wb') as f:
        f.write(img_data)
    return fname

def embedding_to_list(emb):
    """Convert numpy embedding to plain Python list."""
    return emb.tolist() if hasattr(emb, 'tolist') else list(emb)

def cosine_sim(a, b):
    import numpy as np
    a, b = np.array(a), np.array(b)
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom > 0 else 0.0


# ── Sample video frames ───────────────────────────────────────────
def sample_video_frames(full_path, duration_sec, frame_interval=30):
    """
    Yield (frame_sec, img_bgr) for 1 frame per 2 min.
    Skips first/last 10s.
    """
    import cv2
    if not duration_sec or duration_sec <= 20:
        # short video — just sample middle
        timestamps = [max(0, (duration_sec or 10) // 2)]
    else:
        start = 10
        end   = duration_sec - 10
        step  = frame_interval
        timestamps = list(range(start, end, step))
        if not timestamps:
            timestamps = [(start + end) // 2]

    cap = cv2.VideoCapture(full_path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        for ts in timestamps:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(ts * fps))
            ok, frame = cap.read()
            if ok and frame is not None:
                yield ts, frame
    finally:
        cap.release()


# ── Match face to existing named clusters ─────────────────────────
def match_named_clusters(embedding):
    """
    Compare embedding against centroids of named clusters.
    Returns person_name if cosine similarity >= COSINE_MATCH, else None.
    """
    # Read named crops + person_embeddings (survives re-run)
    rows = db_query(
        "SELECT person_name, embedding FROM face_crops "
        "WHERE person_name IS NOT NULL AND person_name != '_skipped' "
        "ORDER BY added_at DESC LIMIT 500"
    )
    ref_rows = db_query("SELECT name AS person_name, embedding FROM person_embeddings")
    if not rows and not ref_rows:
        return None
    from collections import defaultdict
    import numpy as np
    groups = defaultdict(list)
    for r in list(rows or []) + list(ref_rows or []):
        if r.get('embedding'):
            groups[r['person_name']].append(r['embedding'])
    best_name, best_sim = None, COSINE_MATCH
    for name, embs in groups.items():
        centroid = np.mean(embs, axis=0)
        sim = cosine_sim(embedding, centroid)
        if sim > best_sim:
            best_sim, best_name = sim, name
    return best_name


# ── Process one file — Phase 1 (metadata) ────────────────────────
def phase1_metadata(path, full_path):
    raw_title   = Path(full_path).stem
    folder_path = str(Path(full_path).parent).replace(MEDIA_MOUNT + '/', '')
    ext         = Path(full_path).suffix.lower()
    file_type   = 'audio' if ext in AUDIO_EXTS else ('image' if ext in IMAGE_EXTS else 'video')

    # Run Haiku + ffprobe in parallel threads
    meta_result   = [None]
    ffprobe_result = [None, None]

    def run_haiku():
        meta_result[0] = haiku_metadata(raw_title, folder_path)

    def run_ffprobe():
        ffprobe_result[0], ffprobe_result[1] = ffprobe_info(full_path)

    t1 = threading.Thread(target=run_haiku)
    t2 = threading.Thread(target=run_ffprobe)
    t1.start(); t2.start()
    t1.join(); t2.join()

    meta     = meta_result[0] or {}
    duration = ffprobe_result[0]
    res      = ffprobe_result[1]

    search_text = meta.get('search_text', '') or ''

    db_query(
        "UPDATE media_library SET "
        "title=%s, type=%s, event=%s, year=%s, location=%s, "
        "search_text=%s, duration_sec=%s, resolution=%s, status='searchable' "
        "WHERE path=%s",
        (raw_title, file_type, meta.get('event'), meta.get('year'), meta.get('location'),
         search_text, duration, res, path),
        fetch=False
    )
    log.info(f'Phase1 done: {raw_title} → searchable')
    return file_type, search_text


# ── Process one file — Phase 2 (face detection) ──────────────────
def phase2_faces(path, full_path, file_type, search_text, face_score_min=0.5, frame_interval=30):
    import cv2
    if file_type == 'audio':
        # no faces in audio
        db_query(
            "UPDATE media_library SET status='ready' WHERE path=%s",
            (path,), fetch=False
        )
        return

    # delete existing face crops for this file before re-processing
    existing = db_query("SELECT crop_path FROM face_crops WHERE file_path=%s", (path,))
    for row in existing:
        try:
            os.remove(row['crop_path'])
        except Exception:
            pass
    db_query("DELETE FROM face_crops WHERE file_path=%s", (path,), fetch=False)

    # collect (frame_sec, img_bgr) to process
    frames_to_process = []
    if file_type == 'image':
        img = cv2.imread(full_path)
        if img is not None:
            frames_to_process.append((None, img))
    else:
        # get duration from DB
        rows = db_query('SELECT duration_sec FROM media_library WHERE path=%s', (path,))
        duration_sec = rows[0]['duration_sec'] if rows else None
        for ts, frame in sample_video_frames(full_path, duration_sec, frame_interval=frame_interval):
            frames_to_process.append((ts, frame))

    persons_found = []
    for frame_sec, img_bgr in frames_to_process:
        try:
            faces = detect_faces(img_bgr, face_score_min=face_score_min)
            for face in faces:
                crop_bytes = crop_face(img_bgr, face)
                if not crop_bytes:
                    continue
                crop_fname = save_crop(crop_bytes)
                emb        = embedding_to_list(face.embedding)
                b          = face.bbox.astype(int)
                x1, y1, x2, y2 = int(b[0]), int(b[1]), int(b[2]), int(b[3])

                # check if matches existing named cluster
                person_name = match_named_clusters(emb)
                if person_name and person_name not in persons_found:
                    persons_found.append(person_name)

                det_score  = float(getattr(face, 'det_score', 0.0))
                db_query(
                    "INSERT INTO face_crops "
                    "(file_path, frame_sec, bbox_x1, bbox_y1, bbox_x2, bbox_y2, "
                    "crop_path, embedding, person_name, det_score) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (path, frame_sec, x1, y1, x2, y2,
                     os.path.join(FACES_DIR, crop_fname), emb, person_name, det_score),
                    fetch=False
                )
                # Update person_embeddings if this crop has higher det_score than stored
                if person_name and emb and det_score > 0:
                    existing_pe = db_query(
                        "SELECT det_score FROM person_embeddings WHERE name=%s",
                        (person_name,), fetch=True
                    )
                    stored_score = (existing_pe[0].get('det_score') or 0.0) if existing_pe else 0.0
                    if det_score > stored_score:
                        db_query(
                            "INSERT INTO person_embeddings (name, embedding, det_score) VALUES (%s,%s,%s) "
                            "ON CONFLICT (name) DO UPDATE SET embedding=EXCLUDED.embedding, det_score=EXCLUDED.det_score, added_at=NOW()",
                            (person_name, emb, det_score), fetch=False
                        )
        except Exception as e:
            log.warning(f'Face detection error on frame {frame_sec} of {path}: {e}')

    # build final person array — merge with existing person[] to preserve names from before re-run
    existing = db_query("SELECT person FROM media_library WHERE path=%s", (path,), fetch=True)
    existing_names = [n for n in (existing[0]['person'] if existing else []) if n and n != 'not_recognized']
    if persons_found:
        merged = list(dict.fromkeys(existing_names + persons_found))  # dedup, preserve order
        new_search = (search_text + ' ' + ' '.join(merged)).strip()
        db_query(
            "UPDATE media_library SET status='ready', person=%s, search_text=%s WHERE path=%s",
            (merged, new_search, path), fetch=False
        )
    else:
        merged = existing_names if existing_names else ['not_recognized']
        db_query(
            "UPDATE media_library SET status='ready', person=%s WHERE path=%s",
            (merged, path), fetch=False
        )
    log.info(f'Phase2 done: {Path(path).name} → persons={persons_found or ["not_recognized"]}')


# ── Phase timeout wrapper ─────────────────────────────────────────
def run_with_timeout(fn, *args, timeout=PHASE_TIMEOUT):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(fn, *args).result(timeout=timeout)


# ── DBSCAN clustering ─────────────────────────────────────────────
_cluster_lock = threading.Lock()

def run_clustering(eps=None):
    if not _cluster_lock.acquire(blocking=False):
        log.info('Clustering already running — skipping')
        return
    try:
        log.info('Running face clustering...')
        rows = db_query(
            "SELECT id, embedding, bbox_x1, bbox_y1, bbox_x2, bbox_y2 "
            "FROM face_crops WHERE cluster_id IS NULL AND array_length(embedding,1)=512"
        )
        if len(rows) < CLUSTER_MIN_PTS:
            log.info(f'Not enough unclustered faces ({len(rows)}) — skipping')
            return

        import numpy as np
        from sklearn.cluster import DBSCAN
        from sklearn.preprocessing import normalize

        ids  = [r['id'] for r in rows]
        embs = np.array([r['embedding'] for r in rows], dtype=float)
        embs_norm = normalize(embs)

        use_eps = eps if eps is not None else CLUSTER_EPS
        labels = DBSCAN(eps=use_eps, min_samples=CLUSTER_MIN_PTS, metric='cosine').fit_predict(embs_norm)

        # assign cluster_ids (offset by current max to avoid collisions)
        max_row = db_query('SELECT COALESCE(MAX(cluster_id), 0) as m FROM face_crops')
        offset  = (max_row[0]['m'] or 0) + 1

        updates = {}
        for face_id, label in zip(ids, labels):
            if label == -1:
                continue  # noise — no cluster
            cluster_id = int(label) + offset
            updates.setdefault(cluster_id, []).append(face_id)

        for cluster_id, face_ids in updates.items():
            db_query(
                "UPDATE face_crops SET cluster_id=%s WHERE id = ANY(%s)",
                (cluster_id, face_ids), fetch=False
            )

        log.info(f'Clustering done: {len(updates)} clusters from {len(rows)} faces')
    finally:
        _cluster_lock.release()

    # propagate already-named clusters to new members
    named = db_query(
        "SELECT DISTINCT cluster_id, person_name FROM face_crops "
        "WHERE cluster_id IS NOT NULL AND person_name IS NOT NULL AND person_name != '_skipped'"
    )
    for row in named:
        cid, name = row['cluster_id'], row['person_name']
        # find files in this cluster that don't have this person yet
        files = db_query(
            "SELECT DISTINCT file_path FROM face_crops WHERE cluster_id=%s", (cid,)
        )
        for f in files:
            db_query(
                "UPDATE media_library SET "
                "person = array_append(person, %s), "
                "search_text = TRIM(REGEXP_REPLACE(search_text || ' ' || %s, '\\s+', ' ', 'g')) "
                "WHERE path=%s AND NOT (%s = ANY(person))",
                (name, name, f['file_path'], name), fetch=False
            )


# ── Log to analyzer_log ───────────────────────────────────────────
def write_log(decision, error='NO ERROR'):
    db_query(
        "INSERT INTO analyzer_log (ts, decision, error, next_ts) "
        "VALUES (NOW(), %s, %s, NOW() + %s * interval '1 second')",
        (decision, error, SLEEP_SEC), fetch=False
    )


# ── Main loop ─────────────────────────────────────────────────────
def main():
    log.info('Analyzer agent starting...')
    # FACES_DIR lives on QNAP NFS share. QNAP's export uses root_squash, so the
    # analyzer's root identity maps to nobody:nogroup on the NFS side. If the
    # directory exists but is owned root:root (a state QNAP can land in after a
    # firmware reset, share rebuild, or manual perm edit via QNAP UI), the
    # analyzer crash-loops with PermissionError on os.makedirs. Self-heal:
    # ensure the dir exists, then explicitly chmod 0o777 so the squashed-to-
    # nobody analyzer can always write. The chmod is a no-op when perms are
    # already correct but force-corrects the squash-permission failure mode
    # without requiring manual QNAP UI intervention. See incident
    # `analyzer_nfs_perm` in memory for the 2026-05-18 → 2026-05-26 outage.
    try:
        os.makedirs(FACES_DIR, exist_ok=True)
    except PermissionError:
        log.warning('FACES_DIR exists but mkdir raised PermissionError — relying on chmod recovery below')
    try:
        os.chmod(FACES_DIR, 0o777)
    except OSError as e:
        log.warning('FACES_DIR chmod failed (%s) — proceeding; writes may fail if perms are restrictive', e)
    processed = 0

    while True:
        try:
            cfg = load_settings()
            auto_enabled   = int(cfg['auto_enabled'])
            batch_size     = int(cfg['manual_batch_size'])
            cluster_eps    = float(cfg['manual_cluster_eps'])
            # if batch_size > 0 (manual mode), use manual settings; else use auto settings
            if batch_size > 0:
                frame_interval = int(cfg['manual_frame_interval'])
                face_score_min = float(cfg['manual_face_score_min'])
            else:
                frame_interval = int(cfg['auto_frame_interval'])
                face_score_min = float(cfg['auto_face_score_min'])

            # if auto mode is disabled and batch_size=0, skip picking new files
            if not auto_enabled and batch_size == 0:
                write_log('idle — auto mode disabled')
                time.sleep(SLEEP_SEC)
                continue

            # pick one pending file
            rows = db_query(
                "UPDATE media_library SET status='processing' "
                "WHERE path = (SELECT path FROM media_library WHERE status='pending' LIMIT 1) "
                "RETURNING path"
            )
            if not rows:
                # check for manual cluster trigger
                trigger = db_query(
                    "DELETE FROM analyzer_log WHERE decision='cluster_requested' "
                    "RETURNING id"
                )
                if trigger:
                    log.info('Manual cluster trigger received — running clustering')
                    run_clustering(eps=cluster_eps)
                    write_log('clustering completed (manual trigger)')
                else:
                    write_log('idle — no pending files')
                time.sleep(SLEEP_SEC)
                continue

            path      = rows[0]['path']
            full_path = path
            log.info(f'Processing: {Path(path).name}')

            try:
                file_type, search_text = run_with_timeout(phase1_metadata, path, full_path)
                phase2_faces(path, full_path, file_type, search_text,
                             face_score_min=face_score_min, frame_interval=frame_interval)

                processed += 1
                write_log(f'processed {Path(path).name}')

                cluster_every = int(cfg.get('auto_cluster_every', CLUSTER_EVERY))
                if processed % cluster_every == 0:
                    run_clustering(eps=cluster_eps)

                # batch_size=0 means unlimited; otherwise pause after N files
                if batch_size > 0 and processed % batch_size == 0:
                    log.info(f'Batch of {batch_size} done — pausing until next pending file')
                    write_log(f'batch pause after {batch_size} files')
                    time.sleep(SLEEP_SEC * 6)  # longer pause between batches

            except Exception as e:
                log.error(f'Error processing {path}: {e}')
                db_query(
                    "UPDATE media_library SET status='error' WHERE path=%s",
                    (path,), fetch=False
                )
                write_log(f'error: {Path(path).name}', f'ERR: {e}')

        except Exception as e:
            log.error(f'Main loop error: {e}')
            time.sleep(SLEEP_SEC)


if __name__ == '__main__':
    main()
