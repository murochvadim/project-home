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

# ── Video playback targets ─────────────────────────────────────────
# More than one TV can render video. dlna_soap() and the bar controls
# (position/pause/resume/seek/stop/show-results) resolve the AVTransport URL
# from _active_video_target, which _wake_and_play sets at the start of every
# play. Default 'tv' (the 85") keeps the historical single-TV path
# BYTE-IDENTICAL until a caller explicitly selects another target — so the
# 85" behaviour cannot regress. 'wake_entity' is the tv_control.py entity used
# to power the TV on before streaming.
# 'audio_sink' decides where a target's AUDIO goes:
#   'cast' → Chromecast on the living-room soundbar (85"/living room)
#   'dlna' → the TV's own speakers, streamed via UPnP/DLNA (Balcony — no soundbar)
# Video audio always comes out of the TV the video plays on, so audio_sink only
# matters for music (single tracks + playlists).
TV_TARGETS = {
    'tv':   {'name': 'Samsung 85" QLED',
             # Play audio through the TV itself (DLNA), exactly like the balcony
             # 55" — NOT cast to the soundbar. The soundbar's Chromecast switches
             # inputs unreliably (music-after-video went silent, no HA control),
             # so per user: play everything on the TV. 2026-07-27.
             'av_url': TV_URL,
             'wake_entity': 'tv',
             'audio_sink': 'dlna'},
    'tv55': {'name': 'Balcony 55" Neo QLED',
             # DLNA cast target. TV is DHCP-RESERVED at .199 (2026-06-26) — WiFi DHCP
             # had drifted .194→.199, silently breaking casts (power still worked via
             # SmartThings cloud, but DLNA needs the live local IP). Keep the reservation.
             'av_url': 'http://192.168.1.199:9197/upnp/control/AVTransport1',
             'wake_entity': 'tv55',
             'audio_sink': 'dlna'},
}
_active_video_target = 'tv'

def _av_url(target=None):
    """Resolve the AVTransport control URL for a target key (or the currently
    active one). Unknown keys fall back to the 85" so a bad value can never
    break playback."""
    t = target or _active_video_target
    return TV_TARGETS.get(t, TV_TARGETS['tv'])['av_url']

def _audio_sink(target=None):
    """'cast' (soundbar) or 'dlna' (the TV's own speakers) for a target."""
    t = target or _active_video_target
    return TV_TARGETS.get(t, TV_TARGETS['tv']).get('audio_sink', 'cast')

# ── Balcony TV (tv55) volume via UPnP RenderingControl ──────────────────────────
# The SmartThings/HA media_player for tv55 REPORTS volume but its volume_set /
# volume_down are silent NO-OPs (dead path — verified live). The TV's OWN UPnP
# RenderingControl works for BOTH GetVolume and SetVolume (0..100), so the panel
# Vol±10 buttons route here instead. RenderingControl1 lives next to AVTransport1
# on the same renderer.
def _tv55_rc_url():
    return TV_TARGETS['tv55']['av_url'].replace('AVTransport1', 'RenderingControl1')

