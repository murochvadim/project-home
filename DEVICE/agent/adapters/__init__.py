from .tuya import TuyaAdapter
from .tuya_cloud import TuyaCloudAdapter
from .tuya_push import TuyaPushAdapter
from .ha_api import HAApiAdapter

# Local/gateway adapters (keyed by vendor name)
ADAPTERS = {
    'tuya': TuyaAdapter,
    # 'smartthings': SmartThingsAdapter,  # future
    # 'knx':         KNXAdapter,          # future
}

# Cloud polling adapters (keyed by vendor name)
CLOUD_ADAPTERS = {
    'tuya': TuyaCloudAdapter,
}

# Real-time cloud push adapters (keyed by vendor name)
PUSH_ADAPTERS = {
    'tuya': TuyaPushAdapter,
}
