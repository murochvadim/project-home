# Home Connect (BSH) — Re-authorization Runbook

**When you need this doc:** the dashboard (or `system_alerts`) shows
`group_stale:cloud:home_connect` AND `journalctl -u device-agent` on
LXC 103 is logging `auth failed: 400 Client Error … oauth/token …
invalid_grant`. BSH has revoked or rotated past the refresh_token in
`/etc/environment`.

**Outcome:** fresh refresh_token deployed to LXC 103, SSE stream
reconnects, all 6 BSH appliances stream live state again, alert
auto-resolves.

**Total time:** 3–5 minutes once you have the SingleKey ID password.
First-time setup of SingleKey ID can add 5–10 min (one-time only).

---

## Step 0 — Confirm the diagnosis

```bash
ssh root@192.168.1.114 "journalctl -u device-agent --since '5 min ago' --no-pager | grep -iE 'home.connect|invalid' | tail -5"
```

Expected if this runbook applies:

```
ERROR home_connect: Home Connect: auth failed: 400 Client Error: Bad
Request for url: https://api.home-connect.com/security/oauth/token —
retrying in 120s
```

If you see something else (e.g. SSE 5xx, network errors, no log lines
at all), this runbook does NOT apply — different problem.

Manually confirm BSH is rejecting the token:

```bash
ssh root@192.168.1.114 "source /etc/environment 2>/dev/null; \
  curl -s -X POST 'https://api.home-connect.com/security/oauth/token' \
  -d 'grant_type=refresh_token' \
  -d \"refresh_token=\$HC_REFRESH_TOKEN\" \
  -d \"client_secret=\$HC_CLIENT_SECRET\" \
  -d \"client_id=\$HC_CLIENT_ID\" -w '\n[HTTP %{http_code}]\n'"
```

If response says `"error": "invalid_grant"` → proceed.

---

## Step 1 — Run the OAuth helper

The repo has [`scripts/hc_oauth_setup.py`](../../../scripts/hc_oauth_setup.py).
Run from Windows host:

```powershell
python c:\Users\muroc\project_home\scripts\hc_oauth_setup.py
```

The script will:
1. Open a browser tab to BSH's consent URL
2. Listen on `http://localhost:8888/callback` for the redirect
3. Exchange the captured code for tokens
4. SCP the new refresh_token to LXC 103 (writes both
   `/opt/device-agent/hc_refresh_token` AND `/etc/environment`)
5. `systemctl restart device-agent.service`
6. Tail logs and report SUCCESS or error

In the browser:
- Log in with your **SingleKey ID** credentials (email
  `murochvadim@gmail.com`, password = your SingleKey ID password,
  NOT the Home Connect mobile-app password if they differ)
- Click **Approve** on the consent screen (lists 4 scopes:
  IdentifyAppliance / Monitor / Settings / Control)

Skip to **Step 4 — Verify** if SUCCESS.

---

## Step 2 — Fallback when the helper's listener fails

Sometimes the browser's redirect to `localhost:8888/callback` fails to
reach the listener (Windows Defender, browser security policy, port
already bound). Symptom: helper script prints `Timed out waiting for
redirect` even though you logged in and clicked Approve.

In that case, do the OAuth dance manually:

