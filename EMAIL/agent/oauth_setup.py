#!/usr/bin/env python3
"""One-time Gmail OAuth token minting.

Run this ONCE on a machine WITH a browser (the Windows dashboard host). It takes the
OAuth *Desktop* client's credentials.json (downloaded from Google Cloud Console),
opens the browser for consent, and writes token.json (an authorized-user file with
the refresh token). That token.json is then copied to
LXC 110:/opt/email-agent/token.json and the Email Agent uses it forever (it
auto-refreshes the access token from the stored refresh token).

  pip install google-auth-oauthlib
  python oauth_setup.py credentials.json token.json

Scopes are minimal: read/modify + send.
"""
import sys
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]


def main():
    creds_file = sys.argv[1] if len(sys.argv) > 1 else "credentials.json"
    out = sys.argv[2] if len(sys.argv) > 2 else "token.json"
    flow = InstalledAppFlow.from_client_secrets_file(creds_file, SCOPES)
    # prompt='consent' forces Google to return a FRESH refresh_token even if this
    # account already granted before (needed when re-minting — e.g. after moving the
    # app from Testing to In production so the new token doesn't carry the 7-day expiry).
    creds = flow.run_local_server(port=0, prompt="consent")   # opens the browser; loopback redirect
    with open(out, "w") as f:
        f.write(creds.to_json())
    print("Wrote", out, "— copy it to LXC 110:/opt/email-agent/token.json")


if __name__ == "__main__":
    main()
