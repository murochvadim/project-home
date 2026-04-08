"""
MQTT client for the Rule Engine.

Adapted from Device Agent's MqttPublisher with rule-engine topic prefix,
command publishing (QoS 1), and computed state publishing.

Requires: paho-mqtt >= 2.0
"""

import json
import logging
import os
import threading
from datetime import datetime

import paho.mqtt.client as mqtt

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from backports.zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Jerusalem')

log = logging.getLogger('rule_engine.mqtt')

TOPIC_PREFIX = 'mur/home/rule-engine'

# Credentials from environment
MQTT_BROKER = os.environ.get('MQTT_BROKER', '192.168.1.189')
MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))
MQTT_USER = os.environ.get('MQTT_USER', 'rule_engine')
MQTT_PASS = os.environ.get('MQTT_PASS', '')


def _now_iso() -> str:
    """Return current time as ISO8601 string in Asia/Jerusalem timezone."""
    return datetime.now(tz=TZ).isoformat()


class MqttClient:
    """MQTT client for Rule Engine — connect, subscribe, publish commands and computed state."""

    def __init__(self):
        """Initialize MQTT client using env-var credentials.

        LWT topic: mur/home/rule-engine/state → {"state":"offline"}
        Client ID: rule-engine-105
        """
        self._broker = MQTT_BROKER
        self._port = MQTT_PORT
        self._lwt_topic = f'{TOPIC_PREFIX}/state'
        self._connected = False
        self._enabled = True
        self._drop_warned = False

        # Stored for republish on reconnect
        self._rule_count = 0
        self._lock = threading.Lock()

        if not MQTT_PASS:
            log.error('MQTT_PASS not set — MQTT publishing disabled')
            self._enabled = False
            self._client = None
            return

        # paho-mqtt v2.x requires CallbackAPIVersion
        self._client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id='rule-engine-105',
            protocol=mqtt.MQTTv311,
        )
        self._client.username_pw_set(MQTT_USER, MQTT_PASS)

        # LWT: broker publishes this when client disconnects unexpectedly
        lwt_payload = json.dumps({'state': 'offline'})
        self._client.will_set(self._lwt_topic, lwt_payload, qos=1, retain=True)

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
            self.publish_bridge_online(self._rule_count)
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
    # Subscribe
    # ------------------------------------------------------------------

    def subscribe(self, topics: list, on_message):
        """Subscribe to a list of topic patterns and set message callback.

        topics     — list of (topic_pattern, qos) tuples, e.g. [('mur/home/device/+/state', 0)]
        on_message — callback(client, userdata, message)
        """
        if not self._enabled or self._client is None:
            return
        self._subscriptions = topics
        self._client.on_message = on_message
        for topic, qos in topics:
            self._client.subscribe(topic, qos)
            log.info('MQTT subscribed to %s (qos=%d)', topic, qos)

    # ------------------------------------------------------------------
    # Rule Engine publish helpers
    # ------------------------------------------------------------------

    def publish_command(self, topic: str, payload: dict):
        """Publish a command with QoS 1 (guaranteed delivery).

        Used to send commands to device agents or other services.
        """
        self.publish(topic, payload, retain=False, qos=1)

    def publish_raw(self, topic: str, payload_str: str):
        """Publish a raw string payload (no json.dumps). For HASP commands."""
        if not self._enabled or self._client is None:
            return
        try:
            self._client.publish(topic, payload_str, qos=1, retain=False)
        except Exception:
            if not self._drop_warned:
                log.warning('MQTT raw publish failed (first drop)', exc_info=True)
                self._drop_warned = True

    def publish_bridge_online(self, rule_count: int):
        """Publish rule engine state as online (retained, QoS 1).

        Stores rule_count so _on_connect can republish after reconnect.
        """
        with self._lock:
            self._rule_count = rule_count
        payload = {
            'state': 'online',
            'rules': rule_count,
            'ts': _now_iso(),
        }
        self.publish(self._lwt_topic, payload, retain=True, qos=1)

    def publish_computed_state(self, key: str, value):
        """Publish a computed value to mur/home/rule-engine/computed/{key} (retained, QoS 0).

        Used for derived/aggregated state that other agents or the dashboard can read.
        """
        topic = f'{TOPIC_PREFIX}/computed/{key}'
        payload = {
            'value': value,
            'ts': _now_iso(),
        }
        self.publish(topic, payload, retain=True, qos=0)
