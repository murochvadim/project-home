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
import os, time, json, base64, threading, logging, datetime, re
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime

import psycopg2
import psycopg2.extras
import paho.mqtt.client as mqtt
import bleach
from flask import Flask, request, jsonify, Response

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

try:
    import fitz  # PyMuPDF — receipt PDF text extraction (keeps logical Hebrew/RTL order)
except Exception:  # pragma: no cover
    fitz = None

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
    log.info("initial sync: backfilling inbox + last 7 days (no MQTT emit)")
    prof = svc.users().getProfile(userId="me").execute()
    # "in:inbox" ensures CURRENT inbox messages are cached even if older than 7 days
    # (so the dashboard Inbox reflects Gmail); newer_than:7d adds recent archived/read mail.
    resp = svc.users().messages().list(userId="me", q="in:inbox OR newer_than:7d", maxResults=150).execute()
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
            # Process ALL history types so the local cache MIRRORS Gmail — not just new
            # mail, but label changes (spam/trash/archive/read) and deletions. Without
            # this the cache goes stale (a spammed email lingers in the list).
            new_ids, touched, deleted, page, newest = set(), set(), set(), None, hist
            while True:
                resp = svc.users().history().list(
                    userId="me", startHistoryId=hist, pageToken=page).execute()
                for h in resp.get("history", []):
                    newest = h.get("id", newest)
                    for ma in h.get("messagesAdded", []):
                        new_ids.add(ma["message"]["id"]); touched.add(ma["message"]["id"])
                    for md in h.get("messagesDeleted", []):
                        deleted.add(md["message"]["id"])
                    for lc in h.get("labelsAdded", []) + h.get("labelsRemoved", []):
                        touched.add(lc["message"]["id"])
                page = resp.get("nextPageToken")
                if not page:
                    break
            if deleted:
                with db() as c, c.cursor() as cur:
                    cur.execute("DELETE FROM email_messages WHERE gmail_id = ANY(%s)", (list(deleted),))
            for mid in (touched - deleted):
                try:
                    meta = _get_meta(svc, mid)
                    _upsert_message(meta, emit=(mid in new_ids))   # refresh cached labels; emit only for new
                    if mid in new_ids:
                        _apply_automation(svc, mid, meta)          # sender-rule automation (under _gmail_lock)
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
            _maybe_cleanup_spam()          # hourly-throttled spam→Trash sweep
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
    where, args = [], []
    if label:
        where.append("labels ? %s")
        args.append(label)
    # Hide Spam/Trash from normal views (matches Gmail — Inbox & All Mail exclude them),
    # unless the user explicitly asks for that folder.
    if label not in ("SPAM", "TRASH"):
        where.append("NOT (labels ? 'SPAM') AND NOT (labels ? 'TRASH')")
    if where:
        q += " WHERE " + " AND ".join(where)
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


# ─────────────────────────── automation (phase 1: sender rules) ───────────────────────────
# Rules live in dashboard_settings.email.rules (edited on the Email→Automation tab).
# Each: {id,name,active,mode:dryrun|live, match:{from:[...]}, disposition:spam|trash|keep|archive,
#        extract:[{field,pattern,source:body|subject}]}. First matching ACTIVE rule wins.
_rules_cache = {"data": None, "ts": 0.0}
_RULES_TTL = 30
# disposition → (addLabelIds, removeLabelIds). 'keep' = no Gmail change. No permanent
# delete: the token's gmail.modify scope can't; Trash (30-day recoverable) is the ceiling.
_DISP_MODIFY = {"spam": (["SPAM"], ["INBOX"]), "trash": (["TRASH"], ["INBOX"]),
                "archive": ([], ["INBOX"])}


def _modify_raw(svc, mid, add=None, remove=None):
    """Label modify WITHOUT taking _gmail_lock — for callers that already hold it
    (the poller/automation). The public _modify() wraps this with the lock."""
    svc.users().messages().modify(
        userId="me", id=mid,
        body={"addLabelIds": add or [], "removeLabelIds": remove or []}).execute()


