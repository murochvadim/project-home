#!/opt/ring-snapshot/venv/bin/python3
"""One-time Ring authentication — saves token to /opt/ring-snapshot/token.json"""

import asyncio
import json
import getpass
from pathlib import Path
from ring_doorbell import Auth, AuthenticationError, Requires2FAError

TOKEN_FILE = Path('/opt/ring-snapshot/token.json')
USER_AGENT = 'SmartHome/1.0'


def save_token(token):
    TOKEN_FILE.write_text(json.dumps(token))
    print(f'Token saved to {TOKEN_FILE}')


async def main():
    # Check if token already exists
    if TOKEN_FILE.exists():
        print(f'Token already exists at {TOKEN_FILE}')
        ans = input('Re-authenticate? (y/N): ').strip().lower()
        if ans != 'y':
            print('Keeping existing token.')
            return

    email = input('Ring email: ').strip()
    password = getpass.getpass('Ring password: ')

    auth = Auth(USER_AGENT, token_updater=save_token)

    try:
        await auth.async_fetch_token(email, password)
    except Requires2FAError:
        code = input('2FA code (check your phone): ').strip()
        await auth.async_fetch_token(email, password, code)

    save_token(auth.token)
    print('Authentication successful!')

    # Quick test — list devices
    from ring_doorbell import Ring
    ring = Ring(auth)
    await ring.async_update_data()
    for dev in ring.devices()['doorbots']:
        print(f'  Doorbell: {dev.name} (battery {dev.battery_life}%)')
    for dev in ring.devices()['chimes']:
        print(f'  Chime: {dev.name}')


if __name__ == '__main__':
    asyncio.run(main())