1. Paste this URL in a browser (replace nothing — it's complete as-is):

   ```
   https://api.home-connect.com/security/oauth/authorize?client_id=8AB9292C46D6F22F4AC81238A5D14C70546545627AFF0630DBAC337C89F23E90&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8888%2Fcallback&scope=IdentifyAppliance+Monitor+Settings+Control&state=manual1
   ```

2. Log in (SingleKey ID) → click Approve.

3. Browser will show **"This site can't be reached"** /
   **"localhost refused to connect"**. **This is expected.** The
   browser tried to redirect but no listener was bound on port 8888.

4. Look at the URL in your browser's address bar — it now contains
   the OAuth code. Copy the full URL. It looks like:

   ```
   http://localhost:8888/callback?code=eyJyZWdpb24iO…REDACTED…&state=manual1&grant_type=authorization_code
   ```

5. Extract the `code=` parameter value (everything between `code=` and
   the next `&`). That's your authorization code. Codes expire in
   ~5 min — don't dawdle from here on.

6. Exchange the code for tokens (run on Windows host):

   ```bash
   curl -s -X POST 'https://api.home-connect.com/security/oauth/token' \
     -d 'grant_type=authorization_code' \
     -d 'code=<PASTE_THE_CODE_HERE>' \
     --data-urlencode 'redirect_uri=http://localhost:8888/callback' \
     -d 'client_id=8AB9292C46D6F22F4AC81238A5D14C70546545627AFF0630DBAC337C89F23E90' \
     -d 'client_secret=08BAFED71178D1BBA0E9B0BA6731E4A89CA2B20ED30E0FB60F1BC38797949668'
   ```

   Response is JSON with `access_token`, `refresh_token`, `expires_in`.
   Copy the `refresh_token` value (long base64-encoded JWT).

7. Deploy to LXC 103:

   ```bash
   NEW_TOKEN='<paste_refresh_token_here>'

   echo "$NEW_TOKEN" | ssh root@192.168.1.114 \
     "cat > /opt/device-agent/hc_refresh_token && \
      chmod 600 /opt/device-agent/hc_refresh_token"

   ssh root@192.168.1.114 "python3 -c \"
   p='/etc/environment'
   tok='$NEW_TOKEN'
   lines=open(p).read().splitlines()
   out=['HC_REFRESH_TOKEN='+tok if l.startswith('HC_REFRESH_TOKEN=') else l for l in lines]
   open(p,'w').write('\n'.join(out)+'\n')
   \""

   ssh root@192.168.1.114 "systemctl restart device-agent.service"
   ```

---

## Step 3 — The SingleKey ID landmine

BSH migrated their consumer login to **SingleKey ID**. Old Home
Connect mobile-app passwords often do NOT work directly as SingleKey
ID passwords, even when the Home Connect mobile app shows you have a
SingleKey ID linked. You need to do a one-time password reset.

**On the BSH login screen, if your password is rejected:**

1. Click **Forgot password?** under the password field
2. Enter `murochvadim@gmail.com`
3. Check email — BSH sends a "Reset your SingleKey ID password" link
4. Click the link, set a new password (write it down or save in your
   password manager)
5. Return to the BSH login screen, log in with the new password
6. Click Approve on the consent screen

**Do NOT:** click "Sign up" / "Create new account" / "Register" — that
creates a brand-new SingleKey ID with no appliances linked, which is
useless and may take BSH support to clean up.

After this one-time reset, future re-authorizations just use the
password you set. Save it somewhere durable — you'll need it next time
this runbook runs (which could be 6 months from now).

---

## Step 4 — Verify

```bash
ssh root@192.168.1.114 "journalctl -u device-agent --since '1 min ago' --no-pager | grep -iE 'home.connect|access token' | tail -10"
```

You should see (within ~5 sec of the restart):

```
INFO home_connect: Home Connect: access token refreshed
INFO home_connect: Home Connect: found 6 appliances
INFO home_connect: Home Connect: mapped 6 appliances to devices
```

No more `auth failed` lines.

---

## Step 5 — Resolve the active alert

The `group_health_watchdog` cron on LXC 104 runs every 5 min and
auto-resolves `group_stale:cloud:home_connect` once it sees fresh
events. If you don't want to wait, run it manually:

```bash
ssh root@192.168.1.227 "/usr/bin/python3 /opt/group_health_watchdog.py 2>&1 | tail -3"
```

Look for: `RESOLVED: group_stale:cloud:home_connect`.

---

## Reference — where everything lives

| Thing | Location |
|---|---|
| Adapter source (repo) | [`DEVICE/agent/adapters/home_connect.py`](../../../DEVICE/agent/adapters/home_connect.py) |
| Adapter (deployed) | `root@192.168.1.114:/opt/device-agent/adapters/home_connect.py` |
| OAuth helper (repo) | [`scripts/hc_oauth_setup.py`](../../../scripts/hc_oauth_setup.py) |
| `client_id` + `client_secret` + active `refresh_token` | `/etc/environment` on LXC 103 |
| Persisted refresh_token (rotates) | `/opt/device-agent/hc_refresh_token` on LXC 103 |
| BSH developer portal app | "Home connect alt" at <https://developer.home-connect.com/applications> |
| Registered redirect URIs | `http://localhost:8888/callback` (helper) and `https://my.home-assistant.io/redirect/oauth` (HA, unused) |
| BSH user account | `murochvadim@gmail.com` (SingleKey ID) |
| Watchdog cron | `*/5 * * * *` on LXC 104 → `/opt/group_health_watchdog.py` |

## Why this fails (root cause)

The adapter's `_refresh_access_token` writes any rotated refresh_token
to `/opt/device-agent/hc_refresh_token`. BSH SOMETIMES rotates the
refresh_token on a successful refresh response. If we fail to persist
that rotation (file write failed, file got wiped during a deploy, etc.)
the next refresh after the access_token TTL expires will use the OLD
token from `/etc/environment`, which BSH has already invalidated → 400
`invalid_grant`. The chain stays broken until a human re-authorizes.

There is no automatic recovery — BSH only issues new refresh_tokens
through the interactive Authorization Code Grant flow, which requires
a browser session and a human to click Approve. This runbook IS the
recovery procedure.