def _load_rules():
    now = time.time()
    if _rules_cache["data"] is not None and (now - _rules_cache["ts"]) < _RULES_TTL:
        return _rules_cache["data"]
    rules = []
    try:
        with db() as c, c.cursor() as cur:
            cur.execute("SELECT value FROM dashboard_settings WHERE key='email.rules'")
            row = cur.fetchone()
        if row and row[0]:
            v = row[0]
            rules = v if isinstance(v, list) else json.loads(v)
    except Exception:
        log.exception("load email.rules failed")
        rules = _rules_cache["data"] or []
    _rules_cache["data"] = rules
    _rules_cache["ts"] = now
    return rules


_settings_cache = {"data": None, "ts": 0.0}

def _load_settings():
    """Email agent settings from dashboard_settings.email.settings (30 s TTL).
    Currently: {trash_spam_after_days:N}."""
    now = time.time()
    if _settings_cache["data"] is not None and (now - _settings_cache["ts"]) < _RULES_TTL:
        return _settings_cache["data"]
    s = {}
    try:
        with db() as c, c.cursor() as cur:
            cur.execute("SELECT value FROM dashboard_settings WHERE key='email.settings'")
            row = cur.fetchone()
        if row and row[0]:
            v = row[0]
            s = v if isinstance(v, dict) else json.loads(v)
    except Exception:
        log.exception("load email.settings failed")
        s = _settings_cache["data"] or {}
    _settings_cache["data"] = s
    _settings_cache["ts"] = now
    return s


def _sender_match(from_addr, patterns):
    fa = (from_addr or "").lower()
    return any(p and str(p).lower() in fa for p in (patterns or []))


def _any_in(needles, hay_lower):
    """True if any needle (case-insensitive) is a substring of the already-lowercased hay.
    Used for the optional match.contains text condition (subject/snippet/body)."""
    return any(n and str(n).lower() in hay_lower for n in (needles or []))


def _plain_body(svc, mid):
    """Fetch the message body and strip HTML → plain text for regex matching.
    Caller holds _gmail_lock."""
    full = svc.users().messages().get(userId="me", id=mid, format="full").execute()
    raw, is_html = _extract_body(full["payload"])
    if is_html:
        raw = bleach.clean(raw, tags=[], strip=True)
    return raw


# ─────────────────────── PDF attachments (receipts) ───────────────────────
def _pdf_parts(payload):
    """Return [(filename, attachment_id), …] for every application/pdf part."""
    out = []
    def walk(p):
        fn, mt = (p.get("filename") or ""), (p.get("mimeType") or "")
        if fn and ("pdf" in fn.lower() or "pdf" in mt.lower()):
            aid = (p.get("body") or {}).get("attachmentId")
            if aid:
                out.append((fn, aid))
        for sp in (p.get("parts") or []):
            walk(sp)
    walk(payload or {})
    return out


def _pdf_bytes(svc, mid, full=None):
    """Raw bytes of the first PDF attachment, or None. Caller holds _gmail_lock."""
    if full is None:
        full = svc.users().messages().get(userId="me", id=mid, format="full").execute()
    parts = _pdf_parts(full.get("payload") or {})
    if not parts:
        return None
    att = svc.users().messages().attachments().get(
        userId="me", messageId=mid, id=parts[0][1]).execute()
    return base64.urlsafe_b64decode(att["data"])


def _pdf_text(svc, mid, full=None):
    """Text of the first PDF attachment via PyMuPDF (logical RTL order). '' if none."""
    if fitz is None:
        return ""
    try:
        data = _pdf_bytes(svc, mid, full)
        if not data:
            return ""
        with fitz.open(stream=data, filetype="pdf") as d:
            return "\n".join(p.get_text() for p in d)
    except Exception:
        log.exception("pdf text extract failed for %s", mid)
        return ""


# ─────────────────────── receipt field helpers ───────────────────────
_DATE_FMTS_DEFAULT = ["%d/%m/%y", "%d/%m/%Y", "%Y-%m-%d", "%d.%m.%y", "%d.%m.%Y", "%d-%m-%Y"]

