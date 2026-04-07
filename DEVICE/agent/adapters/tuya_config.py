"""Shared Tuya API configuration — reads from environment variables."""

import os

API_REGION   = os.environ.get('TUYA_REGION', 'eu')
API_KEY      = os.environ.get('TUYA_API_KEY', '')
API_SECRET   = os.environ.get('TUYA_API_SECRET', '')
API_ENDPOINT = f'https://openapi.tuya{API_REGION}.com'
PULSAR_ENDPOINT = f'wss://mqe.tuya{API_REGION}.com:8285/'

if not API_KEY or not API_SECRET:
    import logging
    logging.getLogger('tuya_config').error(
        'TUYA_API_KEY and TUYA_API_SECRET must be set in /etc/environment or service env file'
    )