def _rc_soap(action, inner, timeout=6):
    import urllib.request
    env = ('<?xml version="1.0"?>'
           '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
           's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
           + inner + '</s:Body></s:Envelope>').encode('utf-8')
    req = urllib.request.Request(
        _tv55_rc_url(), data=env,
        headers={'Content-Type': 'text/xml; charset="utf-8"',
                 'SOAPACTION': '"urn:schemas-upnp-org:service:RenderingControl:1#%s"' % action},
        method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')

def _tv55_get_volume():
    xml = _rc_soap('GetVolume',
        '<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">'
        '<InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>')
    m = re.search(r'<CurrentVolume>(\d+)</CurrentVolume>', xml)
    return int(m.group(1)) if m else None

def _tv55_set_volume(v):
    v = max(0, min(100, int(v)))
    _rc_soap('SetVolume',
        '<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">'
        '<InstanceID>0</InstanceID><Channel>Master</Channel>'
        '<DesiredVolume>%d</DesiredVolume></u:SetVolume>' % v)
    return v

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
def dlna_soap(action, body_xml, timeout=10, tv_url=None):
    """POST a SOAP body to the active TV's AVTransport endpoint (or an explicit
    tv_url). Returns (ok, body) so callers can detect TV-unreachable failures
    instead of silently treating empty / 5xx responses as success."""
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
            ['curl', '-sS', '--fail-with-body', '-X', 'POST', tv_url or _av_url(),
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


def _wake_and_play(full_path, ext, title, dlna_id, stream_url=None, target='tv'):
    import urllib.request as ureq
    # Select the target TV for THIS play. All subsequent dlna_soap /
    # _get_transport_state / _wait_for_tv_ready calls (and the bar controls)
    # resolve against _active_video_target. Unknown target → 85" fallback.
    globals()['_active_video_target'] = target if target in TV_TARGETS else 'tv'
    wake_entity = TV_TARGETS[globals()['_active_video_target']]['wake_entity']
    my_gen = _next_play_gen()
    def _aborted():
        return not _is_play_gen_current(my_gen)
    try:
        ureq.urlopen(
            ureq.Request(f'{TV_CONTROL_URL}/media/command',
                         data=json.dumps({'entity': wake_entity, 'command': 'turn_on'}).encode(),
                         headers={'Content-Type': 'application/json'}, method='POST'),
            timeout=5
        )
    except Exception:
        pass
    # Active wait — return as soon as TV's UPnP service answers. Beats the
    # old static sleep(3) which was the main source of "plays sometimes,
    # silent sometimes" behaviour: 3 s was a lucky-guess timing.
    # 45s ceiling: a TV that was OFF needs to WoL-wake AND boot its DLNA
    # renderer, which can take ~20-35s on a cold Samsung. The poll returns the
    # instant UPnP answers, so this costs nothing when the TV is already on.
    _wait_t0 = time.time()
    ready = _wait_for_tv_ready(max_wait_sec=45)
    if ready:
        _waited = time.time() - _wait_t0
        if _waited > 3:
            log.info(f"_wake_and_play: TV became UPnP-ready after {_waited:.0f}s (cold wake) for {title!r}")
    else:
        log.warning(f"_wake_and_play: TV did not respond within 45s for {title!r} — sending commands anyway")
    # Was the renderer mid-playback? Switching tracks from an active session is
    # what wedges the 2024 balcony unit (tv55): it accepts the new URI but stalls
    # in TRANSITIONING and never starts it. Its path needs a longer teardown settle
    # + a "quick play" reload, plus a recovery reload if the first attempt stalls.
    # The 85" (target 'tv') stays on the ORIGINAL path (prev-TV behaviour) so it
    # cannot regress — it switches fine on the first attempt and never hits the
    # quick/recovery path. (Verified on tv55: 0/4 old path, 3/3 with this.)
    prev_active  = _get_transport_state() not in ('STOPPED', 'NO_MEDIA_PRESENT', 'UNKNOWN')
    fast_advance = prev_active and globals()['_active_video_target'] == 'tv55'
    # Force STOPPED before loading a new URI. Fail-silent — fresh boots are STOPPED.
    dlna_soap('Stop',
        '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
        '<InstanceID>0</InstanceID></u:Stop>'
    )
    for _ in range(20):
        if _aborted():
            log.info(f"_wake_and_play: aborted (newer play queued) — dropping {title!r}")
            return
        if _get_transport_state() in ('STOPPED', 'NO_MEDIA_PRESENT', 'UNKNOWN'):
            break
        time.sleep(0.25)
    if _aborted():
        return
    # Switching from an active track on tv55 needs ~3 s for the DMR to fully
    # release the previous session; a fresh start needs only ~0.5 s.
    time.sleep(3.0 if fast_advance else 0.5)
    is_audio       = ('.' + ext.lower()) in AUDIO_EXTS
    if stream_url is None:
        stream_url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext}'
    stream_url_xml = xml_escape(stream_url)
    title_xml      = xml_escape(title)
    dlna_class     = 'object.item.audioItem.musicTrack' if is_audio else 'object.item.videoItem'
    play_body = ('<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                 '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>')

    # Load a fresh URI + Play + verify the TV actually reaches PLAYING (a SOAP 200
    # does NOT mean it started streaming). Returns True only on confirmed PLAYING.
    # A UNIQUE DIDL item id per call — Samsung dedups SetAVTransportURI on a
    # matching id, which would silently no-op a reload.
    def _load_and_play(verify_secs, quick_play):
        item_id = f"{dlna_id or 'item'}-{int(time.time() * 1000)}"
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
        # Original path waits for the renderer to return to STOPPED before Play
        # (the 85" needs that). tv55 STAYS in TRANSITIONING after a reload, so its
        # path just pauses briefly and Plays — measured 3/3 vs 0/4 for the wait path.
        if quick_play:
            if _aborted():
                return False
            time.sleep(0.8)
        else:
            for _ in range(20):
                if _aborted():
                    return False
                if _get_transport_state() in ('STOPPED', 'NO_MEDIA_PRESENT'):
                    break
                time.sleep(0.25)
        for attempt in range(3):
            if _aborted():
                return False
            okp, _ = dlna_soap('Play', play_body)
            if okp:
                break
            time.sleep(1)
            log.info(f"_wake_and_play: Play retry {attempt + 1}/3 for {title!r}")
        for _ in range(verify_secs):
            if _aborted():
                return False
            time.sleep(1)
            if _get_transport_state() == 'PLAYING':
                return True
        return False

    confirmed = _load_and_play(verify_secs=6, quick_play=fast_advance)
    # On tv55, the first SetAVTransportURI after a playing track can still stall in
    # TRANSITIONING. One clean re-teardown + quick reload fixes it. The 85" never
    # reaches here (its first attempt confirms PLAYING).
    if not confirmed and not _aborted():
        log.info(f"_wake_and_play: stalled in TRANSITIONING — recovery reload for {title!r}")
        dlna_soap('Stop',
            '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:Stop>')
        for _ in range(24):
            if _aborted():
                return
            if _get_transport_state() in ('STOPPED', 'NO_MEDIA_PRESENT'):
                break
            time.sleep(0.25)
        time.sleep(2.5)
        confirmed = _load_and_play(verify_secs=8, quick_play=True)
    if not confirmed and not _aborted():
        log.warning(f"_wake_and_play: never observed PLAYING for {title!r} after recovery reload")


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
    # Balcony TV (tv55) OFF → cleanly stop ITS playback first, wait 2 s, THEN power
    # off, so the TV isn't cut mid-stream. ONLY acts when the Balcony TV is the
    # ACTIVE player (_active_video_target == 'tv55') — so the 85"/soundbar and a
    # Living-Room queue are NEVER touched. CLEARING _play_queue is essential: it
    # makes the dlna-watch thread EXIT instead of treating the Stop as "track
    # ended" and advancing to the next song (the bug a raw DLNA Stop caused).
    j = request.json
    if j.get('entity') == 'tv55' and j.get('command') == 'turn_off' and _active_video_target == 'tv55':
        try:
            with _queue_lock:
                globals()['_play_queue'] = None          # stop the watcher from advancing
            dlna_soap('Stop',
                      '<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                      '<InstanceID>0</InstanceID></u:Stop>',
                      tv_url=_av_url('tv55'))
            log.info('tv55 OFF: stopped Balcony TV playlist, waiting 2 s before power-off')
        except Exception:
            log.exception('tv55 OFF pre-stop failed (continuing to power off)')
        time.sleep(2)
    # Balcony TV (tv55) volume: HA's volume_set/down are DEAD for this TV, so do it
    # via UPnP RenderingControl (GetVolume → ±value → SetVolume — verified working).
    # Handled here directly; never proxied to the dead tv_control HA path.
    if j.get('entity') == 'tv55' and j.get('command') == 'volume_step':
        try:
            cur = _tv55_get_volume()
            cur = 50 if cur is None else cur
            new = _tv55_set_volume(cur + int(j.get('value') or 0))
            log.info('tv55 volume_step %+d -> %d (UPnP)', int(j.get('value') or 0), new)
            return jsonify({'ok': True, 'volume': new})
        except Exception as e:
            log.exception('tv55 volume_step failed')
            return jsonify({'error': str(e)}), 500
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
    # encodeURIComponent turns the leading '/' of the absolute path into %2F; Werkzeug
    # decodes it to '//' and merge-slashes 308-redirects, dropping the leading slash.
    # Restore it so the lookup matches media_library.path ('/mnt/media/...').
    if not file_path.startswith('/'):
        file_path = '/' + file_path
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


# ── GET /api/media/walk ──────────────────────────────────────────
# Recursive flat listing under a relative path. Used by the dashboard's
# "🔍 Unassigned" feature to find files not present in any playlist.
# Returns every regular file under <MEDIA_MOUNT>/<rel_path> (depth ∞),
# skipping hidden entries (".*") and not following symlinks.
@app.route('/api/media/walk')
def walk_dir():
    rel_path = (request.args.get('path') or '').strip('/')
    try:
        full_path = safe_path(rel_path) if rel_path else os.path.realpath(MEDIA_MOUNT)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if not os.path.isdir(full_path):
        return jsonify({'error': 'not a directory'}), 400
    base = os.path.realpath(MEDIA_MOUNT)
    files = []
    try:
        for root, dirs, fns in os.walk(full_path, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for fn in fns:
                if fn.startswith('.'):
                    continue
                full = os.path.join(root, fn)
                rel  = os.path.relpath(full, base).replace(os.sep, '/')
                fold = os.path.relpath(root, base).replace(os.sep, '/')
                files.append({
                    'name':   fn,
                    'path':   '/mnt/media/' + rel,
                    'folder': fold,
                    'ext':    os.path.splitext(fn)[1].lower(),
                })
        files.sort(key=lambda x: (x['folder'].lower(), x['name'].lower()))
        return jsonify({'path': rel_path, 'count': len(files), 'files': files})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ── POST /api/media/delete ───────────────────────────────────────
# Forget deleted files in the DB: drop their media_library rows + remove them
# from every playlist, then refresh the DLNA index in the background. Keeps the
# database consistent with disk so a delete/move never leaves orphan rows or
# broken playlist paths (the same guarantee /api/media/move already gives).
def _db_forget_paths(paths):
    if not paths:
        return
    plist = list(paths)
    try:
        db_query('DELETE FROM media_library WHERE path = ANY(%s)', (plist,), fetch=False)
    except Exception as e:
        log.warning(f"delete: media_library cleanup failed: {e}")
    try:
        gone = set(plist)
        for r in (db_query('SELECT id, items FROM media_playlists WHERE items IS NOT NULL') or []):
            items = r.get('items') or []
            kept  = [it for it in items if it.get('path') not in gone]
            if len(kept) != len(items):
                db_query('UPDATE media_playlists SET items=%s::jsonb WHERE id=%s',
                         (json.dumps(kept), r['id']), fetch=False)
    except Exception as e:
        log.warning(f"delete: playlist cleanup failed: {e}")
    threading.Thread(target=_minidlna_full_rescan, daemon=True).start()


# Delete files (and their yt-dlp ".description" sidecars) — or a whole folder —
# from the media library. Used by the 🔍 Unassigned modal AND the grid's 🗑
# (file/folder) delete. The QNAP SMB user can't delete on this share, but THIS
# service created the files so it can. Every path is safe_path()-validated;
# empty parents are pruned. A delete also SYNCS the DB (media_library rows +
# playlist items) — for a folder, the files inside are collected before rmtree
# so their rows are cleaned too.
# Body: {"paths": ["/mnt/media/Music/.../x.m4a", "Music/SubFolder", ...]}.
@app.route('/api/media/delete', methods=['POST'])
def media_delete():
    import shutil
    data  = request.get_json(silent=True) or {}
    paths = data.get('paths') or []
    if not isinstance(paths, list) or not paths:
        return jsonify({'error': 'no paths given'}), 400
    base    = os.path.realpath(MEDIA_MOUNT)
    results = []
    removed = []          # full paths of every FILE removed (for DB cleanup)
    for p in paths:
        rel = p[len('/mnt/media/'):] if isinstance(p, str) and p.startswith('/mnt/media/') else p
        try:
            full = safe_path(rel)
        except ValueError:
            results.append({'path': p, 'ok': False, 'error': 'unsafe path'})
            continue
        try:
            if os.path.isdir(full) and os.path.realpath(full) != base:
                for root, _dirs, files in os.walk(full):     # collect inner files first
                    for fn in files:
                        removed.append(os.path.join(root, fn))
                shutil.rmtree(full)
            elif os.path.isfile(full):
                os.remove(full)
                removed.append(full)
                sidecar = os.path.splitext(full)[0] + '.description'
                if os.path.isfile(sidecar):
                    try: os.remove(sidecar)
                    except OSError: pass
                parent = os.path.dirname(full)
                if os.path.realpath(parent) != base and not os.listdir(parent):
                    try: os.rmdir(parent)
                    except OSError: pass
            else:
                results.append({'path': p, 'ok': False, 'error': 'not found'})
                continue
            results.append({'path': p, 'ok': True})
        except Exception as e:
            results.append({'path': p, 'ok': False, 'error': str(e)})
    _db_forget_paths(removed)                                # keep the DB in sync
    ok = sum(1 for r in results if r.get('ok'))
    log.info(f"media delete: {ok}/{len(results)} removed ({len(removed)} files, DB synced)")
    return jsonify({'deleted': ok, 'total': len(results), 'results': results})


# ── POST /api/media/mkdir ────────────────────────────────────────
# Create an (empty) folder under the browsed directory. Same permission
# story as delete/move: this service owns the files (created them), so it
# can mkdir where the QNAP SMB user can't. safe_path-guarded; unicode names OK.
# Body: {"parent": "Videos", "name": "Birthdays"}
@app.route('/api/media/mkdir', methods=['POST'])
def media_mkdir():
    data   = request.get_json(silent=True) or {}
    parent = (data.get('parent') or '').strip()
    name   = (data.get('name') or '').strip().strip('/')
    if not name or '/' in name or name in ('.', '..'):
        return jsonify({'error': 'invalid folder name'}), 400
    rel = (parent.rstrip('/') + '/' + name) if parent else name
    try:
        full = safe_path(rel)
    except ValueError:
        return jsonify({'error': 'unsafe path'}), 400
    try:
        os.makedirs(full, exist_ok=True)
        log.info(f"media mkdir: {rel}")
        return jsonify({'ok': True, 'path': rel})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── POST /api/media/move ─────────────────────────────────────────
# Move files into a folder (created if new). os.rename on the NFS mount —
# this service runs as root so it CAN move; the QNAP SMB user can't. A move
# changes each file's path, so we keep the library + playlists + MiniDLNA in
# sync afterwards. Body: {"paths": [...full...], "dest": "Videos/Birthdays"}.
@app.route('/api/media/move', methods=['POST'])
def media_move():
    data  = request.get_json(silent=True) or {}
    paths = data.get('paths') or []
    dest  = (data.get('dest') or '').strip()
    if not isinstance(paths, list) or not paths:
        return jsonify({'error': 'no paths given'}), 400
    try:
        dest_full = safe_path(dest)
    except ValueError:
        return jsonify({'error': 'unsafe destination'}), 400
    try:
        os.makedirs(dest_full, exist_ok=True)
    except Exception as e:
        return jsonify({'error': f'could not create folder: {e}'}), 500
    if not os.path.isdir(dest_full):
        return jsonify({'error': 'destination is not a folder'}), 400
    base    = os.path.realpath(MEDIA_MOUNT)
    results = []
    moved   = {}          # old_full -> new_full, for DB sync
    for p in paths:
        rel = p[len('/mnt/media/'):] if isinstance(p, str) and p.startswith('/mnt/media/') else p
        try:
            src = safe_path(rel)
        except ValueError:
            results.append({'path': p, 'ok': False, 'error': 'unsafe path'}); continue
        if not os.path.isfile(src):
            results.append({'path': p, 'ok': False, 'error': 'not a file'}); continue
        new = os.path.join(dest_full, os.path.basename(src))
        if os.path.realpath(new) == os.path.realpath(src):
            results.append({'path': p, 'ok': False, 'error': 'already in that folder'}); continue
        if os.path.exists(new):
            results.append({'path': p, 'ok': False, 'error': 'name already exists there'}); continue
        try:
            os.rename(src, new)
            side = os.path.splitext(src)[0] + '.description'     # move yt-dlp sidecar too
            if os.path.isfile(side):
                try: os.rename(side, os.path.splitext(new)[0] + '.description')
                except OSError: pass
            parent = os.path.dirname(src)                        # prune emptied source folder
            if os.path.realpath(parent) != base and not os.listdir(parent):
                try: os.rmdir(parent)
                except OSError: pass
            moved[src] = new
            results.append({'path': p, 'ok': True, 'new_path': new})
        except Exception as e:
            results.append({'path': p, 'ok': False, 'error': str(e)})
    # keep the DB in sync — a move changes the file's path
    for old, new in moved.items():
        try:
            db_query('UPDATE media_library SET path=%s WHERE path=%s', (new, old), fetch=False)
        except Exception as e:
            log.warning(f"media move: media_library path update failed for {old}: {e}")
    if moved:
        try:                                                    # rewrite playlist item paths
            for r in (db_query('SELECT id, items FROM media_playlists WHERE items IS NOT NULL') or []):
                items = r.get('items') or []
                changed = False
                for it in items:
                    if it.get('path') in moved:
                        it['path'] = moved[it['path']]; changed = True
                if changed:
                    db_query('UPDATE media_playlists SET items=%s::jsonb WHERE id=%s',
                             (json.dumps(items), r['id']), fetch=False)
        except Exception as e:
            log.warning(f"media move: playlist sync failed: {e}")
        # Refresh the DLNA cast index in the BACKGROUND — a full rescan takes
        # tens of seconds, and the browser grid reads the filesystem live (no
        # rescan needed for it), so the move returns immediately.
        threading.Thread(target=_minidlna_full_rescan, daemon=True).start()
    ok = sum(1 for r in results if r.get('ok'))
    log.info(f"media move: {ok}/{len(results)} -> {dest}")
    return jsonify({'moved': ok, 'total': len(results), 'results': results})


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
        # video (so an inline <video> in the Daily Journal plays; browsers only
        # actually decode mp4/webm — others still serve but won't play inline):
        'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
        'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo', 'm4v': 'video/x-m4v',
        'ts': 'video/mp2t', 'flv': 'video/x-flv', 'wmv': 'video/x-ms-wmv',
        # image (so <img>/lightbox can render the full file via this serve):
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
    }.get(ext, 'application/octet-stream')
    size = os.path.getsize(full_path)
    # ?dl=1 => force a browser "save" instead of inline play/render (Download button
    # in the Media page's Select mode). Every existing caller (playback / DLNA / Daily
    # Journal inline) omits it, so the inline path is byte-for-byte unchanged.
    as_attach = request.args.get('dl') == '1'
    base = os.path.basename(full_path)
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
        headers = {
            'Content-Range': f'bytes {start}-{end}/{size}',
            'Accept-Ranges': 'bytes', 'Content-Length': str(length),
            'Content-Type': mime,
        }
        if as_attach:
            headers['Content-Disposition'] = f'attachment; filename="{base}"'
        return Response(generate(), 206, headers=headers)
    return send_from_directory(os.path.dirname(full_path), base,
                               mimetype=mime, as_attachment=as_attach)


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
    # Which TV to render video on (default 85"). Audio ignores this — always soundbar.
    target = (request.json or {}).get('target', 'tv')
    if target not in TV_TARGETS:
        target = 'tv'
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

    # Audio sink depends on the target: 'cast' → soundbar, 'dlna' → the TV's
    # own speakers. Video → UPnP → selected TV (audio rides the video stream).
    is_audio = ('.' + ext.lower()) in AUDIO_EXTS
    dlna_id = minidlna_id(full_path)
    if is_audio:
        if dlna_id:
            url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext}'
        else:
            rel_enc = '/'.join(_urlq(seg) for seg in rel_path.split('/'))
            url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_enc}'
        if _audio_sink(target) == 'dlna':
            # Music plays on the TV's own speakers via UPnP (no soundbar here).
            threading.Thread(target=_wake_and_play, args=(full_path, ext, basename, dlna_id),
                             kwargs={'target': target, 'stream_url': url}, daemon=True).start()
        else:
            threading.Thread(target=_cast_play_url, args=(url, basename), daemon=True).start()
    else:
        if not dlna_id:
            return jsonify({'error': f'Not indexed by MiniDLNA: {basename}'}), 404
        threading.Thread(target=_wake_and_play, args=(full_path, ext, basename, dlna_id),
                         kwargs={'target': target}, daemon=True).start()
    return jsonify({'ok': True, 'item': basename, 'target': target}), 202