def _parse_date(s, fmt=None):
    s = (str(s) or "").strip()
    if not s:
        return None
    fmts = []
    if fmt:  # friendly tokens → strptime (e.g. DD/MM/YY → %d/%m/%y)
        fmts.append(fmt.replace("DD", "%d").replace("MM", "%m")
                       .replace("YYYY", "%Y").replace("YY", "%y"))
    fmts += _DATE_FMTS_DEFAULT
    for f in fmts:
        try:
            return datetime.datetime.strptime(s, f).date()
        except Exception:
            pass
    return None


def _to_num(s):
    try:
        return float(str(s).replace(",", "").replace("\u200F", "").strip())
    except Exception:
        return None


def _derive_vendor(from_addr):
    """Best-effort vendor name from the sender domain (aviem-evm.co.il → Aviem)."""
    m = re.search(r"@([\w.-]+)", from_addr or "")
    if not m:
        return None
    host = m.group(1).lower()
    parts = [p for p in host.split(".") if p not in
             ("com", "co", "il", "net", "org", "www", "mail", "email", "noreply", "no-reply")]
    core = (parts[0] if parts else host).split("-")[0]
    return core.capitalize() or None


def _run_extract(fields, subject, body, pdf_text=""):
    out = {}
    for f in fields or []:
        pat, fld = f.get("pattern"), f.get("field")
        if not pat or not fld:
            continue
        src_kind = (f.get("source") or "body")
        src = pdf_text if src_kind == "pdf" else (subject if src_kind == "subject" else body)
        try:
            m = re.search(pat, src or "", re.IGNORECASE | re.DOTALL)
        except re.error:
            continue
        if m:
            out[fld] = m.group(1) if m.groups() else m.group(0)
    return out


