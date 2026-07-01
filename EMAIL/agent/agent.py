#!/usr/bin/env python3
"""Email Agent (LXC 110) — Gmail API poller + Flask HTTP API + MQTT publisher.

Two threads share one process:
  * Poller — walks Gmail's History API from a stored historyId watermark, upserts
    new-message METADATA + snippet into email_messages, publishes
    mur/home/email/message per new mail (so the rule engine can trigger), and
    advances the watermark in email_state.
  * Flask API (:8780) — list / read / send / reply / archive / label endpoints the
    dashboard calls directly. Full bodies are fetched on-demand from Gmail and
    HTML-sanitized (bleach); only metadata + snippet is ever stored in Postgres.

All config comes from /etc/email-agent.env. Until an OAuth token exists the service
stays up and logs "waiting for OAuth" so it can be deployed before Phase 1 is done.
"""
import os, time, json, base64, threading, logging, datetime
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime

import psycopg2
import psycopg2.extras
import paho.mqtt.client as mqtt
import bleach
from flask import Flask, request, jsonify

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  email_agent  %(levelname)s  %(message)s")
log = logging.getLogger("email_agent")

# ─────────────────────────── config ───────────────────────────
DB = dict(
    host=os.environ.get("DB_HOST", "192.168.1.219"),
    dbname=os.environ.get("DB_NAME", "home_data"),
    user=os.environ.get("DB_USER", "postgres"),
    password=os.environ.get("DB_PASS", ""),
    port=int(os.environ.get("DB_PORT", "5432")),
)
MQTT_HOST = os.environ.get("MQTT_HOST", "192.168.1.189")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USER", "email_agent")
MQTT_PASS = os.environ.get("MQTT_PASS", "")
TOKEN_FILE = os.environ.get("GMAIL_TOKEN", "/opt/email-agent/token.json")
POLL_SEC = int(os.environ.get("POLL_SEC", "90"))
API_PORT = int(os.environ.get("API_PORT", "8780"))
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]

_gmail_lock = threading.Lock()        # google client's http is not thread-safe
_mqtt = None

# ─────────────────────────── db ───────────────────────────
def db():
    c = psycopg2.connect(**DB)
    c.autocommit = True
    return c

# ─────────────────────────── gmail ───────────────────────────
def _load_creds():
    """Return refreshed Credentials, or None if the token file isn't present yet."""
    if not os.path.exists(TOKEN_FILE):
        return None
    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return creds

def gmail():
    """Build a Gmail service or raise RuntimeError if not authorized yet."""
    creds = _load_creds()
    if not creds:
        raise RuntimeError("no_oauth_token")
    return build("gmail", "v1", credentials=creds, cache_discovery=False)

def _hdr(headers, name):
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""

def _msg_ts(date_hdr):
    try:
        return parsedate_to_datetime(date_hdr)
    except Exception:
        return None

# ─────────────────────────── persistence ───────────────────────────
def _upsert_message(meta, emit):
    """Upsert one message's metadata; publish MQTT on genuinely-new mail when emit."""
    payload = meta["payload"]
    headers = payload.get("headers", [])
    row = dict(
        gmail_id=meta["id"],
        thread_id=meta.get("threadId"),
        from_addr=_hdr(headers, "From"),
        to_addr=_hdr(headers, "To"),
        subject=_hdr(headers, "Subject"),
        snippet=meta.get("snippet", ""),
        labels=json.dumps(meta.get("labelIds", [])),
        msg_ts=_msg_ts(_hdr(headers, "Date")),
    )
    with db() as c, c.cursor() as cur:
        cur.execute(
            """INSERT INTO email_messages
                 (gmail_id,thread_id,from_addr,to_addr,subject,snippet,labels,msg_ts,seen)
               VALUES (%(gmail_id)s,%(thread_id)s,%(from_addr)s,%(to_addr)s,%(subject)s,
                       %(snippet)s,%(labels)s::jsonb,%(msg_ts)s,%(seen)s)
               ON CONFLICT (gmail_id) DO UPDATE SET
                 labels=EXCLUDED.labels, snippet=EXCLUDED.snippet
               RETURNING (xmax = 0) AS inserted""",
            {**row, "seen": (not emit)},
        )
        inserted = cur.fetchone()[0]
    if emit and inserted and _mqtt is not None:
        evt = {
            "id": row["gmail_id"], "thread_id": row["thread_id"],
            "from": row["from_addr"], "subject": row["subject"],
            "snippet": row["snippet"], "labels": meta.get("labelIds", []),
            "ts": row["msg_ts"].isoformat() if row["msg_ts"] else None,
        }
        _mqtt.publish("mur/home/email/message", json.dumps(evt), qos=1)
        log.info("new mail → MQTT: %s | %s", row["from_addr"], row["subject"])

