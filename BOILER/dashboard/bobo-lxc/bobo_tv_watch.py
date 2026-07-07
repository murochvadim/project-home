#!/usr/bin/env python3
"""
BoBo TV auto-switch — LXC 100 (bobo-tv-watch.service).

Step ON the board  → BoBo connects → its pos stream flows → turn the balcony TV ON + open the game.
Step OFF the board → BoBo disconnects → stream stops → turn the TV OFF after a grace delay.

Uses the SAME fast signal the game uses: the `pos` MQTT stream (~10 Hz while someone's on the board;
stops within ~2.5 s of stepping off — the bridge firmware gates it on a live BLE link). TV on/off goes
through the media agent's tv_control.py (:8765, entity 'tv55' = SmartThings, reliable — same path the
balcony panel uses). The game is shown by relaunching the TV browser (tv_launch.py → DIAL → the browser's
Home page, which is http://192.168.1.138:8770/). All co-located on LXC 100.

Tunables (env, all optional): BOBO_TV_OFF_DELAY (s, default 60), BOBO_TV_ON_SUSTAIN (s, default 2),
BOBO_TV_CONNECT_GAP (s, default 3). Disable anytime: `systemctl stop bobo-tv-watch`.
"""
import os, time, json, subprocess, threading, logging, urllib.request
import paho.mqtt.client as mqtt

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('bobo-tv-watch')

MQTT_HOST = '192.168.1.189'; MQTT_PORT = 1883
MQTT_USER = 'esp_boards';    MQTT_PASS = os.environ.get('ESP_BOARDS_MQTT_PASS', '')
POS_TOPIC = 'mur/home/esp/balcony_bridge/pos'

TV_CMD_URL = 'http://127.0.0.1:8765/media/command'   # tv_control.py media_command
TV_DIAL    = 'http://192.168.1.199:8080/ws/app/WebBrowser'   # DIAL app endpoint (200 when ready; root / is 403)
VENV_PY    = '/opt/media-agent/venv/bin/python3'
LAUNCH_PY  = '/opt/media-agent/tv_launch.py'

CONNECT_GAP = float(os.environ.get('BOBO_TV_CONNECT_GAP', '3'))   # no frame within this ⇒ disconnected
ON_SUSTAIN  = float(os.environ.get('BOBO_TV_ON_SUSTAIN',  '2'))   # connected this long before TV on (anti-flap)
OFF_DELAY   = float(os.environ.get('BOBO_TV_OFF_DELAY',   '60'))  # no frames this long ⇒ TV off
POLL        = 1.0

_last_frame = 0.0
_lock = threading.Lock()

def on_connect(c, u, f, rc):
    c.subscribe(POS_TOPIC, 0)
    log.info('mqtt connected rc=%s, subscribed %s', rc, POS_TOPIC)

def on_message(c, u, m):
    global _last_frame
    try:
        d = json.loads(m.payload.decode())
        if isinstance(d.get('x'), (int, float)):
            with _lock:
                _last_frame = time.time()
    except Exception:
        pass

def tv(cmd):
    try:
        req = urllib.request.Request(TV_CMD_URL,
                                     data=json.dumps({'entity': 'tv55', 'command': cmd}).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(req, timeout=10)
        log.info('TV %s sent', cmd)
    except Exception as e:
        log.warning('TV %s failed: %s', cmd, e)

def dial_ready(timeout=120):
    # Cold-boot: the TV powers on then takes ~30-90 s before its DIAL (port 8080) answers.
    t = time.time()
    while time.time() - t < timeout:
        try:
            urllib.request.urlopen(TV_DIAL, timeout=3); return True
        except Exception:
            time.sleep(2)
    return False

def launch_browser():
    try:
        subprocess.run([VENV_PY, LAUNCH_PY], timeout=40)
        log.info('browser relaunched (→ game)')
    except Exception as e:
        log.warning('browser launch failed: %s', e)

def turn_on_and_show():
    tv('turn_on')
    if dial_ready():
        launch_browser()
    else:
        log.warning('TV DIAL not ready after power-on — game not launched (TV may still be booting)')

def main():
    cli = mqtt.Client()
    cli.username_pw_set(MQTT_USER, MQTT_PASS)
    cli.on_connect = on_connect
    cli.on_message = on_message
    cli.connect(MQTT_HOST, MQTT_PORT, 60)
    cli.loop_start()
    log.info('bobo-tv-watch started (on_sustain=%ss off_delay=%ss)', ON_SUSTAIN, OFF_DELAY)

    tv_on = False          # whether WE currently have the TV on for the game
    on_since = None        # first moment we've seen a continuous connection
    gap_since = None       # first moment frames stopped (for off-delay)
    while True:
        time.sleep(POLL)
        with _lock:
            lf = _last_frame
        now = time.time()
        connected = (now - lf) < CONNECT_GAP
        if connected:
            gap_since = None
            if on_since is None:
                on_since = now
            if not tv_on and (now - on_since) >= ON_SUSTAIN:
                log.info('BoBo connected → TV on + game')
                threading.Thread(target=turn_on_and_show, daemon=True).start()
                tv_on = True
        else:
            on_since = None
            if tv_on:
                if gap_since is None:
                    gap_since = now
                elif (now - gap_since) >= OFF_DELAY:
                    log.info('BoBo disconnected %ds → TV off', int(OFF_DELAY))
                    tv('turn_off')
                    tv_on = False
                    gap_since = None

if __name__ == '__main__':
    main()