# ── POST /api/media/play-number ───────────────────────────────────
@app.route('/api/media/play-number', methods=['POST'])
def play_number():
    try:
        num = int((request.json or {}).get('number', 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'number must be an integer'}), 400
    if not num:
        return jsonify({'error': 'number required'}), 400
    target = (request.json or {}).get('target', 'tv')
    if target not in TV_TARGETS:
        target = 'tv'
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
        if _audio_sink(target) == 'dlna':
            threading.Thread(target=_wake_and_play, args=(full_path, ext, title, dlna_id),
                             kwargs={'target': target, 'stream_url': url}, daemon=True).start()
        else:
            threading.Thread(target=_cast_play_url, args=(url, title), daemon=True).start()
    elif dlna_id:
        threading.Thread(target=_wake_and_play, args=(full_path, ext, title, dlna_id),
                         kwargs={'target': target}, daemon=True).start()
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
            # RelTime can carry fractional seconds ("0:03:00.134") — int() chokes
            # on the decimal, so go via float() and floor. Without this, position
            # came back 0 and the progress bar's fill sat frozen at 0%.
            try:
                p = (t or '').split(':')
                return int(p[0])*3600 + int(p[1])*60 + int(float(p[2])) if len(p) == 3 else 0
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


# ── MiniDLNA library rebuild — recovery from stale/incomplete DB ──────
# MiniDLNA only knows about files it scanned at startup OR caught via
# inotify. Files added via QNAP/SMB (NFS mount client doesn't propagate
# inotify) silently never get indexed → `Not indexed by MiniDLNA` errors.
# SIGHUP does only an incremental rescan that can't recover from a stale
# DB. The full-rebuild path is: stop service → rm files.db → start
# service. Triggered from the dashboard 🔄 Rescan button (added 2026-05-27).

