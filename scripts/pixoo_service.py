#!/usr/bin/env python3
"""Pixoo64 LED display service for home automation.

Connects to MQTT for home state, rotates display screens,
writes heartbeat to PostgreSQL.

Runs on LXC 100 (192.168.1.138).
"""

import base64
import io
import json
import logging
import os
import signal
import threading
import time
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from zoneinfo import ZoneInfo

import paho.mqtt.client as mqtt
import psycopg2

from pixoo import Pixoo

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pixoo_service")

# ---------------------------------------------------------------------------
# Config from environment
# ---------------------------------------------------------------------------
PIXOO_IP = os.getenv("PIXOO_IP", "192.168.1.243")
MQTT_BROKER = os.getenv("MQTT_BROKER", "192.168.1.189")
MQTT_USER = os.getenv("MQTT_USER", "pixoo_service")
MQTT_PASS = os.getenv("MQTT_PASS", "")
DB_HOST = os.getenv("DB_HOST", "192.168.1.219")
DB_NAME = os.getenv("DB_NAME", "home_data")
DB_USER = os.getenv("DB_USER", "postgres")

TZ = ZoneInfo("Asia/Jerusalem")

SCREEN_INTERVAL = 10   # seconds between screen rotations
HEARTBEAT_INTERVAL = 60  # seconds between heartbeat writes

LWT_TOPIC = "mur/home/pixoo/state"
SUBSCRIBE_TOPIC = "mur/home/rule-engine/computed/+"

STATE_KEYS = [
    "people_home",
    "occupied_rooms",
    "home_mode",
    "activity_level",
    "active_rooms",
    "last_motion_room",
]


