"""
Reusable MQTT publisher with LWT, auto-reconnect, and retained state publishing.

Designed for fire-and-forget publishing — MQTT failures never block the caller.
Will be reused by Boiler/Media agents with different topic prefixes.

Requires: paho-mqtt >= 2.0
"""

import json
import logging
import threading
from datetime import datetime

import paho.mqtt.client as mqtt

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from backports.zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Jerusalem')

log = logging.getLogger('mqtt_publisher')

TOPIC_PREFIX = 'mur/home/device'


def _now_iso() -> str:
    """Return current time as ISO8601 string in Asia/Jerusalem timezone."""
    return datetime.now(tz=TZ).isoformat()


class MqttPublisher:
    """Reusable MQTT publisher with LWT, auto-reconnect, and retained state."""

    def __init__(self, broker: str, port: int, username: str, password: str,
                 client_id: str, lwt_topic: str):
        """
        broker     — Mosquitto host (e.g. '192.168.1.189')
        port       — Mosquitto port (default 1883)
        username   — MQTT username (e.g. 'device_agent')
        password   — MQTT password (required — empty means MQTT disabled)
        client_id  — unique client ID (e.g. 'device-agent-103')
        lwt_topic  — Last Will topic (e.g. 'mur/home/device/_bridge/state')
        """
        self._broker = broker
        self._port = port
        self._lwt_topic = lwt_topic
        self._connected = False
        self._enabled = True
        self._drop_warned = False

        # Stored for republish on reconnect
        self._device_count = 0
        self._adapter_count = 0
        self._lock = threading.Lock()

        if not password:
            log.error('MQTT_PASS not set — MQTT publishing disabled')
            self._enabled = False
            self._client = None
            return

        # paho-mqtt v2.x requires CallbackAPIVersion
        self._client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv311,
        )
        self._client.username_pw_set(username, password)

        # LWT: broker publishes this when client disconnects unexpectedly
        lwt_payload = json.dumps({'state': 'offline', 'ts': _now_iso()})
        self._client.will_set(lwt_topic, lwt_payload, qos=1, retain=True)

        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def connect(self):
        """Connect to broker asynchronously and start threaded network loop.

        Non-blocking — paho retries automatically if broker is unreachable.
        """
        if not self._enabled:
            return
        try:
            self._client.connect_async(self._broker, self._port)
            self._client.loop_start()
            log.info('MQTT connecting to %s:%d ...', self._broker, self._port)
        except Exception:
            log.warning('MQTT connect_async failed', exc_info=True)

    def disconnect(self):
        """Stop network loop and disconnect cleanly."""
        if not self._enabled or self._client is None:
            return
        try:
            self._client.loop_stop()
            self._client.disconnect()
            log.info('MQTT disconnected')
        except Exception:
            log.warning('MQTT disconnect error', exc_info=True)

    @property
    def is_connected(self) -> bool:
        """Return True if MQTT client is currently connected."""
        return self._connected

    # ------------------------------------------------------------------
    # Callbacks
    # ------------------------------------------------------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        """Called when connection to broker is established."""
        if reason_code == 0:
            self._connected = True
            self._drop_warned = False
            log.info('MQTT connected to %s:%d', self._broker, self._port)
            # Republish bridge online on every (re)connect
            self.publish_bridge_online(self._device_count, self._adapter_count)
            # Re-subscribe if subscriptions were set before reconnect
            if hasattr(self, '_subscriptions') and self._subscriptions:
                for topic, qos in self._subscriptions:
                    self._client.subscribe(topic, qos)
                log.info('MQTT resubscribed to %d topic(s)', len(self._subscriptions))
        else:
            log.warning('MQTT connect failed: reason_code=%s', reason_code)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        """Called when disconnected from broker. Paho auto-reconnects via loop_start."""
        self._connected = False
        if reason_code == 0:
            log.info('MQTT disconnected (clean)')
        else:
            log.warning('MQTT disconnected unexpectedly (rc=%s), reconnecting...', reason_code)

    # ------------------------------------------------------------------
    # Generic publish
    # ------------------------------------------------------------------

    def publish(self, topic: str, payload: dict, retain: bool = False, qos: int = 0):
        """Publish JSON payload to topic. Non-blocking, fire-and-forget.

        If not connected, silently drops. Logs warning on first drop only.
        """
        if not self._enabled or self._client is None:
            return
        try:
            msg = json.dumps(payload)
            self._client.publish(topic, msg, qos=qos, retain=retain)
            log.debug('MQTT pub %s (retain=%s qos=%d)', topic, retain, qos)
        except Exception:
            if not self._drop_warned:
                log.warning('MQTT publish failed (first drop)', exc_info=True)
                self._drop_warned = True

    # ------------------------------------------------------------------
    # Domain-specific publish helpers
    # ------------------------------------------------------------------

    def publish_device_state(self, device_id: str, full_state: dict, source: str):
        """Publish full merged state to mur/home/device/{id}/state (retained)."""
        topic = f'{TOPIC_PREFIX}/{device_id}/state'
        payload = {
            'dps': full_state,
            'source': source,
            'ts': _now_iso(),
        }
        self.publish(topic, payload, retain=True, qos=0)

    def publish_device_event(self, device_id: str, dps: dict, source: str):
        """Publish changed DPS to mur/home/device/{id}/event (transient)."""
        topic = f'{TOPIC_PREFIX}/{device_id}/event'
        payload = {
            'device_id': device_id,
            'dps': dps,
            'source': source,
            'ts': _now_iso(),
        }
        self.publish(topic, payload, retain=False, qos=0)

    def publish_availability(self, device_id: str, online: bool, last_seen: str):
        """Publish online/offline to mur/home/device/{id}/availability (retained, QoS 1)."""
        topic = f'{TOPIC_PREFIX}/{device_id}/availability'
        payload = {
            'online': online,
            'last_seen': last_seen,
        }
        self.publish(topic, payload, retain=True, qos=1)

    def publish_inventory(self, devices: list):
        """Publish full device list to mur/home/device/_bridge/devices (retained)."""
        topic = f'{TOPIC_PREFIX}/_bridge/devices'
        self.publish(topic, devices, retain=True, qos=0)

    def publish_bridge_online(self, device_count: int, adapter_count: int):
        """Publish bridge state as online (retained, QoS 1).

        Stores counts so on_connect can republish after reconnect.
        """
        with self._lock:
            self._device_count = device_count
            self._adapter_count = adapter_count
        payload = {
            'state': 'online',
            'devices': device_count,
            'adapters': adapter_count,
            'ts': _now_iso(),
        }
        self.publish(self._lwt_topic, payload, retain=True, qos=1)

    # ------------------------------------------------------------------
    # Subscribe (for universal MQTT ingest)
    # ------------------------------------------------------------------

    def subscribe(self, topics: list, on_message):
        """Subscribe to a list of topic patterns and set message callback.

        topics   — list of (topic_pattern, qos) tuples, e.g. [('hasp/+/state', 0)]
        on_message — callback(client, userdata, message)
        """
        if not self._enabled or self._client is None:
            return
        self._subscriptions = topics
        self._client.on_message = on_message
        for topic, qos in topics:
            self._client.subscribe(topic, qos)
            log.info('MQTT subscribed to %s (qos=%d)', topic, qos)