def _minidlna_full_rescan():
    """Force a full MiniDLNA database rebuild. Stops the daemon, deletes
    `/var/cache/minidlna/files.db`, starts the daemon, and **waits for the
    scan to actually FINISH** (row count stops growing) before returning.
    Returns the result dict (raises on systemctl/other failure). Callable
    from BOTH the HTTP route and the yt-dlp reader (video downloads finish
    with a rescan instead of a playlist), so the logic lives here, not in
    the route.

    Why wait-for-completion (fixed 2026-06-13): the scan writes `details`
    rows incrementally over several MINUTES (it thumbnails every file). The
    old code returned as soon as count>0 (~1 s) and reported "complete" while
    most folders — including Videos/ — were still unscanned. New files can't
    be caught any other way: the NFS client mount doesn't propagate inotify,
    so MiniDLNA never auto-indexes files written via the mount — a rescan is
    mandatory, and it must be honestly complete before Play is attempted.

    Idempotent. Runtime: ~1–3 min for a ~1600-file library."""
    log.info('minidlna_rescan: starting full DB rebuild')
    # Stop daemon (gracefully).
    subprocess.run(['systemctl', 'stop', 'minidlna'], check=True, timeout=15)
    # Wipe DB
    for f in ('/var/cache/minidlna/files.db', '/var/cache/minidlna/art_cache'):
        if os.path.isdir(f):
            # art_cache: keep dir, just clear contents
            for inner in os.listdir(f):
                try: os.remove(os.path.join(f, inner))
                except IsADirectoryError: pass
                except Exception as e: log.debug('art cache cleanup: %s', e)
        elif os.path.isfile(f):
            os.remove(f)
    # Start daemon — kicks off a full scan
    subprocess.run(['systemctl', 'start', 'minidlna'], check=True, timeout=15)
    # Wait for the scan to ACTUALLY finish, not just start. The scan writes
    # `details` rows incrementally; we poll the row count and declare the
    # scan complete once it has stopped growing for STABLE_FOR seconds.
    t0           = time.time()
    MAX_WAIT     = 360      # safety ceiling (s)
    STABLE_FOR   = 12       # count unchanged this long ⇒ scan finished (s)
    POLL         = 2
    total        = 0
    last_total   = -1
    stable_since = None
    completed    = False
    while time.time() - t0 < MAX_WAIT:
        try:
            conn  = sqlite3.connect(MINIDLNA_DB)
            total = conn.execute('SELECT COUNT(*) FROM details').fetchone()[0]
            conn.close()
        except Exception:
            total = last_total   # DB momentarily locked mid-scan — ignore
        if total > 0 and total == last_total:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since >= STABLE_FOR:
                completed = True
                break
        else:
            stable_since = None   # count moved (or first read) — reset timer
        last_total = total
        time.sleep(POLL)
    # Final stats — split by section
    try:
        conn = sqlite3.connect(MINIDLNA_DB)
        row  = conn.execute(
            "SELECT COUNT(*) AS total, "
            "       SUM(CASE WHEN path LIKE '%/Videos/%' THEN 1 ELSE 0 END) AS videos, "
            "       SUM(CASE WHEN path LIKE '%/Music/%' THEN 1 ELSE 0 END) AS music, "
            "       SUM(CASE WHEN path LIKE '%/Photos/%' THEN 1 ELSE 0 END) AS photos "
            "FROM details"
        ).fetchone()
        conn.close()
        counts = {'total': row[0] or 0, 'videos': row[1] or 0, 'music': row[2] or 0, 'photos': row[3] or 0}
    except Exception as e:
        counts = {'error': str(e)}
    log.info('minidlna_rescan: done — counts=%s elapsed=%.1fs', counts, time.time() - t0)
    return {
        'ok':         True,
        'completed':  completed,
        'counts':     counts,
        'elapsed_sec': round(time.time() - t0, 1),
        'note':       ('scan finished — index is complete' if completed
                       else f'still scanning after {MAX_WAIT}s ceiling — counts may grow further'),
    }


@app.route('/api/media/minidlna/rescan', methods=['POST'])
def minidlna_rescan():
    """HTTP wrapper around _minidlna_full_rescan() (dashboard 🔄 Rescan button)."""
    try:
        return jsonify(_minidlna_full_rescan())
    except subprocess.CalledProcessError as e:
        log.exception('minidlna_rescan systemctl failed')
        return jsonify({'error': f'systemctl failed: {e}'}), 500
    except Exception as e:
        log.exception('minidlna_rescan')
        return jsonify({'error': str(e)}), 500


# ── yt-dlp integration — download YouTube playlists/videos to Music ──
# Phase 1 (since 2026-05-27). Three endpoints:
#   POST /api/media/yt-dlp/probe      — quick metadata fetch (no download)
#   POST /api/media/yt-dlp/start      — spawn yt-dlp subprocess, return job_id
#   GET  /api/media/yt-dlp/status/:id — poll job state + per-track status
# Auto-creates a media_playlists row when create_playlist=true on completion.
#
# Canonical yt-dlp command line (proven Phase 0):
#   python3 -m yt_dlp -f "bestaudio[ext=m4a]/bestaudio"
#     --extract-audio --audio-format m4a --newline
#     -o "/mnt/media/Music/<folder>/%(playlist_index)03d - %(title)s.%(ext)s" <url>
# `--newline` forces yt-dlp to emit '\n' between [download] lines instead of
# '\r' overwrites, so line-based stdout parsing works.

_yt_jobs      = {}                          # uuid → job dict
_yt_jobs_lock = threading.Lock()
_YT_CMD       = ['python3', '-m', 'yt_dlp']
_YT_FOLDER_RE = re.compile(r'[^a-zA-Z0-9 _\-À-￿]')   # allow unicode names
_YT_DEST_RE   = re.compile(r'\[download\] Destination:\s+(.+?)\s*$')
_YT_DONE_RE   = re.compile(r'\[download\]\s+100%\s+of\s')
# Video downloads pull separate video+audio streams, then ffmpeg merges them.
# The final on-disk filename only appears on the Merger line (the per-stream
# Destination lines name the .fNNN.* parts that get deleted post-merge), so the
# video reader path tracks this instead of _YT_DEST_RE.
_YT_MERGER_RE = re.compile(r'\[Merger\] Merging formats into "(.+?)"\s*$')

# Timestamp matcher for description-based auto-split. Captures H:MM:SS,
# MM:SS, or M:SS — covers both bare timestamps ("17:18") and parenthesized
# ones ("(17:18)"). The bounding `\b` keeps it from matching dates etc.
_YT_TS_RE     = re.compile(r'\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b')
# Filename sanitizer — strip filesystem-illegal chars but keep unicode.
_YT_FNAME_RE  = re.compile(r'[<>:"/\\|?*\n\r\t]')


def _yt_sanitize_folder(name):
    """Allow letters / digits / spaces / underscore / hyphen plus any non-ASCII
    (so Russian / Hebrew / Chinese playlist titles work). Strip and clamp."""
    s = (name or '').strip().strip('.')
    s = _YT_FOLDER_RE.sub('_', s)[:100].strip().strip('_')
    return s or 'YouTube_Download'


def _yt_strip_radio_list(url):
    """A YouTube `list=RD…` is an auto-generated Radio/Mix (infinite, seeded from ONE
    song) — never a real playlist to download. If present, drop list/index/start_radio
    so a pasted `watch?v=X&list=RD…` resolves to the single video X, not the mix.
    Real `list=PL…` / `OLAK…` playlists are left untouched."""
    if 'list=RD' not in url:
        return url
    try:
        from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
        p = urlparse(url)
        q = parse_qsl(p.query, keep_blank_values=True)
        if not dict(q).get('list', '').startswith('RD'):
            return url
        q = [(k, v) for (k, v) in q if k not in ('list', 'index', 'start_radio')]
        return urlunparse(p._replace(query=urlencode(q)))
    except Exception:
        return url