def _log_auto(rule, from_addr, subject, gmail_id, disp, mode, applied, extracted, note=""):
    try:
        with db() as c, c.cursor() as cur:
            cur.execute(
                """INSERT INTO email_automation_log
                     (rule_id,rule_name,gmail_id,from_addr,subject,disposition,mode,applied,extracted,note)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (rule.get("id"), rule.get("name"), gmail_id, from_addr, subject,
                 disp, mode, applied, json.dumps(extracted) if extracted else None, note))
    except Exception:
        log.exception("automation log write failed")


def _apply_rules(svc, mid, from_addr, subject, snippet):
    """Core rule application, shared by the poller (_apply_automation) and Run-now
    (_run_now). First matching active rule acts: dry-run logs the would-be action; live
    extracts→stores→disposes. Caller holds _gmail_lock. Returns 'applied'|'logged'|None."""
    try:
        rules = _load_rules()
        if not rules:
            return None
        for rule in rules:
            if not rule.get("active"):
                continue
            match = rule.get("match") or {}
            if not _sender_match(from_addr, match.get("from")):
                continue
            contains = match.get("contains") or []
            fields = rule.get("extract") or []
            store = rule.get("store") or "row"          # 'receipt' | 'row'
            site_id = rule.get("site_id")
            need_pdf = any((f.get("source") == "pdf") for f in fields)
            need_body_fields = any((f.get("source") or "body") != "pdf" for f in fields)
            # Fetch body/PDF only when needed — a text condition not already satisfied by
            # subject+preview, body/subject extract fields, or PDF extract fields (receipts).
            subjsnip = ((subject or "") + " " + (snippet or "")).lower()
            need_body = need_body_fields or (bool(contains) and not _any_in(contains, subjsnip))
            body = _plain_body(svc, mid) if need_body else ""
            pdf_text = _pdf_text(svc, mid) if need_pdf else ""
            if contains and not _any_in(contains, subjsnip + " " + body.lower() + " " + pdf_text.lower()):
                continue   # sender matched but the required text isn't present → skip rule
            disp = rule.get("disposition") or "keep"
            extracted = _run_extract(fields, subject or "", body, pdf_text) if fields else {}
            # Receipt mode → map extract fields (as: amount|date|vendor|invoice_no) to the
            # structured columns of privacy_site_receipts (viewed under a Privacy Site).
            vendor = amount = inv_date = inv_no = None
            if store == "receipt":
                vendor = rule.get("vendor") or _derive_vendor(from_addr)
                for f in fields:
                    role, val = f.get("as"), extracted.get(f.get("field"))
                    if val in (None, ""):
                        continue
                    if role == "amount":
                        amount = _to_num(val)
                    elif role == "date":
                        inv_date = _parse_date(val, f.get("date_format"))
                    elif role == "vendor":
                        vendor = val
                    elif role == "invoice_no":
                        inv_no = val
                if inv_no is None:
                    inv_no = extracted.get("invoice_no")
            preview = dict(extracted)
            if store == "receipt":
                preview["_receipt"] = {"vendor": vendor, "amount": amount,
                                       "invoice_date": inv_date.isoformat() if inv_date else None,
                                       "invoice_no": inv_no, "site_id": site_id}
            live = (rule.get("mode") or "dryrun") == "live"
            if not live:
                _log_auto(rule, from_addr, subject, mid, disp, "dryrun", False, preview, "would apply")
                log.info("automation DRY-RUN rule=%s disp=%s store=%s from=%s",
                         rule.get("name"), disp, store, from_addr)
                return "logged"
            if extracted:
                try:
                    with db() as c, c.cursor() as cur:
                        cur.execute(
                            """INSERT INTO email_extractions
                                 (rule_id,rule_name,gmail_id,from_addr,subject,data)
                               VALUES (%s,%s,%s,%s,%s,%s)""",
                            (rule.get("id"), rule.get("name"), mid, from_addr, subject,
                             json.dumps(extracted)))
                except Exception:
                    log.exception("extraction store failed")
            if store == "receipt" and site_id:
                try:
                    with db() as c, c.cursor() as cur:
                        cur.execute(
                            """INSERT INTO privacy_site_receipts
                                 (site_id,vendor,amount,currency,invoice_date,invoice_no,gmail_id,data,source)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'email')
                               ON CONFLICT (gmail_id) WHERE gmail_id IS NOT NULL DO UPDATE SET
                                 vendor=EXCLUDED.vendor, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
                                 invoice_date=EXCLUDED.invoice_date, invoice_no=EXCLUDED.invoice_no,
                                 data=EXCLUDED.data""",
                            (site_id, vendor, amount, rule.get("currency") or "ILS",
                             inv_date, inv_no, mid, json.dumps(extracted)))
                    log.info("receipt stored site=%s vendor=%s amount=%s date=%s from=%s",
                             site_id, vendor, amount, inv_date, from_addr)
                except Exception:
                    log.exception("receipt store failed for %s", mid)
            if disp in _DISP_MODIFY:
                add, remove = _DISP_MODIFY[disp]
                _modify_raw(svc, mid, add, remove)
                try:                       # refresh cached labels NOW so the dashboard reflects the move
                    _upsert_message(_get_meta(svc, mid), emit=False)
                except Exception:
                    log.exception("cache refresh after %s failed for %s", disp, mid)
            _log_auto(rule, from_addr, subject, mid, disp, "live", True, preview, "applied")
            log.info("automation LIVE rule=%s disp=%s from=%s", rule.get("name"), disp, from_addr)
            return "applied"
        return None
    except Exception:
        log.exception("automation error for %s", mid)
        return None


def _apply_automation(svc, mid, meta):
    """Called per NEW message from _poll_once (already under _gmail_lock)."""
    headers = meta.get("payload", {}).get("headers", [])
    _apply_rules(svc, mid, _hdr(headers, "From"), _hdr(headers, "Subject"), meta.get("snippet") or "")


def _run_now(limit=200):
    """Retroactive: apply the current rules to the last N cached messages. Skips
    messages already actioned by a prior live run/poll (dedupe on applied=true logs) so
    repeat clicks don't re-process. Live rules act; dry-run rules just log."""
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT gmail_id,from_addr,subject,snippet FROM email_messages "
                    "ORDER BY msg_ts DESC NULLS LAST LIMIT %s", (limit,))
        msgs = cur.fetchall()
        cur.execute("SELECT DISTINCT gmail_id FROM email_automation_log WHERE applied = true")
        done = {r[0] for r in cur.fetchall()}
    applied = logged = 0
    with _gmail_lock:
        svc = gmail()
        for gmail_id, from_addr, subject, snippet in msgs:
            if gmail_id in done:
                continue
            res = _apply_rules(svc, gmail_id, from_addr or "", subject or "", snippet or "")
            if res == "applied":
                applied += 1
            elif res == "logged":
                logged += 1
    log.info("run-now: scanned=%d applied=%d logged=%d", len(msgs), applied, logged)
    return {"scanned": len(msgs), "applied": applied, "logged": logged}


