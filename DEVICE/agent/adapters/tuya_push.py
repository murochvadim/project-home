"""
Tuya Cloud Push adapter — receives real-time device state changes via
Tuya's Pulsar message service (WebSocket).

Replaces the 60s cloud polling for gateway and cloud devices.
All device state changes (local, gateway, cloud) are pushed instantly.
Local devices already have TCP push, so this is the safety net.
"""

import json
import logging
import threading
import time

import tinytuya
from tuya_connector import TuyaOpenAPI, TuyaOpenPulsar, TUYA_LOGGER
from tuya_connector.openpulsar import TuyaCloudPulsarTopic

log = logging.getLogger('tuya_push')

# Suppress noisy tuya_connector internal logging
TUYA_LOGGER.setLevel(logging.WARNING)

from .base import DeviceAdapter
from .tuya_config import API_REGION, API_KEY, API_SECRET, API_ENDPOINT, PULSAR_ENDPOINT


class TuyaPushAdapter(DeviceAdapter):
    """
    Subscribes to Tuya's Pulsar message service.
    Receives real-time dp_report events for ALL devices.
    Converts code-name DPS to numeric dp_ids using a pre-built map.
    """

    def __init__(self, devices, on_state_change):
        super().__init__(devices, on_state_change)
        self._stop_event = threading.Event()
        self._pulsar = None
        self._api = None
        # device_id → {code_name: dp_id} mapping
        self._dps_map: dict[str, dict[str, int]] = {}
        # Set of known device IDs for filtering
        self._known_ids = {d['id'] for d in devices}
        self._last_msg_time = time.time()

    def _build_dps_maps(self):
        """Build code_name → dp_id map for each device using Cloud API."""
        cloud = tinytuya.Cloud(apiRegion=API_REGION, apiKey=API_KEY, apiSecret=API_SECRET)
        for dev in self.devices:
            try:
                r = cloud.getdps(dev['id'])
                mapping = {}
                for entry in (r.get('result') or {}).get('status', []):
                    mapping[entry['code']] = entry['dp_id']
                self._dps_map[dev['id']] = mapping
            except Exception as e:
                log.warning(f'DPS map failed for {dev["name"]}: {e}')
            time.sleep(0.3)
        log.info(f'Built DPS maps for {len(self._dps_map)} devices')

    def _on_message(self, msg):
        """Handle incoming Pulsar message."""
        try:
            self._last_msg_time = time.time()
            log.debug(f'Push message received: {str(msg)[:200]}')
            payload = json.loads(msg) if isinstance(msg, str) else msg
            # Only handle dp_report events
            event_type = payload.get('bizCode') or payload.get('eventType')
            if event_type != 'dp_report':
                return

            data = payload.get('data', {})
            device_id = data.get('devId')
            if not device_id or device_id not in self._known_ids:
                return

            status = data.get('status', [])
            if not status:
                return

            code_map = self._dps_map.get(device_id, {})
            dps = {}
            for item in status:
                code = item.get('code', '')
                value = item.get('value')
                dp_id = code_map.get(code)
                key = str(dp_id) if dp_id else code
                dps[key] = value

            if dps:
                self.on_state_change(device_id, dps, 'cloud_push')

        except Exception as e:
            log.error(f'Push message handler error: {e}')

    def start(self):
        """Start the Pulsar subscription in a background thread."""
        t = threading.Thread(target=self._run, daemon=True, name='tuya-push')
        t.start()

    def _run(self):
        """Build DPS maps then connect to Pulsar with reconnect loop."""
        log.info(f'TuyaPushAdapter: building DPS maps for {len(self.devices)} devices')
        self._build_dps_maps()

        delay = 5
        while not self._stop_event.is_set():
            try:
                log.info('TuyaPushAdapter: connecting to Pulsar')
                self._api = TuyaOpenAPI(API_ENDPOINT, API_KEY, API_SECRET)
                self._api.connect()

                self._pulsar = TuyaOpenPulsar(
                    API_KEY, API_SECRET, PULSAR_ENDPOINT,
                    TuyaCloudPulsarTopic.PROD
                )
                self._pulsar.add_message_listener(self._on_message)
                self._pulsar.start()
                log.info('TuyaPushAdapter: Pulsar connected — receiving real-time events')
                delay = 5  # reset backoff on success

                # Keep thread alive until stopped or pulsar dies
                while not self._stop_event.is_set():
                    self._stop_event.wait(30)
                    # Check if pulsar thread is still alive
                    if self._pulsar and hasattr(self._pulsar, 'is_alive') and not self._pulsar.is_alive():
                        log.warning('TuyaPushAdapter: Pulsar thread died — reconnecting')
                        break
                    # Secondary check: no messages in 10 min → likely dead
                    if time.time() - self._last_msg_time > 600:
                        log.warning('TuyaPushAdapter: no messages in 10 min — reconnecting')
                        break

            except Exception as e:
                log.error(f'TuyaPushAdapter: Pulsar error: {e}')
            finally:
                if self._pulsar:
                    try: self._pulsar.stop()
                    except Exception: pass
                    self._pulsar = None

            if not self._stop_event.is_set():
                log.info(f'TuyaPushAdapter: reconnecting in {delay}s')
                self._stop_event.wait(delay)
                delay = min(delay * 2, 300)

    def stop(self):
        """Stop the Pulsar subscription."""
        self._stop_event.set()
        if self._pulsar:
            try:
                self._pulsar.stop()
            except Exception:
                pass