@app.route('/api/media/yt-dlp/probe', methods=['POST'])
def yt_dlp_probe():
    """Return {type, title, track_count, suggested_folder} without downloading.
    Lets the dashboard auto-fill the folder field once the user pastes a URL."""
    url = (request.get_json(silent=True) or {}).get('url', '').strip()
    if not url or not url.startswith(('http://', 'https://')):
        return jsonify({'error': 'invalid url'}), 400
    url = _yt_strip_radio_list(url)   # ignore YouTube Radio/Mix (list=RD…) — probe the actual video
    try:
        out = subprocess.check_output(
            _YT_CMD + ['--flat-playlist', '--skip-download',
                       '--print', '%(playlist_title|webpage_url_basename)s|%(title)s',
                       url],
            stderr=subprocess.PIPE, text=True, timeout=30,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        # Split safely — output is full lines, NOT prefixed with the URL.
        lines = [l for l in out.splitlines() if l.strip() and '|' in l]
        if not lines:
            return jsonify({'error': 'no tracks found at URL'}), 400
        first_pl_title, first_track_title = lines[0].split('|', 1)
        # Single video: just one row, and the "playlist_title" column falls
        # back to webpage_url_basename which yt-dlp fills with the video id.
        if len(lines) == 1:
            return jsonify({
                'type': 'video',
                'title': first_track_title,
                'track_count': 1,
                'suggested_folder': _yt_sanitize_folder(first_track_title),
            })
        return jsonify({
            'type': 'playlist',
            'title': first_pl_title,
            'track_count': len(lines),
            'suggested_folder': _yt_sanitize_folder(first_pl_title),
        })
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'probe timeout (>30s)'}), 504
    except subprocess.CalledProcessError as e:
        err = (e.stderr or '').strip().splitlines()[-1][:200] if e.stderr else 'unknown error'
        return jsonify({'error': f'yt-dlp probe failed: {err}'}), 502
    except Exception as e:
        log.exception('yt_dlp_probe')
        return jsonify({'error': str(e)}), 500


def _yt_parse_timestamps(description, total_sec=None):
    """Extract sorted, deduped track list from a YouTube video description.
    Handles common compilation-video layouts (the timestamp can be at line
    start, end, or wrapped in parens/brackets). Returns list of
    {start_sec, title} dicts. `total_sec`, if given, filters out timestamps
    that exceed the video duration (avoids picking up text like "see at
    10:00 PM PST" as a track marker)."""
    if not description:
        return []
    candidates = []
    for line in description.splitlines():
        for m in _YT_TS_RE.finditer(line):
            h, mm, ss = m.groups()
            if ss is None:
                start = int(h) * 60 + int(mm)         # MM:SS
            else:
                start = int(h) * 3600 + int(mm) * 60 + int(ss)  # HH:MM:SS
            if total_sec and start > total_sec + 5:
                continue
            # Title = everything else on the line, minus the timestamp.
            title = (line[:m.start()] + ' ' + line[m.end():]).strip()
            # Strip wrapping punctuation, leading track-number prefix.
            title = title.strip('()[]-—:.,•· \t')
            title = re.sub(r'^\d+[\.\)]\s*', '', title).strip()
            title = title.strip('()[]-—:.,•· \t')
            if len(title) < 3:
                continue
            candidates.append({'start_sec': start, 'title': title})
    # Dedupe by start_sec (description often repeats the tracklist twice).
    seen, unique = set(), []
    for c in sorted(candidates, key=lambda x: x['start_sec']):
        if c['start_sec'] in seen:
            continue
        seen.add(c['start_sec'])
        unique.append(c)
    return unique


def _yt_probe_duration_sec(m4a_path):
    """Get audio duration via ffprobe. Returns float seconds or None on failure."""
    try:
        out = subprocess.check_output(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', m4a_path],
            text=True, timeout=15,
        )
        return float(out.strip())
    except Exception as e:
        log.warning('ffprobe failed for %s: %s', m4a_path, e)
        return None


def _yt_split_m4a_by_tracks(m4a_path, tracks, target_dir):
    """Use ffmpeg `-c copy` (lossless, no re-encoding) to split one .m4a
    into N files based on the parsed tracks. End time of track N is the
    start of track N+1; the last track runs to end-of-file. Returns the
    list of created file paths."""
    if len(tracks) < 2:
        return []
    created = []
    for idx, track in enumerate(tracks):
        start = track['start_sec']
        nxt   = tracks[idx + 1]['start_sec'] if idx + 1 < len(tracks) else None
        safe_title = _YT_FNAME_RE.sub('_', track['title'])[:120].strip()
        out_name   = f"{idx + 1:03d} - {safe_title}.m4a"
        out_path   = os.path.join(target_dir, out_name)
        cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
               '-i', m4a_path, '-ss', str(start)]
        if nxt is not None:
            cmd.extend(['-to', str(nxt)])
        cmd.extend(['-c', 'copy', '-avoid_negative_ts', 'make_zero', out_path])
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            if proc.returncode != 0:
                log.warning('ffmpeg split failed track %d (%s): %s',
                            idx + 1, safe_title, (proc.stderr or '')[:200])
                continue
            created.append(out_path)
        except Exception as e:
            log.warning('ffmpeg split exception track %d: %s', idx + 1, e)
    return created


def _yt_try_split(job_id):
    """Walk the job's target_dir for .m4a + .description pairs. For each
    pair, parse the description for timestamps; if 2+ tracks found, split
    the m4a with ffmpeg and remove the original. The auto-playlist step
    will then pick up the split files naturally on its next dir walk."""
    with _yt_jobs_lock:
        job        = _yt_jobs[job_id]
        target_dir = job['target_dir']
    split_summary = []                        # for the job state
    try:
        for fname in sorted(os.listdir(target_dir)):
            if not fname.lower().endswith('.m4a'):
                continue
            m4a_path  = os.path.join(target_dir, fname)
            # yt-dlp writes the description with the same stem + .description
            base, _   = os.path.splitext(m4a_path)
            desc_path = base + '.description'
            if not os.path.isfile(desc_path):
                continue
            with open(desc_path, 'r', encoding='utf-8', errors='replace') as fh:
                desc = fh.read()
            duration = _yt_probe_duration_sec(m4a_path)
            tracks   = _yt_parse_timestamps(desc, total_sec=duration)
            if len(tracks) < 2:
                continue
            log.info('yt-dlp[%s] auto-split %s: %d tracks',
                     job_id[:8], fname, len(tracks))
            created = _yt_split_m4a_by_tracks(m4a_path, tracks, target_dir)
            if not created:
                continue
            # Replace the original full file with the splits.
            try:
                os.remove(m4a_path)
                os.remove(desc_path)
            except Exception as e:
                log.warning('cleanup after split (%s): %s', m4a_path, e)
            split_summary.append({
                'original': fname,
                'parts':    len(created),
            })
    except Exception as e:
        log.exception('yt_try_split[%s]', job_id[:8])
    # Update the job's tracks list to reflect the new files.
    if split_summary:
        with _yt_jobs_lock:
            j = _yt_jobs[job_id]
            j['tracks'] = [
                {'name': fn, 'status': 'done'}
                for fn in sorted(os.listdir(target_dir))
                if fn.lower().endswith('.m4a')
            ]
            j['split_summary'] = split_summary