class PixooService:
    """Main Pixoo64 display service."""

    def __init__(self):
        self.stopped = False

        # In-memory home state from MQTT
        self.state: dict = {}

        # Pixoo display (connected lazily in run())
        self.pixoo = None

        # Screen rotation
        self.screens = [
            self.render_clock,
            self.render_home_status,
            self.render_weather,
            self.render_boiler,
        ]
        self.current_screen = 0

        # DB connection (lazy)
        self.db = None

        # MQTT client
        self.mqtt = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="pixoo_service",
        )
        self.mqtt.username_pw_set(MQTT_USER, MQTT_PASS)
        self.mqtt.will_set(
            LWT_TOPIC,
            payload=json.dumps({"state": "offline"}),
            qos=1,
            retain=True,
        )
        self.mqtt.on_connect = self._on_connect
        self.mqtt.on_message = self._on_message
        self.mqtt.on_disconnect = self._on_disconnect

        # Timestamps
        self._last_heartbeat = 0.0
        self._paused = False

    # ------------------------------------------------------------------
    # MQTT callbacks
    # ------------------------------------------------------------------
    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            log.info("MQTT connected to %s", MQTT_BROKER)
            client.subscribe(SUBSCRIBE_TOPIC, qos=1)
            client.publish(
                LWT_TOPIC,
                payload=json.dumps({"state": "online"}),
                qos=1,
                retain=True,
            )
        else:
            log.error("MQTT connect failed rc=%s", rc)

    def _on_message(self, client, userdata, msg):
        try:
            key = msg.topic.rsplit("/", 1)[-1]
            raw = json.loads(msg.payload.decode())
            # Computed state topics wrap value in {"value": ..., "ts": ...}
            value = raw.get('value', raw) if isinstance(raw, dict) else raw
            self.state[key] = value
            log.debug("State update: %s = %s", key, value)
        except Exception:
            log.exception("Failed to parse MQTT message on %s", msg.topic)

    def _on_disconnect(self, client, userdata, flags, rc, properties=None):
        if rc != 0:
            log.warning("MQTT disconnected unexpectedly rc=%s, will auto-reconnect", rc)

    # ------------------------------------------------------------------
    # DB helpers
    # ------------------------------------------------------------------
    def _ensure_db(self):
        """Reconnect to PostgreSQL if needed."""
        if self.db is not None:
            try:
                self.db.cursor().execute("SELECT 1")
                return
            except Exception:
                log.warning("DB connection lost, reconnecting")
                try:
                    self.db.close()
                except Exception:
                    pass
                self.db = None

        try:
            self.db = psycopg2.connect(
                host=DB_HOST,
                dbname=DB_NAME,
                user=DB_USER,
            )
            self.db.autocommit = True
            log.info("DB connected to %s/%s", DB_HOST, DB_NAME)
        except Exception:
            log.exception("DB connect failed")
            self.db = None

    def _check_paused(self):
        """Check if dashboard paused the service via DB flag."""
        self._ensure_db()
        if self.db is None:
            return
        try:
            with self.db.cursor() as cur:
                cur.execute("SELECT value FROM rule_engine_state WHERE key = '_pixoo_paused'")
                row = cur.fetchone()
                if row:
                    self._paused = row[0] is True or row[0] == 'true'
                else:
                    self._paused = False
        except Exception:
            pass

    def write_heartbeat(self):
        """Write heartbeat row to pixoo_log + check pause flag."""
        now = time.time()
        if now - self._last_heartbeat < HEARTBEAT_INTERVAL:
            return

        self._last_heartbeat = now
        self._check_paused()
        self._ensure_db()
        if self.db is None:
            return

        try:
            with self.db.cursor() as cur:
                cur.execute(
                    "INSERT INTO pixoo_log (decision, error, next_ts) "
                    "VALUES (%s, %s, NOW() + INTERVAL '1 minute')",
                    (f"Screen: {self.screens[self.current_screen].__name__.replace('render_', '')}", "NO ERROR"),
                )
            log.debug("Heartbeat written")
        except psycopg2.errors.UndefinedTable:
            log.warning("pixoo_log table does not exist yet — skipping heartbeat")
        except Exception:
            log.exception("Heartbeat write failed")

    # ------------------------------------------------------------------
    # Screen stubs
    # ------------------------------------------------------------------
    def render_clock(self):
        try:
            now = datetime.now(tz=TZ)
            self.pixoo.clear()
            self._screen_items = []
            self._draw(now.strftime("%H:%M"), 8, 20, 255, 255, 255)
            self._draw(now.strftime("%a %d %b"), 4, 40, 128, 128, 128)
            self.pixoo.push()
        except Exception:
            log.exception("render_clock failed")

    def render_home_status(self):
        try:
            self.pixoo.clear()
            self._screen_items = []
            mode = self.state.get("home_mode", "?")
            mc = {"active": (0,200,0), "idle": (200,200,0), "away": (128,128,128)}
            r, g, b = mc.get(mode, (128,128,128))
            self._draw(f"HOME: {mode}", 2, 2, r, g, b)
            people = self.state.get("people_home", 0)
            self._draw(f"People: {people}", 2, 14, 255, 255, 255)
            rooms = self.state.get("active_rooms", [])
            if rooms:
                for i, room in enumerate(rooms[:3]):
                    self._draw(str(room)[:10], 2, 26 + i * 12, 0, 200, 200)
            else:
                self._draw("No activity", 2, 26, 128, 128, 128)
            self.pixoo.push()
        except Exception:
            log.exception("render_home_status failed")

    def render_weather(self):
        try:
            self.pixoo.clear()
            self._screen_items = []
            self._draw("WEATHER", 2, 2, 100, 150, 255)

            self._ensure_db()
            if self.db is None:
                self._draw("No data", 2, 20, 128, 128, 128)
                self.pixoo.push()
                return

            with self.db.cursor() as cur:
                cur.execute(
                    "SELECT temp_balcony, humidity_balcony, uv_index_balcony, condition "
                    "FROM raw_weather ORDER BY ts DESC LIMIT 1"
                )
                row = cur.fetchone()

            if row:
                temp, humidity, uv, condition = row
                self._draw(f"{temp:.0f}C" if temp is not None else "N/A", 2, 14, 255, 255, 255)
                self._draw(str(condition)[:10] if condition else "N/A", 2, 26, 200, 200, 200)
                self._draw(f"Hum: {humidity:.0f}%" if humidity is not None else "Hum: N/A", 2, 38, 100, 200, 255)
                self._draw(f"UV: {uv:.0f}" if uv is not None else "UV: N/A", 2, 50, 255, 200, 0)
            else:
                self._draw("No data", 2, 20, 128, 128, 128)

            self.pixoo.push()
        except Exception:
            log.exception("render_weather failed")

    def render_boiler(self):
        try:
            self.pixoo.clear()
            self._screen_items = []
            self._draw("BOILER", 2, 2, 255, 150, 0)

            self._ensure_db()
            if self.db is None:
                self._draw("No data", 2, 20, 128, 128, 128)
                self.pixoo.push()
                return

            with self.db.cursor() as cur:
                cur.execute(
                    "SELECT boiler_temp, panel_temp, valve_state "
                    "FROM agent_boiler_data ORDER BY ts DESC LIMIT 1"
                )
                row = cur.fetchone()

            if row:
                boiler_temp, panel_temp, valve = row
                self._draw(f"Panel:{panel_temp:.1f}" if panel_temp is not None else "Panel:N/A", 2, 14, 255, 200, 100)
                self._draw(f"Boilr:{boiler_temp:.1f}" if boiler_temp is not None else "Boilr:N/A", 2, 26, 255, 200, 100)
                if valve:
                    self._draw("Valve: ON", 2, 38, 0, 200, 0)
                else:
                    self._draw("Valve: OFF", 2, 38, 200, 0, 0)
            else:
                self._draw("No data", 2, 20, 128, 128, 128)

            self.pixoo.push()
        except Exception:
            log.exception("render_boiler failed")

    # ------------------------------------------------------------------
    # Screen rotation
    # ------------------------------------------------------------------
    def rotate_screen(self):
        """Call the current screen render function and advance index."""
        # Check if paused by dashboard (manual channel switch)
        if self._paused:
            return
        fn = self.screens[self.current_screen]
        screen_name = fn.__name__.replace('render_', '')
        try:
            fn()
            log.debug("Rendered screen %s (%s)", self.current_screen, screen_name)
        except Exception:
            log.exception("Screen render failed: %s", screen_name)

        # Publish current screen info to MQTT for dashboard
        self._publish_screen_info(screen_name)
        self.current_screen = (self.current_screen + 1) % len(self.screens)

    def _publish_screen_info(self, screen_name):
        """Store screen content in DB + MQTT for dashboard mirror."""
        info = {
            'screen': screen_name,
            'ts': datetime.now(tz=TZ).isoformat(),
            'items': getattr(self, '_screen_items', []),
        }
        # Store in DB for dashboard to read
        self._ensure_db()
        if self.db:
            try:
                with self.db.cursor() as cur:
                    cur.execute(
                        "INSERT INTO rule_engine_state (key, value, updated_at) "
                        "VALUES ('_pixoo_screen', %s::jsonb, NOW()) "
                        "ON CONFLICT (key) DO UPDATE SET value = %s::jsonb, updated_at = NOW()",
                        (json.dumps(info), json.dumps(info)),
                    )
            except Exception:
                pass
        # Also publish to MQTT
        try:
            self.mqtt_client.publish('mur/home/pixoo/screen', json.dumps(info), retain=True, qos=0)
        except Exception:
            pass

    def _draw(self, text, x, y, r, g, b):
        """Draw text on Pixoo + record for dashboard mirror."""
        self.pixoo.draw_text(text, (x, y), (r, g, b))
        self._screen_items.append({'t': text, 'x': x, 'y': y, 'r': r, 'g': g, 'b': b})

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def connect_pixoo(self):
        """Initialize connection to the Pixoo64 display."""
        log.info("Connecting to Pixoo at %s", PIXOO_IP)
        self.pixoo = Pixoo(PIXOO_IP, 64)
        log.info("Pixoo connected")

    def connect_mqtt(self):
        """Connect MQTT client and start background loop."""
        log.info("Connecting MQTT to %s as %s", MQTT_BROKER, MQTT_USER)
        self.mqtt.connect(MQTT_BROKER, 1883, keepalive=60)
        self.mqtt.loop_start()

    def _start_http_server(self):
        """Start HTTP server for dashboard push commands on port 8768."""
        svc = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    body = json.loads(self.rfile.read(length)) if length else {}

                    if self.path == '/push':
                        items = body.get('items', [])
                        image = body.get('image')

                        svc.pixoo.clear()

                        # Draw background image if provided (base64 data URL)
                        if image and ',' in image:
                            try:
                                from PIL import Image
                                img_data = base64.b64decode(image.split(',')[1])
                                img = Image.open(io.BytesIO(img_data)).convert('RGB').resize((64, 64))
                                svc.pixoo.draw_image(img)
                            except Exception:
                                log.exception("Image draw failed")

                        # Draw text items — use Pillow for larger fonts
                        from PIL import Image as PILImage, ImageDraw, ImageFont
                        # Get current frame as PIL image for text overlay
                        txt_img = PILImage.new('RGB', (64, 64), (0, 0, 0))
                        draw = ImageDraw.Draw(txt_img)
                        has_large = any(item.get('sz', 1) > 1 for item in items)

                        for item in items:
                            sz = item.get('sz', 1)
                            text = str(item.get('t', ''))
                            x = item.get('x', 0)
                            y = item.get('y', 0)
                            color = (item.get('r', 255), item.get('g', 255), item.get('b', 255))
                            if sz <= 1:
                                # Small: use pixoo built-in font
                                svc.pixoo.draw_text(text, (x, y), color)
                            else:
                                # Medium/Large: draw via Pillow
                                font_size = sz * 8
                                try:
                                    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", font_size)
                                except Exception:
                                    font = ImageFont.load_default()
                                draw.text((x, y), text, fill=color, font=font)

                        # Overlay Pillow text image if any large text was drawn
                        if has_large:
                            svc.pixoo.draw_image(txt_img)

                        svc.pixoo.push()
                        svc._paused = True  # pause rotation

                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.end_headers()
                        self.wfile.write(b'{"ok":true}')
                    else:
                        self.send_response(404)
                        self.end_headers()
                except Exception as e:
                    log.exception("HTTP handler error")
                    self.send_response(500)
                    self.end_headers()

            def do_OPTIONS(self):
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'POST')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.end_headers()

            def log_message(self, format, *args):
                pass  # suppress access logs

        server = HTTPServer(('0.0.0.0', 8768), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        log.info("HTTP server started on port 8768")

    def run(self):
        """Main service loop."""
        self.connect_pixoo()
        self.connect_mqtt()
        self._start_http_server()

        log.info("Service started — %d screens, %ds interval", len(self.screens), SCREEN_INTERVAL)

        while not self.stopped:
            try:
                self._check_paused()
                self.rotate_screen()
                self.write_heartbeat()
            except Exception:
                log.exception("Main loop error")

            time.sleep(SCREEN_INTERVAL)

    def shutdown(self):
        """Clean shutdown."""
        log.info("Shutting down")
        self.stopped = True

        try:
            self.mqtt.publish(
                LWT_TOPIC,
                payload=json.dumps({"state": "offline"}),
                qos=1,
                retain=True,
            )
            self.mqtt.loop_stop()
            self.mqtt.disconnect()
        except Exception:
            log.exception("MQTT disconnect error")

        if self.db is not None:
            try:
                self.db.close()
            except Exception:
                pass

        log.info("Shutdown complete")


# ----------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------
def main():
    service = PixooService()

    def _handle_signal(signum, frame):
        log.info("Received signal %s", signum)
        service.shutdown()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        service.run()
    except Exception:
        log.exception("Fatal error")
        service.shutdown()
        raise


if __name__ == "__main__":
    main()
