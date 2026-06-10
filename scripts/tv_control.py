#!/opt/media-agent/venv/bin/python3
import asyncio, logging, os, subprocess
import aiohttp
from aiohttp import web
from samsungtvws.async_remote import SamsungTVWSAsyncRemote
from samsungtvws.remote import SendRemoteKey
import wakeonlan

# ── 85" TV WebSocket config ──────────────────────────────────────────────────
TV_IP      = '192.168.1.129'
TV_MAC     = 'b0:99:d7:96:07:8e'
TV_PORT    = 8002
APP_NAME   = 'SmartHomeDashboard'
TOKEN_FILE = '/opt/media-agent/tv_token.txt'
PORT       = 8765

# ── Secrets from environment ──────────────────────────────────────────────────
HA_URL   = os.environ.get('HA_URL',   'http://192.168.1.110:8123')
HA_TOKEN = os.environ.get('HA_TOKEN', '')
ST_TOKEN = os.environ.get('ST_TOKEN', '')
ST_URL   = 'https://api.smartthings.com/v1'

# ── Device identifiers ────────────────────────────────────────────────────────
TV_SWITCH     = 'switch.samsung_85_qled'
TV_PLAYER     = 'media_player.samsung_85_qled'
TV_GUY_ENTITY = 'media_player.samsung_q60ba_50_tv_2'
TV_BED_ENTITY = 'media_player.samsung_q49_ba_tv'
ST_TV_ID      = 'af0bbfed-6ee9-46a7-d773-8daa1af7dcfb'
ST_SB_ID      = 'b3b66213-0f44-be4e-ccdb-b4cb2c7ba80a'
ST_TVB_ID      = '040d4844-8260-4441-90aa-75ee95d3e327'
SB_SWITCH      = 'switch.samsung_soundbar'
SB_PLAYER      = 'media_player.samsung_soundbar_2'

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

# ── 85" TV WebSocket ──────────────────────────────────────────────────────────
def get_ws():
    return SamsungTVWSAsyncRemote(
        host=TV_IP, port=TV_PORT,
        token_file=TOKEN_FILE,
        name=APP_NAME, timeout=5,
    )

# ── HA helpers ────────────────────────────────────────────────────────────────
async def ha_get(session, path):
    try:
        async with session.get(
            f'{HA_URL}{path}',
            headers={'Authorization': f'Bearer {HA_TOKEN}'}
        ) as r:
            if r.status == 200:
                return await r.json()
    except Exception as e:
        log.warning(f'HA GET {path} failed: {e}')
    return None

async def ha_post(session, path, body):
    try:
        async with session.post(
            f'{HA_URL}{path}',
            headers={'Authorization': f'Bearer {HA_TOKEN}', 'Content-Type': 'application/json'},
            json=body
        ) as r:
            return r.status < 300
    except Exception as e:
        log.warning(f'HA POST {path} failed: {e}')
    return False

# ── SmartThings helpers ───────────────────────────────────────────────────────
async def st_get(session, device_id):
    try:
        async with session.get(
            f'{ST_URL}/devices/{device_id}/status',
            headers={'Authorization': f'Bearer {ST_TOKEN}'}
        ) as r:
            if r.status == 200:
                return await r.json()
    except Exception as e:
        log.warning(f'ST GET {device_id} failed: {e}')
    return None

async def st_cmd(session, device_id, capability, command, args=None):
    try:
        body = {'commands': [{'component': 'main', 'capability': capability,
                              'command': command, 'arguments': args or []}]}
        async with session.post(
            f'{ST_URL}/devices/{device_id}/commands',
            headers={'Authorization': f'Bearer {ST_TOKEN}', 'Content-Type': 'application/json'},
            json=body
        ) as r:
            return r.status < 300
    except Exception as e:
        log.warning(f'ST CMD {device_id} {command} failed: {e}')
    return False

def parse_st(d, soundbar=False):
    if not d:
        return {'power': None, 'volume': None, 'muted': False, 'input': None, 'supportedInputs': []}
    m   = (d.get('components') or {}).get('main') or {}
    cap = 'samsungvd.audioInputSource' if soundbar else 'mediaInputSource'
    return {
        'power':           (m.get('switch') or {}).get('switch', {}).get('value'),
        'volume':          (m.get('audioVolume') or {}).get('volume', {}).get('value'),
        'muted':           (m.get('audioMute') or {}).get('mute', {}).get('value') == 'muted',
        'input':           (m.get(cap) or {}).get('inputSource', {}).get('value'),
        'supportedInputs': (m.get(cap) or {}).get('supportedInputSources', {}).get('value') or [],
    }

# ── media_player.state → power ('on'/'off') ───────────────────────────────────
# media_player is the fresher power signal: the SmartThings `switch.*` lags badly
# (it does NOT reflect a remote-initiated power-on, so it sits at stale 'off' for
# hours while the TV/soundbar are actually on). Trust the media_player; fall back
# to the switch only when the media_player is unavailable/unknown.
_MP_ON  = {'on', 'idle', 'playing', 'paused', 'buffering'}
_MP_OFF = {'off', 'standby'}
def mp_power(player, fallback_switch=None):
    st = (player or {}).get('state')
    if st in _MP_ON:
        return 'on'
    if st in _MP_OFF:
        return 'off'
    sw = (fallback_switch or {}).get('state')
    if sw == 'on':
        return 'on'
    if sw == 'off':
        return 'off'
    return 'off'