def _yt_reader(job_id):
    """Background thread: read yt-dlp stdout line-by-line, update tracks.
    On clean exit, optionally create a playlist row with all .m4a files in
    the target dir."""
    job  = _yt_jobs[job_id]
    proc = job['process']
    tail = []   # rolling recent output — used to surface the REAL error on failure
    try:
        for raw in iter(proc.stdout.readline, ''):
            line = raw.rstrip('\n')
            tail.append(line)
            if len(tail) > 20:
                tail.pop(0)
            log.debug('yt-dlp[%s] %s', job_id[:8], line)
            m = _YT_DEST_RE.search(line)
            if m:
                name = os.path.basename(m.group(1).strip())
                with _yt_jobs_lock:
                    # New track row only if name not already tracked. The
                    # ExtractAudio post-processor also emits a Destination
                    # line for the same file — we keep the earlier 'downloading'
                    # row instead of duplicating.
                    if not any(t['name'] == name for t in job['tracks']):
                        job['tracks'].append({'name': name, 'status': 'downloading'})
                continue
            if _YT_DONE_RE.search(line):
                with _yt_jobs_lock:
                    for t in reversed(job['tracks']):
                        if t['status'] == 'downloading':
                            t['status'] = 'done'
                            break
                continue
            # Video mode: the final merged file only shows on the Merger line.
            # Replace the transient .fNNN.* part rows with the real filename.
            mm = _YT_MERGER_RE.search(line)
            if mm:
                name = os.path.basename(mm.group(1).strip())
                with _yt_jobs_lock:
                    job['tracks'] = [t for t in job['tracks']
                                     if not re.search(r'\.f\d+\.(mp4|m4a|webm)$', t['name'])]
                    if not any(t['name'] == name for t in job['tracks']):
                        job['tracks'].append({'name': name, 'status': 'downloading'})
                continue
        rc = proc.wait()
        with _yt_jobs_lock:
            if job.get('cancelled'):
                # User hit Stop — not an error. Skip split/playlist so we
                # never build a playlist from a half-finished download.
                job['state'] = 'stopped'
                job['error'] = None
            elif rc != 0:
                job['state'] = 'error'
                # Surface the REAL reason (stderr is merged into stdout), not a bare rc.
                picked = [l for l in tail if l.strip().upper().startswith('ERROR')
                          or l.strip().startswith('WARNING: [')]
                detail = ' | '.join((picked or tail)[-3:]).strip()
                job['error'] = (f'yt-dlp rc={rc}: ' + detail)[:500] if detail \
                    else f'yt-dlp exited with rc={rc}'
            elif job.get('mode') == 'video':
                # NOT 'done' yet — the rescan runs next (below) and flips it to
                # 'done'. Setting 'rescanning' here (not 'done') avoids a 'done'
                # flash that a 1.5 s status poll could terminalize on, dropping
                # the rescan phase from the UI.
                job['state'] = 'rescanning'
            else:
                job['state'] = 'done'
            job['completed_at'] = time.time()
        # Post-completion: VIDEO mode finishes with a MiniDLNA rescan (so the
        # new file is indexed for the TV — NFS mounts don't fire inotify, so a
        # rescan is mandatory); AUDIO mode does the split + playlist creation.
        if rc == 0 and not job.get('cancelled'):
            if job.get('mode') == 'video':
                try:
                    with _yt_jobs_lock:
                        job['state'] = 'rescanning'
                    res = _minidlna_full_rescan()
                    with _yt_jobs_lock:
                        job['rescan'] = res
                        job['state']  = 'done'
                except Exception as e:
                    log.exception('yt-dlp[%s] video rescan', job_id[:8])
                    with _yt_jobs_lock:
                        job['rescan_error'] = str(e)
                        job['state']        = 'done'   # file is on disk; only indexing failed
            else:
                if job.get('auto_split'):
                    _yt_try_split(job_id)
                if job.get('create_playlist'):
                    _yt_auto_create_playlist(job_id)
    except Exception as e:
        log.exception('yt-dlp reader[%s]', job_id[:8])
        with _yt_jobs_lock:
            job['state']        = 'error'
            job['error']        = str(e)
            job['completed_at'] = time.time()


def _yt_auto_create_playlist(job_id):
    """Walk job's target_dir, build items array, INSERT into media_playlists."""
    with _yt_jobs_lock:
        job = _yt_jobs[job_id]
        target = job['target_dir']
        folder = job['folder']
    try:
        items = []
        for fname in sorted(os.listdir(target)):
            if fname.lower().endswith(('.m4a', '.mp3', '.opus', '.aac')):
                items.append({
                    'path':  os.path.join(target, fname),
                    'type':  'audio',
                    'title': fname,
                })
        if not items:
            log.warning('yt-dlp[%s] no audio files in %s — skipping playlist creation',
                        job_id[:8], target)
            return
        rows = db_query(
            "INSERT INTO media_playlists (name, items) "
            "VALUES (%s, %s::jsonb) RETURNING id",
            (folder, json.dumps(items)),
        )
        pid = rows[0]['id'] if rows else None
        with _yt_jobs_lock:
            _yt_jobs[job_id]['playlist_id'] = pid
        log.info('yt-dlp[%s] created playlist id=%s name=%r with %d tracks',
                 job_id[:8], pid, folder, len(items))
    except Exception as e:
        log.exception('yt-dlp auto-playlist[%s]', job_id[:8])
        with _yt_jobs_lock:
            _yt_jobs[job_id]['playlist_error'] = str(e)


@app.route('/api/media/yt-dlp/start', methods=['POST'])
def yt_dlp_start():
    body            = request.get_json(silent=True) or {}
    url             = (body.get('url') or '').strip()
    folder_raw      = body.get('folder') or ''
    mode            = (body.get('mode') or 'audio').strip().lower()
    if mode not in ('audio', 'video'):
        mode = 'audio'
    # Create-playlist + auto-split are audio-only concepts — force off for video.
    create_playlist = bool(body.get('create_playlist', True)) and mode == 'audio'
    auto_split      = bool(body.get('auto_split', True))      and mode == 'audio'

    if not url or not url.startswith(('http://', 'https://')):
        return jsonify({'error': 'invalid url'}), 400
    folder = _yt_sanitize_folder(folder_raw)
    url    = _yt_strip_radio_list(url)   # ignore YouTube Radio/Mix (list=RD…) — act on the single video

    if mode == 'video':
        # Reject LIVE streams BEFORE spawning — a 24/7 live URL makes yt-dlp
        # spawn ffmpeg to record forever. The /probe endpoint doesn't return
        # is_live, so do a quick dedicated check here.
        try:
            live = subprocess.run(
                _YT_CMD + ['--no-playlist', '--skip-download', '--print', '%(is_live)s', url],
                capture_output=True, text=True, timeout=45,
            )
            if 'true' in (live.stdout or '').lower():
                return jsonify({'error': 'refusing to download a LIVE stream (it would record forever)'}), 400
        except subprocess.TimeoutExpired:
            return jsonify({'error': 'yt-dlp live-check timed out (network/extractor issue)'}), 504
        except Exception as e:
            return jsonify({'error': f'live-check failed: {e}'}), 502
        try:
            target_dir = safe_path(f'Videos/{folder}')
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        os.makedirs(target_dir, exist_ok=True)
        out_template = os.path.join(target_dir, '%(title)s.%(ext)s')
        # 1080p H.264 + AAC → plays on the TV (NOT 4K). Always --no-playlist so
        # a ?list= pseudo-playlist can't expand into a runaway batch.
        cmd = _YT_CMD + [
            '-f', ('bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/'
                   'b[vcodec^=avc1][height<=1080]/b[ext=mp4]'),
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--retries', '5', '--fragment-retries', '5', '--extractor-retries', '3',
            '--newline',
            '-o', out_template,
            url,
        ]
    else:
        try:
            target_dir = safe_path(f'Music/{folder}')
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        os.makedirs(target_dir, exist_ok=True)
        out_template = os.path.join(
            target_dir, '%(playlist_index)03d - %(title)s.%(ext)s'
        )
        cmd = _YT_CMD + [
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '--extract-audio', '--audio-format', 'm4a',
            '--retries', '5', '--fragment-retries', '5', '--extractor-retries', '3',
            '--newline',
            '-o', out_template,
            url,
        ]
        if auto_split:
            # Save the YouTube description as .description sidecar — used
            # post-download to parse timestamps for chapter-less compilations.
            cmd.insert(-1, '--write-description')
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
            start_new_session=True,   # own process group → Stop can kill yt-dlp + any ffmpeg child
        )
    except Exception as e:
        log.exception('yt_dlp_start spawn')
        return jsonify({'error': f'spawn failed: {e}'}), 500

    import uuid as _uuid
    job_id = _uuid.uuid4().hex
    with _yt_jobs_lock:
        _yt_jobs[job_id] = {
            'url':             url,
            'folder':          folder,
            'mode':            mode,
            'target_dir':      target_dir,
            'create_playlist': create_playlist,
            'auto_split':      auto_split,
            'process':         proc,
            'tracks':          [],
            'started_at':      time.time(),
            'completed_at':    None,
            'state':           'running',
            'cancelled':       False,
            'error':           None,
            'playlist_id':     None,
            'playlist_error':  None,
            'split_summary':   None,
        }
    threading.Thread(target=_yt_reader, args=(job_id,), daemon=True).start()
    return jsonify({
        'job_id':     job_id,
        'folder':     folder,
        'target_dir': target_dir,
    })


