from .tuya import TuyaAdapter
from .tuya_cloud import TuyaCloudAdapter
from .tuya_push import TuyaPushAdapter
from .ha_api import HAApiAdapter
from .home_connect import HomeConnectAdapter

# Local/gateway adapters (keyed by vendor name)
ADAPTERS = {
    'tuya': TuyaAdapter,
}

# Cloud polling adapters (keyed by vendor name)
CLOUD_ADAPTERS = {
    'tuya': TuyaCloudAdapter,
    'bsh': HomeConnectAdapter,
}

# Real-time cloud push adapters (keyed by vendor name)
PUSH_ADAPTERS = {
    'tuya': TuyaPushAdapter,
}