# ── GET /media/state ──────────────────────────────────────────────────────────
async def media_state(_req):
    async with aiohttp.ClientSession() as s:
        tv_switch, tv_player, tv_st, tv_guy, sb_raw, sb_switch, sb_player, tvb_st, tvb_ha = await asyncio.gather(
            ha_get(s, f'/api/states/{TV_SWITCH}'),
            ha_get(s, f'/api/states/{TV_PLAYER}'),
            st_get(s, ST_TV_ID),
            ha_get(s, f'/api/states/{TV_GUY_ENTITY}'),
            st_get(s, ST_SB_ID),
            ha_get(s, f'/api/states/{SB_SWITCH}'),
            ha_get(s, f'/api/states/{SB_PLAYER}'),
            st_get(s, ST_TVB_ID),
            ha_get(s, f'/api/states/{TV_BED_ENTITY}'),
        )

    tv_st_p = parse_st(tv_st)
    tv_vol  = (tv_player or {}).get('attributes', {}).get('volume_level')
    tv = {
        'power':           mp_power(tv_player, tv_switch),
        'volume':          round(tv_vol * 100) if tv_vol is not None else tv_st_p['volume'],
        'muted':           (tv_player or {}).get('attributes', {}).get('is_volume_muted', False),
        'input':           (tv_player or {}).get('attributes', {}).get('source'),
        'supportedInputs': (tv_player or {}).get('attributes', {}).get('source_list') or [],
    }

    tvg_vol = (tv_guy or {}).get('attributes', {}).get('volume_level')
    tv_guy_data = {
        'power':           'on' if (tv_guy or {}).get('state') == 'on' else 'off',
        'volume':          round(tvg_vol * 100) if tvg_vol is not None else None,
        'muted':           (tv_guy or {}).get('attributes', {}).get('is_volume_muted', False),
        'input':           (tv_guy or {}).get('attributes', {}).get('source'),
        'supportedInputs': (tv_guy or {}).get('attributes', {}).get('source_list') or [],
    }

    tvb_st_p = parse_st(tvb_st)
    tvb_vol  = (tvb_ha or {}).get('attributes', {}).get('volume_level')
    tv_bed_data = {
        'power':           tvb_st_p['power'],
        'volume':          round(tvb_vol * 100) if tvb_vol is not None else None,
        'muted':           (tvb_ha or {}).get('attributes', {}).get('is_volume_muted', False),
        'input':           (tvb_ha or {}).get('attributes', {}).get('source'),
        'supportedInputs': (tvb_ha or {}).get('attributes', {}).get('source_list') or [],
    }

    return web.json_response({
        'tv':      tv,
        'tvGuy':   tv_guy_data,
        'tvBed':   tv_bed_data,
        'soundbar': (lambda st, sw, pl: {
            'power':           mp_power(pl, sw),
            'volume':          round((pl or {}).get('attributes', {}).get('volume_level', 0) * 100) if (pl or {}).get('attributes', {}).get('volume_level') is not None else st['volume'],
            'muted':           (pl or {}).get('attributes', {}).get('is_volume_muted', st['muted']),
            'input':           st['input'],
            'supportedInputs': st['supportedInputs'],
        })(parse_st(sb_raw, soundbar=True), sb_switch, sb_player),
    })

# Soundbar volume: it advertises VOLUME_SET but NOT VOLUME_STEP, so HA's
# volume_up/down service would 400. Emulate by reading the current level and
# setting it ±step (clamped 0..1).
async def ha_sb_volume(session, direction, step=0.05):
    st  = await ha_get(session, f'/api/states/{SB_PLAYER}')
    cur = ((st or {}).get('attributes') or {}).get('volume_level')
    if cur is None:
        return
    new = max(0.0, min(1.0, cur + direction * step))
    await ha_post(session, '/api/services/media_player/volume_set',
                  {'entity_id': SB_PLAYER, 'volume_level': round(new, 3)})