@app.route('/api/media/yt-dlp/status/<job_id>')
def yt_dlp_status(job_id):
    with _yt_jobs_lock:
        job = _yt_jobs.get(job_id)
        if not job:
            return jsonify({'error': 'job not found'}), 404
        elapsed = (job['completed_at'] or time.time()) - job['started_at']
        return jsonify({
            'state':          job['state'],
            'mode':           job.get('mode', 'audio'),
            'tracks':         list(job['tracks']),
            'elapsed_sec':    round(elapsed, 1),
            'error':          job['error'],
            'folder':         job['folder'],
            'playlist_id':    job.get('playlist_id'),
            'playlist_error': job.get('playlist_error'),
            'split_summary':  job.get('split_summary'),
            'rescan':         job.get('rescan'),
            'rescan_error':   job.get('rescan_error'),
        })


# ── POST /api/media/yt-dlp/stop/<job_id> ─────────────────────────
# Abort a running download. Kills the yt-dlp process GROUP (so any ffmpeg
# extract child dies too — see start_new_session=True in yt_dlp_start).
# Sets cancelled=True so the reader marks the job 'stopped' (not 'error')
# and skips playlist/split. Partial files are LEFT on disk (clean them via
# the 🔍 Unassigned 🗑 button). Prevents the runaway-download scenario.
@app.route('/api/media/yt-dlp/stop/<job_id>', methods=['POST'])
def yt_dlp_stop(job_id):
    with _yt_jobs_lock:
        job = _yt_jobs.get(job_id)
        if not job:
            return jsonify({'error': 'job not found'}), 404
        if job['state'] != 'running':
            return jsonify({'state': job['state'], 'note': 'not running'})
        job['cancelled'] = True
        proc = job.get('process')
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(pgid, signal.SIGKILL)
    except Exception as e:
        log.warning('yt_dlp_stop[%s] killpg failed (%s) — fallback to proc.kill()', job_id[:8], e)
        try: proc.kill()
        except Exception: pass
    log.info('yt-dlp[%s] stopped by user', job_id[:8])
    return jsonify({'state': 'stopped'})


# ── Playlists CRUD (Phase 1) ─────────────────────────────────────
# User-created playlists of /mnt/media items. Items stored as JSONB
# array of {path, title, type, duration_sec?}. Playback wiring lives
# in a separate Phase 2 (queue manager + auto-advance via DLNA event
# subscription).

@app.route('/api/playlists', methods=['GET'])
def playlists_list():
    try:
        # User-controlled order: explicit sort_order wins; rows that have
        # never been dragged fall back to updated_at DESC so the old
        # "newest first" behavior still works for fresh playlists.
        rows = db_query(
            "SELECT id, name, description, items, "
            "  jsonb_array_length(items) AS item_count, "
            "  COALESCE(kind, 'audio') AS kind, "
            "  created_at, updated_at "
            "FROM media_playlists "
            "ORDER BY sort_order ASC NULLS LAST, updated_at DESC, id ASC"
        )
        return jsonify(rows)
    except Exception as e:
        log.exception('playlists_list')
        return jsonify({'error': str(e)}), 500


@app.route('/api/playlists/reorder', methods=['POST'])
def playlists_reorder():
    """Body: {"order": [id1, id2, ...]} — sets sort_order = index. Unlisted
    rows get sort_order = NULL so they fall back to updated_at ordering."""
    body = request.get_json(silent=True) or {}
    order = body.get('order')
    if not isinstance(order, list) or not all(isinstance(x, int) for x in order):
        return jsonify({'error': 'order must be a list of playlist ids'}), 400
    try:
        # Wipe positions first so a re-order that drops a row from the list
        # properly demotes it back to "auto" instead of keeping a stale index.
        # SCOPED to the reordered set's kind (audio/video) — the dashboard
        # sends only one card-type's ids, so wiping ALL rows would erase the
        # OTHER card's manual order. fetch=False because UPDATE without
        # RETURNING has no result set.
        if order:
            db_query(
                "UPDATE media_playlists SET sort_order = NULL "
                "WHERE COALESCE(kind, 'audio') = "
                "  (SELECT COALESCE(kind, 'audio') FROM media_playlists WHERE id = %s)",
                (order[0],), fetch=False,
            )
        for idx, pid in enumerate(order):
            db_query(
                "UPDATE media_playlists SET sort_order = %s WHERE id = %s",
                (idx, pid),
                fetch=False,
            )
        return jsonify({'ok': True, 'count': len(order)})
    except Exception as e:
        log.exception('playlists_reorder')
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
    kind = body.get('kind') or 'audio'
    if kind not in ('audio', 'video'):
        kind = 'audio'
    try:
        rows = db_query(
            "INSERT INTO media_playlists (name, description, items, kind) "
            "VALUES (%s, %s, %s::jsonb, %s) RETURNING id, name, items, kind, created_at",
            (name, description, json.dumps(items), kind),
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


# ── DLNA audio queue watcher ───────────────────────────────────────
# The Balcony TV has no Chromecast, so audio playlists on it can't rely on the
# Cast FINISHED event to advance. This thread polls the TV's UPnP transport
# state and advances the queue when the current track ends. It mirrors the Cast
# listener's gate — "saw PLAYING for this idx, then it STOPPED → advance" — so a
# brief STOPPED during track setup never triggers a false advance. One watcher
# runs per playlist; _dlna_watch_gen invalidates an old one when a new playlist
# starts (or the queue stops / switches to a Cast target).
_dlna_watch_gen = 0

def _start_dlna_queue_watcher():
    global _dlna_watch_gen
    with _queue_lock:
        _dlna_watch_gen += 1
        mygen = _dlna_watch_gen
    threading.Thread(target=_dlna_queue_watch_loop, args=(mygen,), daemon=True).start()
    log.info(f"dlna-watch: started (gen {mygen})")

def _dlna_queue_watch_loop(mygen):
    saw_playing_idx = None
    while True:
        time.sleep(2)
        with _queue_lock:
            if mygen != _dlna_watch_gen or not _play_queue:
                log.info(f"dlna-watch: exit (gen {mygen})")
                return
            target = _play_queue.get('video_target', 'tv')
            idx    = _play_queue['current_idx']
            items  = _play_queue['items']
        cur_item = items[idx] if 0 <= idx < len(items) else None
        if not cur_item:
            return
        ext_dot  = os.path.splitext(cur_item.get('path', ''))[1].lower()
        is_audio = ext_dot in AUDIO_EXTS
        if is_audio and _audio_sink(target) == 'cast':
            # Native Cast listener owns advancing this track — don't double-drive.
            saw_playing_idx = None
            continue
        # Video (any target) or audio-on-DLNA → watch that TV's UPnP transport.
        state = _get_transport_state(tv_url=_av_url(target))  # poll THIS TV explicitly
        if state == 'PLAYING':
            saw_playing_idx = idx
        elif state in ('STOPPED', 'NO_MEDIA_PRESENT') and saw_playing_idx == idx:
            saw_playing_idx = None
            log.info(f"dlna-watch: track {idx} ended → advancing")
            try:
                _cast_advance_queue()
            except Exception:
                log.exception('dlna-watch: advance failed')


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
    with _queue_lock:
        _qtarget = (_play_queue or {}).get('video_target', 'tv')
    try:
        if ext_dot in AUDIO_EXTS:
            dlna_id = minidlna_id(path)
            ext_bare = ext_dot.lstrip('.') or 'mp3'
            if dlna_id:
                url = f'http://{MEDIA_LXC_IP}:8200/MediaItems/{dlna_id}.{ext_bare}'
            else:
                rel = path[len(MEDIA_MOUNT):].lstrip('/') if path.startswith(MEDIA_MOUNT) else path.lstrip('/')
                rel_enc = '/'.join(_urlq(seg) for seg in rel.split('/'))
                url = f'http://{MEDIA_LXC_IP}:{PORT}/api/media/stream/{rel_enc}'
            if _audio_sink(_qtarget) == 'dlna':
                # Music → the TV's own speakers via UPnP. The DLNA queue watcher
                # (started in playlist_play) advances tracks since the TV has no
                # Chromecast to fire FINISHED events.
                threading.Thread(target=_wake_and_play, args=(path, ext_bare, title, dlna_id),
                                 kwargs={'target': _qtarget, 'stream_url': url}, daemon=True).start()
                log.info(f"queue: dispatched (DLNA audio → {_qtarget}) {idx + 1}/{_total} — {title}")
            else:
                # Audio → Cast → soundbar (native gapless queue).
                _cast_play_url(url, title)
                log.info(f"cast: playing {idx + 1}/{_total} — {title}")
        else:
            # Video → UPnP path to the selected TV.
            dlna_id = minidlna_id(path)
            if not dlna_id:
                log.warning(f"queue: no DLNA id for {path} — stopping queue")
                with _queue_lock:
                    globals()['_play_queue'] = None
                return False
            ext_bare = ext_dot.lstrip('.') or 'mp4'
            threading.Thread(target=_wake_and_play, args=(path, ext_bare, title, dlna_id),
                             kwargs={'target': _qtarget}, daemon=True).start()
            log.info(f"queue: dispatched (TV → {_qtarget}) {idx + 1}/{_total} — {title}")
        return True
    except Exception:
        log.exception('cast: play failed')
        return False


def _get_transport_state(tv_url=None):
    """Query a Samsung TV via DLNA GetTransportInfo. Returns PLAYING / STOPPED /
    PAUSED_PLAYBACK / TRANSITIONING / NO_MEDIA_PRESENT / UNKNOWN. Defaults to the
    active video target; pass tv_url to query a specific TV explicitly."""
    body = ('<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID></u:GetTransportInfo>')
    try:
        _ok, resp = dlna_soap('GetTransportInfo', body, tv_url=tv_url)
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
    # Target TV for any VIDEO items in the playlist (audio always → soundbar).
    video_target = body.get('target', 'tv')
    if video_target not in TV_TARGETS:
        video_target = 'tv'
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
                'video_target':  video_target,
            }
        # Only wake the soundbar's Cast when we're about to play AUDIO. For a
        # VIDEO item the sound comes from the TV itself, and launching the
        # soundbar's Cast stops the video from playing on the 85". The balcony
        # 55" never touches the soundbar and plays video playlists fine — this
        # makes the 85" behave the same for video.
        _p_exts = [os.path.splitext((it or {}).get('path', ''))[1].lower() for it in play_items]
        _has_video = any(e and e not in AUDIO_EXTS for e in _p_exts)
        _start_is_audio = (0 <= start_idx < len(_p_exts)) and (_p_exts[start_idx] in AUDIO_EXTS)
        _sink = _audio_sink(video_target)

        if _sink == 'cast' and _start_is_audio:
            # Apply preset volume before casting — the soundbar's Cast reference
            # level is hot, so each playlist starts at the user's preferred level.
            try:
                preset = _get_cast_preset_volume()
                cast = _get_cast()
                cast.set_volume(preset)
            except Exception:
                log.exception('cast preset volume apply')

        # Watcher advances items the native Cast listener CAN'T: VIDEO items (any
        # target) + AUDIO on a DLNA target (balcony 55").
        if _sink == 'dlna' or _has_video:
            _start_dlna_queue_watcher()

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


