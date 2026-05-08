#!/usr/bin/env python3
"""One-shot Home Connect OAuth re-authorization helper.

Drives the Authorization Code Grant flow end-to-end:
  1. Opens BSH consent URL in the default browser.
  2. Listens on http://localhost:8888/callback for the redirect.
  3. Exchanges the captured `code` for access_token + refresh_token.
  4. Deploys the new refresh_token to LXC 103 (both /etc/environment
     and /opt/device-agent/hc_refresh_token).
  5. Restarts device-agent.service and tails logs for confirmation.

Run on Windows host:  python scripts/hc_oauth_setup.py
"""

import http.server
import json
import secrets
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID     = '8AB9292C46D6F22F4AC81238A5D14C70546545627AFF0630DBAC337C89F23E90'
CLIENT_SECRET = '08BAFED71178D1BBA0E9B0BA6731E4A89CA2B20ED30E0FB60F1BC38797949668'
REDIRECT_URI  = 'http://localhost:8888/callback'
SCOPE         = 'IdentifyAppliance Monitor Settings Control'

AUTH_URL  = 'https://api.home-connect.com/security/oauth/authorize'
TOKEN_URL = 'https://api.home-connect.com/security/oauth/token'

LXC        = 'root@192.168.1.114'
ENV_FILE   = '/etc/environment'
TOKEN_FILE = '/opt/device-agent/hc_refresh_token'

state    = secrets.token_urlsafe(16)
captured = {}


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != '/callback':
            self.send_response(404)
            self.end_headers()
            return
        q = urllib.parse.parse_qs(url.query)
        captured['code']  = (q.get('code')  or [None])[0]
        captured['state'] = (q.get('state') or [None])[0]
        captured['error'] = (q.get('error') or [None])[0]
        captured['error_description'] = (q.get('error_description') or [None])[0]
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        if captured['code']:
            self.wfile.write(b'<h1 style="font-family:sans-serif">Authorized.</h1>'
                             b'<p>You can close this window. Returning to terminal...</p>')
        else:
            err = captured['error'] or 'no code returned'
            desc = captured['error_description'] or ''
            html = f'<h1 style="font-family:sans-serif;color:#c00">Failed: {err}</h1><p>{desc}</p>'
            self.wfile.write(html.encode())

    def log_message(self, *a, **kw):
        return  # quiet


def http_post_form(url, fields):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def ssh(*cmd, capture=False):
    full = ['ssh', LXC] + list(cmd)
    return subprocess.run(full, capture_output=capture, text=True, check=True)


def main():
    socketserver.TCPServer.allow_reuse_address = True
    try:
        srv = socketserver.TCPServer(('localhost', 8888), CallbackHandler)
    except OSError as e:
        sys.exit(f'Could not bind localhost:8888 ({e}). Free that port and retry.')

    threading.Thread(target=srv.serve_forever, daemon=True).start()

    auth_url = AUTH_URL + '?' + urllib.parse.urlencode({
        'client_id':     CLIENT_ID,
        'response_type': 'code',
        'redirect_uri':  REDIRECT_URI,
        'scope':         SCOPE,
        'state':         state,
    })

    print('Opening browser to authorize Home Connect access...')
    print(f'  URL: {auth_url}')
    print()
    print('You should see the BSH consent screen. Click Allow.')
    print('Waiting for redirect (timeout 300s)...')
    webbrowser.open(auth_url)

    deadline = time.time() + 300
    while time.time() < deadline and not captured.get('code') and not captured.get('error'):
        time.sleep(0.4)

    srv.shutdown()

    if captured.get('error'):
        sys.exit(f'OAuth error: {captured["error"]} - {captured.get("error_description") or ""}')
    if not captured.get('code'):
        sys.exit('Timed out waiting for redirect.')
    if captured.get('state') != state:
        sys.exit(f'State mismatch (expected {state}, got {captured["state"]}). Possible CSRF, aborting.')

    print('Got code. Exchanging for tokens...')
    status, data = http_post_form(TOKEN_URL, {
        'grant_type':    'authorization_code',
        'code':          captured['code'],
        'redirect_uri':  REDIRECT_URI,
        'client_id':     CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    })
    if status != 200:
        sys.exit(f'Token exchange failed: HTTP {status} - {data}')

    new_refresh = data.get('refresh_token')
    new_access  = data.get('access_token')
    expires_in  = data.get('expires_in', '?')
    if not new_refresh:
        sys.exit(f'No refresh_token in response: {data}')

    print(f'  access_token:  acquired ({expires_in}s ttl)')
    print(f'  refresh_token: acquired (len={len(new_refresh)})')

    print('Deploying to LXC 103...')

    # 1) Write persistence file (idempotent atomic write)
    print(f'  -> writing {TOKEN_FILE}')
    proc = subprocess.run(
        ['ssh', LXC, f'cat > {TOKEN_FILE} && chmod 600 {TOKEN_FILE}'],
        input=new_refresh, text=True, check=False, capture_output=True,
    )
    if proc.returncode != 0:
        sys.exit(f'Failed to write token file: {proc.stderr}')

    # 2) Update /etc/environment HC_REFRESH_TOKEN line in place
    print(f'  -> updating {ENV_FILE} HC_REFRESH_TOKEN=')
    py_inline = (
        f'import sys; '
        f'p = "{ENV_FILE}"; '
        f'lines = open(p).read().splitlines(); '
        f'tok = sys.stdin.read().strip(); '
        f'out = ["HC_REFRESH_TOKEN=" + tok if l.startswith("HC_REFRESH_TOKEN=") else l for l in lines]; '
        f'open(p, "w").write("\\n".join(out) + "\\n"); '
        f'print("ok")'
    )
    proc = subprocess.run(
        ['ssh', LXC, 'python3', '-c', py_inline],
        input=new_refresh, text=True, check=False, capture_output=True,
    )
    if proc.returncode != 0:
        sys.exit(f'Failed to update {ENV_FILE}: {proc.stderr}')

    # 3) Capture restart timestamp BEFORE restarting so the post-check
    # filters journal to post-restart entries only. Without this, the
    # 60-line window often included pre-restart "auth failed" lines
    # (false-failure) and the loose `sse` filter matched "Events
    # proce**sse**d" heartbeats (false-success).
    ts_proc = subprocess.run(
        ['ssh', LXC, 'date -u +%Y-%m-%dT%H:%M:%S'],
        capture_output=True, text=True, check=True,
    )
    restart_ts = ts_proc.stdout.strip()

    # 4) Restart device-agent
    print('  -> systemctl restart device-agent.service')
    subprocess.run(['ssh', LXC, 'systemctl restart device-agent.service'], check=True)

    print('Waiting 10s for SSE reconnect...')
    time.sleep(10)

    print()
    print('=== device-agent post-restart logs (home_connect filter) ===')
    proc = subprocess.run(
        ['ssh', LXC,
         f"journalctl -u device-agent --since '{restart_ts}' --no-pager "
         f"| grep -iE 'home_connect|access token' || true"],
        capture_output=True, text=True, check=False,
    )
    print(proc.stdout or '(no home_connect log lines yet)')

    # Decide success/failure based ONLY on post-restart logs.
    if 'invalid_grant' in proc.stdout or 'auth failed' in proc.stdout:
        print('*** Auth errors AFTER restart — token deploy did not take effect. ***')
        sys.exit(2)
    if 'access token refreshed' in proc.stdout:
        print('SUCCESS: Home Connect reconnected.')
    else:
        print('No success marker yet — run `journalctl -u device-agent -f` to verify manually.')


if __name__ == '__main__':
    main()