def _get_meta(svc, msg_id):
    return svc.users().messages().get(
        userId="me", id=msg_id, format="metadata",
        metadataHeaders=["From", "To", "Subject", "Date"]).execute()

def _set_state(history_id):
    with db() as c, c.cursor() as cur:
        cur.execute("UPDATE email_state SET history_id=%s, last_poll_ts=now(), "
                    "updated_at=now() WHERE id=1", (str(history_id),))

def _get_state_history():
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT history_id FROM email_state WHERE id=1")
        r = cur.fetchone()
        return r[0] if r else None

# ─────────────────────────── poller ───────────────────────────
def _initial_sync(svc):
    """First run / stale watermark: backfill recent metadata WITHOUT emitting MQTT
    (we don't want a burst of events for old mail), then set the watermark to now."""
    log.info("initial sync: backfilling last 7 days (no MQTT emit)")
    prof = svc.users().getProfile(userId="me").execute()
    resp = svc.users().messages().list(userId="me", q="newer_than:7d", maxResults=100).execute()
    for m in resp.get("messages", []):
        try:
            _upsert_message(_get_meta(svc, m["id"]), emit=False)
        except HttpError as e:
            log.warning("backfill skip %s: %s", m["id"], e)
    _set_state(prof["historyId"])
    log.info("initial sync done, historyId=%s", prof["historyId"])

def _poll_once():
    with _gmail_lock:
        svc = gmail()
        hist = _get_state_history()
        if not hist:
            _initial_sync(svc)
            return
        try:
            new_ids, page, newest = set(), None, hist
            while True:
                resp = svc.users().history().list(
                    userId="me", startHistoryId=hist,
                    historyTypes=["messageAdded"], pageToken=page).execute()
                for h in resp.get("history", []):
                    newest = h.get("id", newest)
                    for ma in h.get("messagesAdded", []):
                        new_ids.add(ma["message"]["id"])
                page = resp.get("nextPageToken")
                if not page:
                    break
            for mid in new_ids:
                try:
                    _upsert_message(_get_meta(svc, mid), emit=True)
                except HttpError as e:
                    log.warning("meta fetch skip %s: %s", mid, e)
            _set_state(newest)
        except HttpError as e:
            if e.resp.status == 404:            # historyId too old → re-init
                log.warning("historyId stale (404) — re-initialising")
                _initial_sync(svc)
            else:
                raise

def poller_loop():
    while True:
        try:
            _poll_once()
        except RuntimeError as e:
            if str(e) == "no_oauth_token":
                log.info("waiting for OAuth (no %s yet)", TOKEN_FILE)
            else:
                log.exception("poller error")
        except Exception:
            log.exception("poller error")
        time.sleep(POLL_SEC)

# ─────────────────────────── flask api ───────────────────────────
app = Flask(__name__)

@app.after_request
def _cors(resp):
    # Dashboard JS (served from the Windows host) calls this LXC API directly,
    # cross-origin — allow it (LAN-only service, no secrets in responses).
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return resp

@app.get("/api/email/health")
def api_health():
    authed = os.path.exists(TOKEN_FILE)
    return jsonify(ok=True, authorized=authed, poll_sec=POLL_SEC)

@app.get("/api/email/messages")
def api_messages():
    label = request.args.get("label")
    limit = min(int(request.args.get("limit", "50")), 200)
    q = "SELECT gmail_id,thread_id,from_addr,to_addr,subject,snippet,labels,msg_ts,seen " \
        "FROM email_messages"
    args = []
    if label:
        q += " WHERE labels ? %s"
        args.append(label)
    q += " ORDER BY msg_ts DESC NULLS LAST LIMIT %s"
    args.append(limit)
    with db() as c, c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(q, args)
        rows = cur.fetchall()
    for r in rows:
        if r.get("msg_ts"):
            r["msg_ts"] = r["msg_ts"].isoformat()
    return jsonify(messages=rows)

def _decode_part(part):
    data = part.get("body", {}).get("data")
    if not data:
        return ""
    return base64.urlsafe_b64decode(data.encode()).decode("utf-8", "replace")

def _extract_body(payload):
    """Return (html_or_text, is_html) preferring text/html, else text/plain."""
    mime = payload.get("mimeType", "")
    if mime == "text/html":
        return _decode_part(payload), True
    if mime == "text/plain":
        return _decode_part(payload), False
    html = text = None
    for p in payload.get("parts", []) or []:
        sub, is_html = _extract_body(p)
        if is_html and sub:
            html = sub
        elif sub:
            text = text or sub
    if html:
        return html, True
    return (text or ""), False

_ALLOWED_TAGS = list(bleach.sanitizer.ALLOWED_TAGS) + [
    "p", "br", "div", "span", "img", "table", "thead", "tbody", "tr", "td", "th",
    "h1", "h2", "h3", "h4", "h5", "h6", "pre", "hr", "blockquote"]