_last_spam_cleanup = 0.0

def _trash_old_spam():
    """Move automation-spammed emails to Trash once they're older than
    email.settings.trash_spam_after_days (0/absent = disabled). Recoverable — Gmail
    purges Trash ~30 d later; uses gmail.modify (NO permanent delete). trashed_at marks
    swept rows so the sweep never re-touches a message."""
    try:
        days = int(_load_settings().get("trash_spam_after_days", 0) or 0)
    except (TypeError, ValueError):
        days = 0
    if days <= 0:
        return
    with db() as c, c.cursor() as cur:
        cur.execute("""SELECT id, gmail_id FROM email_automation_log
                       WHERE disposition = 'spam' AND applied AND trashed_at IS NULL
                         AND ts < now() - (%s * interval '1 day')
                       ORDER BY ts LIMIT 200""", (days,))
        rows = cur.fetchall()
    if not rows:
        return
    n = 0
    with _gmail_lock:
        svc = gmail()
        for log_id, gmail_id in rows:
            try:
                _modify_raw(svc, gmail_id, add=["TRASH"], remove=["SPAM"])
                try:
                    _upsert_message(_get_meta(svc, gmail_id), emit=False)
                except Exception:
                    pass
                with db() as c, c.cursor() as cur:
                    cur.execute("UPDATE email_automation_log SET trashed_at = now() WHERE id = %s", (log_id,))
                n += 1
            except Exception:
                log.exception("trash-old-spam failed for %s", gmail_id)
    if n:
        log.info("trash-old-spam: moved %d spam email(s) to Trash (>%dd old)", n, days)

def _maybe_cleanup_spam():
    """Hourly throttle for the spam→Trash sweep (called from the poller loop)."""
    global _last_spam_cleanup
    now = time.time()
    if now - _last_spam_cleanup < 3600:
        return
    _last_spam_cleanup = now
    try:
        _trash_old_spam()
    except RuntimeError as e:
        if str(e) != "no_oauth_token":
            log.exception("spam cleanup error")
    except Exception:
        log.exception("spam cleanup error")

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
        _modify_raw(gmail(), mid, add, remove)

def _refresh_cache(mid):
    """Re-fetch a message's current labels into the cache so a label change shows on the
    dashboard immediately (the poller would also catch it within a poll)."""
    try:
        with _gmail_lock:
            _upsert_message(_get_meta(gmail(), mid), emit=False)
    except Exception:
        log.exception("cache refresh failed for %s", mid)

@app.post("/api/email/<mid>/archive")
def api_archive(mid):
    _modify(mid, remove=["INBOX"])
    _refresh_cache(mid)
    return jsonify(ok=True)

@app.post("/api/email/<mid>/trash")
def api_trash(mid):
    # "Delete" = move to Trash (recoverable ~30 d; gmail.modify can't permanently delete).
    _modify(mid, add=["TRASH"], remove=["INBOX"])
    _refresh_cache(mid)
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

# ─────────────────────────── automation read/test endpoints ───────────────────────────
@app.get("/api/email/extractions")
def api_extractions():
    limit = min(int(request.args.get("limit", "100")), 500)
    with db() as c, c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT id,rule_name,gmail_id,from_addr,subject,data,extracted_at "
                    "FROM email_extractions ORDER BY extracted_at DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
    for r in rows:
        if r.get("extracted_at"):
            r["extracted_at"] = r["extracted_at"].isoformat()
    return jsonify(rows=rows)


@app.get("/api/email/attachment/<mid>")
def api_attachment(mid):
    """Stream the first PDF attachment of a message (dashboard files it under a site)."""
    try:
        with _gmail_lock:
            data = _pdf_bytes(gmail(), mid)
        if not data:
            return jsonify(error="no_pdf"), 404
        return Response(data, mimetype="application/pdf",
                        headers={"Content-Disposition": "inline; filename=receipt.pdf"})
    except Exception as e:
        log.exception("attachment fetch failed for %s", mid)
        return jsonify(error=str(e)), 500