def _active_queue_target():
    """video_target of the active queue, or None when no queue is active."""
    with _queue_lock:
        return _play_queue.get('video_target', 'tv') if _play_queue else None

def _tv_control_state():
    """Fetch tv_control.py's /media/state (used to read the Balcony TV volume)."""
    import urllib.request
    try:
        with urllib.request.urlopen(f'{TV_CONTROL_URL}/media/state', timeout=4) as r:
            return json.loads(r.read())
    except Exception:
        return {}

def _tv_control_cmd(entity, command, value=None):
    """Send a command to tv_control.py (e.g. set the Balcony TV volume)."""
    import urllib.request
    body = {'entity': entity, 'command': command}
    if value is not None:
        body['value'] = value
    try:
        req = urllib.request.Request(f'{TV_CONTROL_URL}/media/command',
                                     data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(req, timeout=5)
        return True
    except Exception as e:
        log.warning(f'tv_control cmd {entity}/{command} failed: {e}')
        return False


@app.route('/api/cast/volume', methods=['GET', 'POST'])
def cast_volume():
    """Volume for the Now-Playing strip. For a Cast (soundbar) queue this drives
    the Cast app volume + preset. For a DLNA (Balcony TV) queue it drives the
    TV's volume via tv_control / HA. Both use 0.0-1.0 on the wire."""
    qt = _active_queue_target()
    dlna = qt is not None and _audio_sink(qt) == 'dlna'

    if request.method == 'POST':
        body = request.get_json(silent=True) or {}
        try:
            level = float(body.get('level', 0.3))
        except (TypeError, ValueError):
            return jsonify({'error': 'level must be a number 0..1'}), 400
        level = max(0.0, min(1.0, level))
        if dlna:
            # Absolute set on the Balcony TV (0..100) via HA media_player.
            ok = _tv_control_cmd(TV_TARGETS[qt]['wake_entity'], 'volume_set', round(level * 100))
            return (jsonify({'ok': True, 'level': level}) if ok
                    else (jsonify({'error': 'tv volume_set failed'}), 503))
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
    if dlna:
        vol = (_tv_control_state().get(qt) or {}).get('volume')
        cur = (vol / 100.0) if isinstance(vol, (int, float)) else 0.0
        return jsonify({'level': cur, 'preset': cur})
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
    # Snapshot queue fields under the lock, then probe the player OUTSIDE the
    # lock (the probe does network I/O — don't hold the queue lock during it).
    with _queue_lock:
        if not _play_queue:
            return jsonify({'active': False})
        items   = _play_queue['items']
        cur     = _play_queue['current_idx']
        qtarget = _play_queue.get('video_target', 'tv')
        playlist_id   = _play_queue['playlist_id']
        playlist_name = _play_queue['playlist_name']
        shuffle = _play_queue['shuffle']
        repeat  = _play_queue['repeat']

    cast_vol = cast_pos = cast_dur = cast_state = None
    if _audio_sink(qtarget) == 'dlna':
        # Balcony TV: position/state via UPnP, volume via tv_control / HA. We
        # reuse the cast_* response keys so the Now-Playing strip works as-is.
        try:
            _okp, xml = dlna_soap('GetPositionInfo',
                '<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                '<InstanceID>0</InstanceID></u:GetPositionInfo>', tv_url=_av_url(qtarget))
            def _secs(t):
                try:
                    p = (t or '').split(':')
                    return int(p[0])*3600 + int(p[1])*60 + int(float(p[2])) if len(p) == 3 else 0
                except (ValueError, IndexError):
                    return 0
            cast_dur = float(_secs((re.search(r'<TrackDuration[^>]*>([^<]+)<', xml) or [None, '0:00:00'])[1]))
            cast_pos = float(_secs((re.search(r'<RelTime[^>]*>([^<]+)<', xml) or [None, '0:00:00'])[1]))
        except Exception:
            pass
        st = _get_transport_state()
        cast_state = {'PLAYING': 'PLAYING', 'PAUSED_PLAYBACK': 'PAUSED',
                      'TRANSITIONING': 'BUFFERING'}.get(st, 'IDLE')
        vol = (_tv_control_state().get(qtarget) or {}).get('volume')
        cast_vol = (vol / 100.0) if isinstance(vol, (int, float)) else None
    else:
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
        'playlist_id':   playlist_id,
        'playlist_name': playlist_name,
        'current_idx':   cur,
        'total':         len(items),
        'current_item':  items[cur] if 0 <= cur < len(items) else None,
        'shuffle':       shuffle,
        'cast_volume':   cast_vol,
        'cast_position': cast_pos,
        'cast_duration': cast_dur,
        'cast_state':    cast_state,
        'target':        qtarget,
        'repeat':        repeat,
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


@app.route('/api/queue/pause', methods=['POST'])
def queue_pause():
    """Toggle pause/resume. Cast (soundbar) for a Cast queue; UPnP Pause/Play
    on the Balcony TV for a DLNA queue. PLAYING → pause, PAUSED → resume."""
    qt = _active_queue_target()
    if qt is not None and _audio_sink(qt) == 'dlna':
        state = _get_transport_state()
        try:
            if state == 'PLAYING':
                dlna_soap('Pause',
                    '<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                    '<InstanceID>0</InstanceID></u:Pause>', tv_url=_av_url(qt))
                return jsonify({'ok': True, 'action': 'paused'})
            elif state in ('PAUSED_PLAYBACK', 'PAUSED'):
                dlna_soap('Play',
                    '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                    '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>', tv_url=_av_url(qt))
                return jsonify({'ok': True, 'action': 'resumed'})
            return jsonify({'ok': True, 'action': 'noop', 'state': state})
        except Exception as e:
            return jsonify({'error': str(e)}), 500
    try:
        cast = _get_cast()
    except Exception as e:
        return jsonify({'error': f'cast unavailable: {e}'}), 503
    mc = cast.media_controller
    state = getattr(mc.status, 'player_state', None)
    try:
        if state == 'PLAYING':
            mc.pause()
            return jsonify({'ok': True, 'action': 'paused'})
        elif state == 'PAUSED':
            mc.play()
            return jsonify({'ok': True, 'action': 'resumed'})
        else:
            return jsonify({'ok': True, 'action': 'noop', 'state': state})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
