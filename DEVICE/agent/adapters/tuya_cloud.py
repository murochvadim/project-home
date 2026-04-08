"""
Tuya Cloud adapter — polls device state for cloud-only devices via Tuya OpenAPI.
Converts code-name DPS (e.g. presence_state) to numeric dp_ids so the existing
decodeStatus() logic works unchanged.
"""

import logging
import threading
import time

import tinytuya

log = logging.getLogger('tuya_cloud')

from .base import DeviceAdapter
from .tuya_config import API_REGION, API_KEY, API_SECRET

POLL_INTERVAL = 60   # seconds between polls per device
BATCH_DELAY   = 1.0  # seconds between individual API calls (rate limit)


class TuyaCloudAdapter(DeviceAdapter):
    vendor = 'tuya'

    def __init__(self, devices, on_state_change):
        super().__init__(devices, on_state_change)
        self._stop          = threading.Event()
        self._thread        = None
        self._cloud         = None
        # code_name → dp_id mapping per device_id
        self._dps_map: dict[str, dict[str, int]] = {}

    def _connect(self):
        self._cloud = tinytuya.Cloud(
            apiRegion=API_REGION,
            apiKey=API_KEY,
            apiSecret=API_SECRET,
        )

    def _fetch_dps_map(self, device_id: str) -> dict[str, int]:
        """Return {code_name: dp_id} for a device."""
        try:
            r = self._cloud.getdps(device_id)
            mapping = {}
            for entry in (r.get('result') or {}).get('status', []):
                mapping[entry['code']] = entry['dp_id']
            return mapping
        except Exception as e:
            log.warning(f'DPS map fetch failed for {device_id}: {e}')
            return {}

    def _poll_device(self, dev: dict) -> dict | None:
        """Fetch current status; returns numeric-key DPS dict or None on error."""
        device_id = dev['id']
        try:
            r = self._cloud.cloudrequest(f'/v1.0/iot-03/devices/{device_id}/status')
            if not r.get('success'):
                log.warning(f'Cloud status failed for {dev["name"]}: {r.get("msg")}')
                return None

            code_map = self._dps_map.get(device_id, {})
            dps = {}
            for item in r.get('result', []):
                code  = item['code']
                value = item['value']
                dp_id = code_map.get(code)
                if dp_id:
                    dps[str(dp_id)] = value
                else:
                    # No mapping — store under code name so it's still visible
                    dps[code] = value
            return dps
        except Exception as e:
            log.error(f'Cloud poll error for {dev["name"]}: {e}')
            return None

    def _run(self):
        self._connect()
        log.info(f'TuyaCloudAdapter: building DPS maps for {len(self.devices)} devices')
        for dev in self.devices:
            self._dps_map[dev['id']] = self._fetch_dps_map(dev['id'])
            time.sleep(BATCH_DELAY)

        log.info(f'TuyaCloudAdapter: starting poll loop (interval={POLL_INTERVAL}s)')
        while not self._stop.is_set():
            for dev in self.devices:
                if self._stop.is_set():
                    break
                dps = self._poll_device(dev)
                if dps:
                    self.on_state_change(dev['id'], dps, 'cloud_poll')
                time.sleep(BATCH_DELAY)
            # Wait remaining time before next round
            self._stop.wait(max(0, POLL_INTERVAL - len(self.devices) * BATCH_DELAY))

    def start(self):
        self._thread = threading.Thread(target=self._run, name='tuya-cloud-poll', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def get_state(self, device_id: str) -> dict:
        dev = next((d for d in self.devices if d['id'] == device_id), None)
        if not dev:
            return {}
        return self._poll_device(dev) or {}

    def set_state(self, device_id: str, dps: dict) -> bool:
        # Cloud command not implemented yet
        return False
