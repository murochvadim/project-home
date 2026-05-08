# Home Connect — Re-authorize when token dies

**Symptom:** dashboard alert `group_stale:cloud:home_connect`, BSH appliances stop streaming.

## Steps

1. Open PowerShell.
2. Run:
   ```
   python c:\Users\muroc\project_home\scripts\hc_oauth_setup.py
   ```
3. A browser tab opens with the BSH login.
4. Log in with email `murochvadim@gmail.com` and your SingleKey ID password.
5. Click **Approve**.
6. Wait for PowerShell to print `SUCCESS: SSE stream reconnected.` — done.

## If the password is rejected

- On the login screen click **Forgot password?**
- Enter `murochvadim@gmail.com`
- Check email → click the reset link → set a new password
- Go back, log in with the new password, click Approve

## If PowerShell prints `Timed out waiting for redirect`

This means the browser couldn't reach the local listener. Recover via Claude:

1. Open this URL in a browser:
   ```
   https://api.home-connect.com/security/oauth/authorize?client_id=8AB9292C46D6F22F4AC81238A5D14C70546545627AFF0630DBAC337C89F23E90&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8888%2Fcallback&scope=IdentifyAppliance+Monitor+Settings+Control&state=manual1
   ```
2. Log in → click Approve.
3. Browser shows **"This site can't be reached"** — that's expected.
4. Copy the URL from the browser's address bar (it contains `code=...`).
5. Paste that URL to Claude and say "finish the BSH re-auth."

Claude does the rest (exchanges the code, deploys to LXC 103, restarts device-agent, resolves the alert).

## Never click

- "Sign up" / "Create new account" — would create an empty account with no appliances.