_ALLOWED_ATTRS = {"a": ["href", "title"], "img": ["src", "alt", "width", "height"],
                  "*": ["style"]}

@app.get("/api/email/message/<mid>")
def api_message(mid):
    with _gmail_lock:
        svc = gmail()
        full = svc.users().messages().get(userId="me", id=mid, format="full").execute()
    headers = full["payload"].get("headers", [])
    body, is_html = _extract_body(full["payload"])
    if is_html:
        body = bleach.clean(body, tags=_ALLOWED_TAGS, attributes=_ALLOWED_ATTRS,
                            protocols=["http", "https", "mailto", "cid", "data"], strip=True)
    return jsonify(
        id=mid, thread_id=full.get("threadId"),
        from_addr=_hdr(headers, "From"), to_addr=_hdr(headers, "To"),
        subject=_hdr(headers, "Subject"), date=_hdr(headers, "Date"),
        labels=full.get("labelIds", []), is_html=is_html, body=body)

def _send_raw(svc, mime, thread_id=None):
    body = {"raw": base64.urlsafe_b64encode(mime.as_bytes()).decode()}
    if thread_id:
        body["threadId"] = thread_id
    return svc.users().messages().send(userId="me", body=body).execute()

@app.post("/api/email/send")
def api_send():
    d = request.get_json(force=True)
    msg = MIMEText(d.get("body", ""), "plain", "utf-8")
    msg["To"] = d["to"]; msg["Subject"] = d.get("subject", "")
    with _gmail_lock:
        res = _send_raw(gmail(), msg)
    return jsonify(ok=True, id=res.get("id"))

@app.post("/api/email/reply")
def api_reply():
    d = request.get_json(force=True)
    tid = d["thread_id"]
    with _gmail_lock:
        svc = gmail()
        # pull the newest message in the thread for headers
        thr = svc.users().threads().get(userId="me", id=tid, format="metadata",
                metadataHeaders=["From", "Subject", "Message-ID", "References"]).execute()
        last = thr["messages"][-1]["payload"]["headers"]
        subj = _hdr(last, "Subject")
        if not subj.lower().startswith("re:"):
            subj = "Re: " + subj
        to = d.get("to") or _hdr(last, "From")
        mid = _hdr(last, "Message-ID")
        msg = MIMEText(d.get("body", ""), "plain", "utf-8")
        msg["To"] = to; msg["Subject"] = subj
        if mid:
            msg["In-Reply-To"] = mid
            msg["References"] = (_hdr(last, "References") + " " + mid).strip()
        res = _send_raw(svc, msg, thread_id=tid)
    return jsonify(ok=True, id=res.get("id"))

def _modify(mid, add=None, remove=None):
    with _gmail_lock:
        gmail().users().messages().modify(userId="me", id=mid,
            body={"addLabelIds": add or [], "removeLabelIds": remove or []}).execute()

@app.post("/api/email/<mid>/archive")
def api_archive(mid):
    _modify(mid, remove=["INBOX"])
    return jsonify(ok=True)

@app.post("/api/email/<mid>/read")
def api_read(mid):
    _modify(mid, remove=["UNREAD"])
    with db() as c, c.cursor() as cur:
        cur.execute("UPDATE email_messages SET seen=true WHERE gmail_id=%s", (mid,))
    return jsonify(ok=True)

@app.post("/api/email/<mid>/label")
def api_label(mid):
    d = request.get_json(force=True)
    _modify(mid, add=d.get("add"), remove=d.get("remove"))
    return jsonify(ok=True)

@app.get("/api/email/labels")
def api_labels():
    with _gmail_lock:
        res = gmail().users().labels().list(userId="me").execute()
    labels = res.get("labels", [])
    with db() as c, c.cursor() as cur:
        for l in labels:
            cur.execute("""INSERT INTO email_labels (label_id,name,type,updated_at)
                           VALUES (%s,%s,%s,now())
                           ON CONFLICT (label_id) DO UPDATE SET name=EXCLUDED.name,
                             type=EXCLUDED.type, updated_at=now()""",
                        (l["id"], l.get("name"), l.get("type")))
    return jsonify(labels=labels)

# ─────────────────────────── main ───────────────────────────
def _mqtt_connect():
    global _mqtt
    cli = mqtt.Client(client_id="email_agent")
    cli.username_pw_set(MQTT_USER, MQTT_PASS)
    cli.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    cli.loop_start()
    _mqtt = cli
    log.info("MQTT connected %s:%s as %s", MQTT_HOST, MQTT_PORT, MQTT_USER)

def main():
    _mqtt_connect()
    threading.Thread(target=poller_loop, daemon=True).start()
    log.info("Email Agent API on :%s", API_PORT)
    app.run(host="0.0.0.0", port=API_PORT, threaded=True)

if __name__ == "__main__":
    main()