@app.post("/api/email/pdf-text")
def api_pdf_text():
    """Return the first PDF attachment's text — used by /create-email-rule to build+test regex."""
    mid = (request.get_json(silent=True) or {}).get("gmail_id")
    if not mid:
        return jsonify(error="gmail_id required"), 400
    try:
        with _gmail_lock:
            txt = _pdf_text(gmail(), mid)
        return jsonify(text=txt)
    except Exception as e:
        log.exception("pdf-text failed for %s", mid)
        return jsonify(error=str(e)), 500

@app.get("/api/email/automation-log")
def api_automation_log():
    limit = min(int(request.args.get("limit", "100")), 500)
    with db() as c, c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT id,ts,rule_name,gmail_id,from_addr,subject,disposition,mode,"
                    "applied,extracted,note FROM email_automation_log ORDER BY ts DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
    for r in rows:
        if r.get("ts"):
            r["ts"] = r["ts"].isoformat()
    return jsonify(rows=rows)

@app.post("/api/email/automation/test")
def api_automation_test():
    """Dry-run a single rule against the last ~80 cached messages — returns would-be
    matches + extractions WITHOUT touching Gmail or the DB (validate a rule before saving)."""
    rule = (request.get_json(force=True) or {}).get("rule") or {}
    match = rule.get("match") or {}
    pats, contains = match.get("from"), (match.get("contains") or [])
    fields = rule.get("extract") or []
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT gmail_id,from_addr,subject,snippet FROM email_messages "
                    "ORDER BY msg_ts DESC NULLS LAST LIMIT 80")
        msgs = cur.fetchall()
    out = []
    with _gmail_lock:
        svc = gmail()
        for gmail_id, from_addr, subject, snippet in msgs:
            if not _sender_match(from_addr, pats):
                continue
            subjsnip = ((subject or "") + " " + (snippet or "")).lower()
            need_body = bool(fields) or (bool(contains) and not _any_in(contains, subjsnip))
            body = ""
            if need_body:
                try:
                    body = _plain_body(svc, gmail_id)
                except Exception:
                    body = ""
            if contains and not _any_in(contains, subjsnip + " " + body.lower()):
                continue
            extracted = _run_extract(fields, subject or "", body) if fields else {}
            out.append({"gmail_id": gmail_id, "from": from_addr, "subject": subject,
                        "extracted": extracted})
            if len(out) >= 20:
                break
    return jsonify(matches=out, disposition=rule.get("disposition"), count=len(out))

@app.post("/api/email/automation/run-now")
def api_run_now():
    """Retroactively apply the current rules to recent cached mail (live rules ACT;
    dry-run rules log). Dedupes against already-applied messages."""
    limit = min(int((request.get_json(silent=True) or {}).get("limit", 200)), 500)
    return jsonify(ok=True, **_run_now(limit))

@app.post("/api/email/resync")
def api_resync():
    """Re-fetch CURRENT Gmail labels for every cached message by id (fixes stale labels
    from before label-sync — e.g. spam moves that a search-based backfill misses since
    Gmail search excludes Spam/Trash; also drops messages deleted in Gmail)."""
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT gmail_id FROM email_messages")
        ids = [r[0] for r in cur.fetchall()]
    updated = removed = 0
    with _gmail_lock:
        svc = gmail()
        for mid in ids:
            try:
                m = svc.users().messages().get(userId="me", id=mid, format="minimal").execute()
                with db() as c, c.cursor() as cur:
                    cur.execute("UPDATE email_messages SET labels = %s::jsonb WHERE gmail_id = %s",
                                (json.dumps(m.get("labelIds", [])), mid))
                updated += 1
            except HttpError as e:
                if e.resp.status == 404:
                    with db() as c, c.cursor() as cur:
                        cur.execute("DELETE FROM email_messages WHERE gmail_id = %s", (mid,))
                    removed += 1
    log.info("resync: updated=%d removed=%d", updated, removed)
    return jsonify(ok=True, updated=updated, removed=removed)

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
