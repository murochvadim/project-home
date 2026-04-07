"""
Home Connect (Siemens/Bosch) adapter — SSE event stream for real-time appliance updates.

Uses the Home Connect REST API + Server-Sent Events to receive instant state changes
for all connected appliances. No polling = no rate limit issues.

OAuth2 tokens are refreshed automatically using the stored refresh token.
"""

import json
import logging
import os
import threading
import time

import requests
import sseclient

from .base import DeviceAdapter

log = logging.getLogger('home_connect')

HC_API         = 'https://api.home-connect.com'
HC_CLIENT_ID   = os.environ.get('HC_CLIENT_ID', '')
HC_CLIENT_SECRET = os.environ.get('HC_CLIENT_SECRET', '')
HC_REFRESH_TOKEN = os.environ.get('HC_REFRESH_TOKEN', '')

RECONNECT_DELAY = 5
RECONNECT_MAX   = 120


class HomeConnectAdapter(DeviceAdapter):
    vendor = 'bsh'

    def __init__(self, devices, on_state_change):
        super().__init__(devices, on_state_change)
        self._stop_event = threading.Event()
        self._thread = None
        self._access_token = None
        self._refresh_token = HC_REFRESH_TOKEN
        # haId → device_id mapping (Home Connect haId → our DB device id)
        self._ha_id_map = {}
        # haId → connected status
        self._appliance_connected = {}
        # Our known device IDs
        self._known_ids = {d['id'] for d in devices}

    TOKEN_FILE = '/opt/device-agent/hc_refresh_token'

    def _refresh_access_token(self):
        """Get a new access token using the refresh token."""
        # Try loading persisted token first (survives restarts after rotation)
        try:
            with open(self.TOKEN_FILE, 'r') as f:
                saved = f.read().strip()
                if saved:
                    self._refresh_token = saved
        except FileNotFoundError:
            pass

        r = requests.post(f'{HC_API}/security/oauth/token', data={
            'grant_type': 'refresh_token',
            'refresh_token': self._refresh_token,
            'client_id': HC_CLIENT_ID,
            'client_secret': HC_CLIENT_SECRET,
        }, timeout=15)
        r.raise_for_status()
        data = r.json()
        self._access_token = data['access_token']
        if 'refresh_token' in data and data['refresh_token'] != self._refresh_token:
            self._refresh_token = data['refresh_token']
            try:
                with open(self.TOKEN_FILE, 'w') as f:
                    f.write(self._refresh_token)
                log.info('Home Connect: refresh token rotated and saved')
            except Exception as e:
                log.warning(f'Home Connect: failed to persist refresh token: {e}')
        log.info('Home Connect: access token refreshed')

    def _api_headers(self):
        return {
            'Authorization': f'Bearer {self._access_token}',
            'Accept': 'application/vnd.bsh.sdk.v1+json',
        }

    def _fetch_appliances(self):
        """List all appliances and build haId → device mapping."""
        r = requests.get(f'{HC_API}/api/homeappliances',
                         headers=self._api_headers(), timeout=15)
        r.raise_for_status()
        appliances = r.json().get('data', {}).get('homeappliances', [])
        log.info(f'Home Connect: found {len(appliances)} appliances')
        for a in appliances:
            ha_id = a['haId']
            name = a.get('name', '')
            self._appliance_connected[ha_id] = a.get('connected', False)
            for d in self.devices:
                if d['id'] == ha_id or d.get('name', '').lower() == name.lower():
                    self._ha_id_map[ha_id] = d['id']
                    break
        log.info(f'Home Connect: mapped {len(self._ha_id_map)} appliances to devices')

    def _fetch_status(self, ha_id):
        """Fetch current status for one appliance."""
        try:
            r = requests.get(f'{HC_API}/api/homeappliances/{ha_id}/status',
                             headers=self._api_headers(), timeout=10)
            if r.status_code == 200:
                items = r.json().get('data', {}).get('status', [])
                return {item['key']: item.get('value') for item in items}
        except Exception as e:
            log.warning(f'Home Connect: status fetch failed for {ha_id}: {e}')
        return {}

    def _fetch_all_initial_states(self):
        """Fetch initial state for all mapped appliances."""
        for ha_id, dev_id in self._ha_id_map.items():
            connected = self._appliance_connected.get(ha_id, True)
            if connected:
                dps = self._fetch_status(ha_id)
                if dps:
                    self.on_state_change(dev_id, dps, 'home_connect')
            else:
                self.on_state_change(dev_id, {'connected': False}, 'home_connect')
            time.sleep(0.5)
        log.info(f'Home Connect: initial states fetched for {len(self._ha_id_map)} appliances')

    def _handle_event(self, event):
        """Process an SSE event from Home Connect."""
        if event.event == 'KEEP-ALIVE':
            # Touch last_seen for all mapped devices so they don't appear offline
            for dev_id in self._ha_id_map.values():
                self.on_state_change(dev_id, {}, 'keepalive')
            return
        if not event.data:
            return

        try:
            data = json.loads(event.data)
            ha_id = data.get('haId')
            if not ha_id or ha_id not in self._ha_id_map:
                return

            dev_id = self._ha_id_map[ha_id]
            items = data.get('items', [])
            if not items:
                return

            dps = {}
            for item in items:
                key = item.get('key', '')
                if key:
                    dps[key] = item.get('value')

            if dps:
                self.on_state_change(dev_id, dps, 'home_connect')

        except Exception as e:
            log.error(f'Home Connect: event handler error: {e}')

    def _run(self):
        """Main loop: authenticate, fetch appliances, connect SSE with reconnect."""
        if not HC_CLIENT_ID or not HC_CLIENT_SECRET or not HC_REFRESH_TOKEN:
            log.error('Home Connect: credentials not set — adapter disabled')
            return

        # Authenticate with retry
        auth_delay = RECONNECT_DELAY
        while not self._stop_event.is_set():
            try:
                self._refresh_access_token()
                break
            except Exception as e:
                log.error(f'Home Connect: auth failed: {e} — retrying in {auth_delay}s')
                self._stop_event.wait(auth_delay)
                auth_delay = min(auth_delay * 2, RECONNECT_MAX)
        if self._stop_event.is_set():
            return

        # Discover appliances
        try:
            self._fetch_appliances()
        except Exception as e:
            log.error(f'Home Connect: appliance discovery failed: {e}')
            return

        if not self._ha_id_map:
            log.warning('Home Connect: no appliances mapped to devices — adapter idle')
            # Still connect SSE to be ready for future mappings

        # Fetch initial states
        self._fetch_all_initial_states()

        # SSE event stream with reconnect
        delay = RECONNECT_DELAY
        while not self._stop_event.is_set():
            try:
                log.info('Home Connect: connecting SSE event stream')
                headers = self._api_headers()
                headers['Accept'] = 'text/event-stream'
                response = requests.get(
                    f'{HC_API}/api/homeappliances/events',
                    headers=headers, stream=True, timeout=(10, None)
                )

                if response.status_code == 401:
                    log.warning('Home Connect: SSE 401 — refreshing token')
                    self._refresh_access_token()
                    continue

                response.raise_for_status()
                client = sseclient.SSEClient(response)
                log.info('Home Connect: SSE connected — receiving events')
                delay = RECONNECT_DELAY

                for event in client.events():
                    if self._stop_event.is_set():
                        break
                    self._handle_event(event)

            except requests.exceptions.HTTPError as e:
                if e.response and e.response.status_code == 401:
                    log.warning('Home Connect: token expired — refreshing')
                    try:
                        self._refresh_access_token()
                    except Exception as re:
                        log.error(f'Home Connect: token refresh failed: {re}')
                else:
                    log.warning(f'Home Connect: SSE error: {e}')
            except Exception as e:
                log.warning(f'Home Connect: SSE connection error: {e}')

            if not self._stop_event.is_set():
                log.info(f'Home Connect: reconnecting in {delay}s')
                self._stop_event.wait(delay)
                delay = min(delay * 2, RECONNECT_MAX)

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True, name='home-connect')
        self._thread.start()

    def stop(self):
        self._stop_event.set()

    def get_state(self, device_id: str) -> dict:
        return {}

    def set_state(self, device_id: str, dps: dict) -> bool:
        return False
