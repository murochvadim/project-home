"""Abstract base class for all vendor device adapters."""


class DeviceAdapter:
    vendor = 'unknown'

    def __init__(self, devices, on_state_change):
        """
        devices        — list of device dicts from the devices DB table
        on_state_change — callable(device_id: str, dps: dict, source: str)
        """
        self.devices = devices
        self.on_state_change = on_state_change

    def start(self):
        """Start listening for state changes. Non-blocking — spawns threads internally."""
        raise NotImplementedError

    def stop(self):
        """Gracefully stop all listeners."""
        raise NotImplementedError

    def get_state(self, device_id: str) -> dict:
        """Poll current state for one device. Returns dps dict or {}."""
        raise NotImplementedError

    def set_state(self, device_id: str, dps: dict) -> bool:
        """Send command to device. Returns True on success."""
        raise NotImplementedError