# ── POST /media/command ───────────────────────────────────────────────────────
async def media_command(req):
    data    = await req.json()
    entity  = data.get('entity')
    command = data.get('command')
    value   = data.get('value')

    async with aiohttp.ClientSession() as s:
        try:
            if entity == 'tv':
                if   command == 'turn_on':    await ha_post(s, '/api/services/switch/turn_on',  {'entity_id': TV_SWITCH})
                elif command == 'turn_off':   await ha_post(s, '/api/services/switch/turn_off', {'entity_id': TV_SWITCH})
                elif command == 'volume_up':  await ha_post(s, '/api/services/media_player/volume_up',   {'entity_id': TV_PLAYER})
                elif command == 'volume_down':await ha_post(s, '/api/services/media_player/volume_down', {'entity_id': TV_PLAYER})
                elif command == 'mute':       await ha_post(s, '/api/services/media_player/volume_mute', {'entity_id': TV_PLAYER, 'is_volume_muted': value})
                elif command == 'source':     await ha_post(s, '/api/services/media_player/select_source', {'entity_id': TV_PLAYER, 'source': value})
                else:
                    tv_ws = get_ws()
                    async with tv_ws:
                        await tv_ws.send_command(SendRemoteKey.click(command))

            elif entity == 'tv_guy':
                if   command == 'turn_on':    await ha_post(s, '/api/services/media_player/turn_on',  {'entity_id': TV_GUY_ENTITY})
                elif command == 'turn_off':   await ha_post(s, '/api/services/media_player/turn_off', {'entity_id': TV_GUY_ENTITY})
                elif command == 'volume_up':  await ha_post(s, '/api/services/media_player/volume_up',   {'entity_id': TV_GUY_ENTITY})
                elif command == 'volume_down':await ha_post(s, '/api/services/media_player/volume_down', {'entity_id': TV_GUY_ENTITY})
                elif command == 'mute':       await ha_post(s, '/api/services/media_player/volume_mute', {'entity_id': TV_GUY_ENTITY, 'is_volume_muted': value})
                elif command == 'source':     await ha_post(s, '/api/services/media_player/select_source', {'entity_id': TV_GUY_ENTITY, 'source': value})

            elif entity == 'tv_bed':
                # Migrated off the expired SmartThings PAT to HA media_player.
                if   command == 'turn_on':    await ha_post(s, '/api/services/media_player/turn_on',  {'entity_id': TV_BED_ENTITY})
                elif command == 'turn_off':   await ha_post(s, '/api/services/media_player/turn_off', {'entity_id': TV_BED_ENTITY})
                elif command == 'volume_up':  await ha_post(s, '/api/services/media_player/volume_up',   {'entity_id': TV_BED_ENTITY})
                elif command == 'volume_down':await ha_post(s, '/api/services/media_player/volume_down', {'entity_id': TV_BED_ENTITY})
                elif command == 'mute':       await ha_post(s, '/api/services/media_player/volume_mute', {'entity_id': TV_BED_ENTITY, 'is_volume_muted': value})
                elif command == 'source':     await ha_post(s, '/api/services/media_player/select_source', {'entity_id': TV_BED_ENTITY, 'source': value})

            elif entity == 'soundbar':
                # Migrated off the expired SmartThings PAT to HA media_player
                # (media_player.samsung_soundbar_2 supports turn_on/off, volume_set,
                # mute, select_source — features 318399). volume_up/down via helper.
                if   command == 'turn_on':    await ha_post(s, '/api/services/media_player/turn_on',  {'entity_id': SB_PLAYER})
                elif command == 'turn_off':   await ha_post(s, '/api/services/media_player/turn_off', {'entity_id': SB_PLAYER})
                elif command == 'volume_up':  await ha_sb_volume(s, +1)
                elif command == 'volume_down':await ha_sb_volume(s, -1)
                elif command == 'mute':       await ha_post(s, '/api/services/media_player/volume_mute', {'entity_id': SB_PLAYER, 'is_volume_muted': value})
                elif command == 'source':     await ha_post(s, '/api/services/media_player/select_source', {'entity_id': SB_PLAYER, 'source': value})
            else:
                return web.json_response({'error': 'Unknown entity'}, status=400)

            return web.json_response({'ok': True})
        except Exception as e:
            log.error(f'Command {entity}/{command} failed: {e}')
            return web.json_response({'error': str(e)}, status=500)

# ── Legacy routes (85" TV direct WebSocket — kept for compatibility) ───────────
async def legacy_state(_req):
    result = subprocess.run(['ping', '-c', '1', '-W', '1', TV_IP], capture_output=True)
    power = 'on' if result.returncode == 0 else 'off'
    return web.json_response({'power': power, 'source': None, 'volume': None})

async def legacy_command(req):
    data    = await req.json()
    command = data.get('command')
    value   = data.get('value')
    try:
        if command == 'turn_on':
            wakeonlan.send_magic_packet(TV_MAC, ip_address='192.168.1.255', port=9)
            wakeonlan.send_magic_packet(TV_MAC, ip_address=TV_IP, port=9)
            return web.json_response({'ok': True, 'method': 'wol'})
        tv_ws = get_ws()
        async with tv_ws:
            key_map = {'turn_off': 'KEY_POWER', 'volume_up': 'KEY_VOLUP',
                       'volume_down': 'KEY_VOLDOWN', 'mute': 'KEY_MUTE'}
            key = key_map.get(command) or (value if command == 'key' else None)
            if key:
                await tv_ws.send_command(SendRemoteKey.click(key))
            else:
                return web.json_response({'error': f'Unknown command: {command}'}, status=400)
        return web.json_response({'ok': True})
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)

app = web.Application()
app.router.add_get('/media/state',    media_state)
app.router.add_post('/media/command', media_command)
app.router.add_get('/state',          legacy_state)
app.router.add_post('/command',       legacy_command)

if __name__ == '__main__':
    log.info(f'Media agent starting on port {PORT}')
    web.run_app(app, host='0.0.0.0', port=PORT)
