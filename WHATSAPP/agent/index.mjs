// WhatsApp agent (LXC 114) — Baileys personal-account bridge.
//   • one persistent Baileys socket (auto-reconnect, multi-file auth on disk)
//   • persists chats/contacts/messages to Postgres (dashboard reads from there)
//   • MQTT: publishes inbound -> mur/home/whatsapp/message ; subscribes mur/home/whatsapp/send
//   • Express HTTP API for the dashboard (read free; writes behind the send-guard)
// Ban-risk: read-primary; the send-guard enforces min-gap + hourly/daily caps + no-bulk
// + contact-only. Notifications default to self-chat (recipient:"self").
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode';
import express from 'express';
import mqtt from 'mqtt';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DIR   = path.dirname(fileURLToPath(import.meta.url));
const AUTH  = path.join(DIR, '.wa_auth');
const PORT  = parseInt(process.env.PORT || '8790', 10);
const log   = P({ level: process.env.LOG_LEVEL || 'info' });

// ── Postgres (trust auth from the LAN; no password needed) ──────────────────
const pool = new pg.Pool({
  host: process.env.DB_HOST || '192.168.1.219',
  user: process.env.DB_USER || 'postgres',
  database: process.env.DB_NAME || 'home_data',
  password: process.env.DB_PASS || undefined,
  port: 5432, max: 4,
});
const q = (text, params) => pool.query(text, params);

// ── State held in memory (mirrors whatsapp_state) ───────────────────────────
let sock = null;
let state = { connection: 'connecting', me: null, qrDataUrl: null, lastSync: null };
let settings = { min_gap_sec: 4, hourly_cap: 20, daily_cap: 100, contact_only: true,
                 del_min_gap_sec: 4, del_hourly_cap: 30,
                 react_min_gap_sec: 2, react_hourly_cap: 60 };
let lastSendTs = 0;
let authKeys = null;   // Baileys signal key store — LOCAL reads only (lid-mapping), never USync
let _actionTimes = [];   // epoch-ms of recent destructive actions (delete/leave), in-memory sliding hour
let _reactTimes = [];    // same idea for reactions (own lighter budget — see guardReact)

// Throttle for destructive actions (message delete / group leave / chat delete).
// Rapid bursts look like automation and risk a ban — refuse if too fast / over cap.
// Records the moment on every permitted attempt (conservative: counts outbound intent).
function guardAction() {
  const now = Date.now();
  const gap = settings.del_min_gap_sec != null ? settings.del_min_gap_sec : 4;
  const cap = settings.del_hourly_cap  != null ? settings.del_hourly_cap  : 30;
  _actionTimes = _actionTimes.filter(t => now - t < 3600e3);
  const last = _actionTimes.length ? _actionTimes[_actionTimes.length - 1] : 0;
  if ((now - last) / 1000 < gap) { const e = new Error('rate'); e.reason = 'rate'; throw e; }
  if (_actionTimes.length >= cap) { const e = new Error('cap'); e.reason = 'cap'; throw e; }
  _actionTimes.push(now);
}

// Reactions are outbound traffic, so they are throttled — but with their OWN budget.
// The 4 s message gap would make tapping 👍 feel broken, and a reaction is far lighter than a
// message: it can only ever land on a message in a chat you are already in, so it cannot be used
// to reach a stranger (the pattern that actually gets numbers banned).
function guardReact() {
  const now = Date.now();
  const gap = settings.react_min_gap_sec != null ? settings.react_min_gap_sec : 2;
  const cap = settings.react_hourly_cap  != null ? settings.react_hourly_cap  : 60;
  _reactTimes = _reactTimes.filter(t => now - t < 3600e3);
  const last = _reactTimes.length ? _reactTimes[_reactTimes.length - 1] : 0;
  if ((now - last) / 1000 < gap) { const e = new Error('rate'); e.reason = 'rate'; throw e; }
  if (_reactTimes.length >= cap) { const e = new Error('cap'); e.reason = 'cap'; throw e; }
  _reactTimes.push(now);
}

async function loadSettings() {
  try {
    const r = await q('SELECT settings FROM whatsapp_state WHERE id=1');
    if (r.rows[0] && r.rows[0].settings) settings = Object.assign(settings, r.rows[0].settings);
  } catch (e) { log.warn('loadSettings: ' + e.message); }
}
async function saveState() {
  try {
    await q(`UPDATE whatsapp_state SET connection=$1, me_jid=$2, last_sync=$3, updated_at=now() WHERE id=1`,
      [state.connection, state.me && state.me.jid, state.lastSync]);
  } catch (e) { log.warn('saveState: ' + e.message); }
}

// ── helpers ─────────────────────────────────────────────────────────────────
// Text of a message. Media CAPTIONS count as text — without this a photo with a
// caption reads as empty (every image row before 2026-09-01 has an empty body).
const bodyOf = (m) => {
  const x = m.message || {};
  return x.conversation
    || (x.extendedTextMessage && x.extendedTextMessage.text)
    || (x.imageMessage && x.imageMessage.caption)
    || (x.videoMessage && x.videoMessage.caption)
    || (x.documentMessage && x.documentMessage.caption)
    || '';
};
const typeOf = (m) => (m.message && Object.keys(m.message)[0]) || 'unknown';

// ── Media ───────────────────────────────────────────────────────────────────
// ⚠ Never decide "is this media" from the `type` column: typeOf() is just the FIRST
// key of the node, so real messages get labelled messageContextInfo /
// senderKeyDistributionMessage. Always look for the media node itself.
const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
const mediaNodeOf = (msg) => {
  if (!msg) return null;
  for (const k of MEDIA_KEYS) if (msg[k]) return { key: k, node: msg[k] };
  return null;
};
const mediaKindOf = (k) => (k === 'imageMessage' || k === 'stickerMessage') ? 'image'
  : k === 'videoMessage' ? 'video' : k === 'audioMessage' ? 'audio' : 'document';
const tsOf = (m) => m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : null;

async function upsertChat(jid, patch) {
  const isGroup = jid.endsWith('@g.us');
  await q(`INSERT INTO whatsapp_chats (jid, name, is_group, last_ts, unread, updated_at)
           VALUES ($1,$2,$3,$4,COALESCE($5,0),now())
           ON CONFLICT (jid) DO UPDATE SET
             name=COALESCE(EXCLUDED.name, whatsapp_chats.name),
             is_group=EXCLUDED.is_group,
             last_ts=GREATEST(COALESCE(EXCLUDED.last_ts, whatsapp_chats.last_ts), COALESCE(whatsapp_chats.last_ts, EXCLUDED.last_ts)),
             unread=COALESCE($5, whatsapp_chats.unread), updated_at=now()`,
    [jid, patch.name || null, isGroup, patch.last_ts || null, patch.unread === undefined ? null : patch.unread]);
}
async function upsertContact(jid, name, notify) {
  if (!jid) return;
  await q(`INSERT INTO whatsapp_contacts (jid, name, notify, updated_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (jid) DO UPDATE SET name=COALESCE(EXCLUDED.name, whatsapp_contacts.name),
             notify=COALESCE(EXCLUDED.notify, whatsapp_contacts.notify), updated_at=now()`,
    [jid, name || null, notify || null]);
}
async function upsertMessage(m, direction) {
  const chat = m.key.remoteJid;
  const sender = m.key.participant || m.participant || (m.key.fromMe ? (state.me && state.me.jid) : chat);
  const body = bodyOf(m);
  // Keep the message node for MEDIA (so the file can be fetched later, /media/:wa_id/*)
  // and for REACTIONS (the emoji + which message it answers live only in the node).
  let mediaProto = null;
  try {
    if (mediaNodeOf(m.message) || (m.message && m.message.reactionMessage)) {
      mediaProto = Buffer.from(proto.Message.encode(m.message).finish());
    }
  } catch (e) { log.warn('node encode: ' + e.message); }
  await q(`INSERT INTO whatsapp_messages (wa_id, chat_jid, sender_jid, sender_name, from_me, direction, type, body, ts, status, media_proto)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (wa_id, chat_jid) DO UPDATE SET status=COALESCE(EXCLUDED.status, whatsapp_messages.status),
             media_proto=COALESCE(whatsapp_messages.media_proto, EXCLUDED.media_proto)`,
    [m.key.id, chat, sender, m.pushName || null, !!m.key.fromMe,
     direction || (m.key.fromMe ? 'out' : 'in'), typeOf(m), (body || '').slice(0, 8000), tsOf(m), null, mediaProto]);
  await upsertChat(chat, { last_ts: tsOf(m) });
}

// ── Automation (dashboard_settings.whatsapp.rules) — mirror of the email agent ──
// Rules match an inbound message (sender / keyword / scope) → auto-reply and/or popup.
// Dry-run first; live reply goes through guardedSend; live popup just writes the log
// row (mode='live', action popup/both) which the dashboard reminders card reads via
// /api/reminders and shows as a blue card. No notification_events insert here.
let _rulesCache = { data: null, ts: 0 };
const _RULES_TTL = 30000;
async function loadRules() {
  const now = Date.now();
  if (_rulesCache.data && now - _rulesCache.ts < _RULES_TTL) return _rulesCache.data;
  let rules = _rulesCache.data || [];
  try {
    const r = await q(`SELECT value FROM dashboard_settings WHERE key='whatsapp.rules'`);
    const v = r.rows[0] && r.rows[0].value;
    rules = Array.isArray(v) ? v : (v ? JSON.parse(v) : []);
    _rulesCache = { data: rules, ts: now };
  } catch (e) { log.warn('loadRules: ' + e.message); }
  return rules;
}
const _lc = (s) => String(s == null ? '' : s).toLowerCase();

// ── Sender identity ─────────────────────────────────────────────────────────
// WhatsApp now delivers most messages from an anonymized @lid id that carries
// NEITHER the phone number NOR your address-book name — only the sender's own
// profile name (pushName). Matching a rule on a display name therefore failed for
// nearly every contact. So a rule's `from` is matched on IDENTITY: the set of ids
// that are the same person (lid + phone), plus every name that person is known by.
//
// ⚠ Resolution is LOCAL ONLY. Baileys' getLIDForPN() falls back to a USync query to
// WhatsApp's servers on a cache miss — bulk contact lookups from an unofficial client
// are a ban risk — so we read the signal key store directly instead (the same store
// Baileys reads: 'lid-mapping' → <pn>:<lid>, '<lid>_reverse':<pn>). A miss is a miss.
const _bare = (j) => String(j || '').split('@')[0].split(':')[0];
const _idCache = new Map();   // jid -> {ids:[], ts}
const _ID_TTL = 10 * 60 * 1000;
async function identityIds(jid) {
  if (!jid) return [];
  const key = _bare(jid);
  if (!key) return [];
  const hit = _idCache.get(key);
  if (hit && Date.now() - hit.ts < _ID_TTL) return hit.ids;
  const ids = new Set([key]);
  try {
    if (authKeys && String(jid).includes('@lid')) {
      const r = await authKeys.get('lid-mapping', [key + '_reverse']);
      const pn = r && r[key + '_reverse'];
      if (pn && typeof pn === 'string') ids.add(_bare(pn));
    } else if (authKeys && String(jid).includes('@s.whatsapp.net')) {
      const r = await authKeys.get('lid-mapping', [key]);         // local read, no USync
      const lid = r && r[key];
      if (lid && typeof lid === 'string') ids.add(_bare(lid));
    }
  } catch (e) { /* unmapped — the bare id still matches */ }
  const out = [...ids];
  _idCache.set(key, { ids: out, ts: Date.now() });
  return out;
}
// Every name this sender is known by: profile name (pushName) + the chat's own /
// renamed title + your address-book name for EITHER identity. Keeps old name-based
// rules working and makes the names the From-picker offers actually matchable.
async function identityNames(ids, chatIds) {
  const all = [...new Set([...(ids || []), ...(chatIds || [])])];
  if (!all.length) return [];
  const jids = [];
  for (const id of all) jids.push(id + '@s.whatsapp.net', id + '@lid', id + '@g.us');
  const names = new Set();
  try {
    const r = await q(`SELECT custom_name, name FROM whatsapp_chats WHERE jid = ANY($1)`, [jids]);
    for (const row of r.rows) { if (row.custom_name) names.add(row.custom_name); if (row.name) names.add(row.name); }
    const c = await q(`SELECT name, notify FROM whatsapp_contacts WHERE jid = ANY($1)`, [jids]);
    for (const row of c.rows) { if (row.name) names.add(row.name); if (row.notify) names.add(row.notify); }
  } catch (e) { log.warn('identityNames: ' + e.message); }
  return [...names];
}
// Your address-book name for a chat, found through the sender's OTHER identity.
// WhatsApp delivers many chats as an anonymized @lid that has no contact row, so the
// name chain falls through to the sender's own profile name — which can be junk (a
// live case: Alon Muroch's chat showed as "." because that is his profile name).
// identityIds() gives us the phone counterpart from the LOCAL key store, and the
// contact row hanging off THAT jid is the name you actually recognise.
async function bookNames(chatJids) {
  const out = {};
  const alt = {};
  for (const jid of new Set(chatJids.filter(Boolean))) {
    const ids = await identityIds(jid);
    const others = ids.filter(x => x !== _bare(jid));
    if (others.length) alt[jid] = others;
  }
  const lookup = [];
  for (const list of Object.values(alt)) for (const id of list) lookup.push(id + '@s.whatsapp.net', id + '@lid');
  if (!lookup.length) return out;
  try {
    const r = await q(`SELECT jid, COALESCE(NULLIF(name,''), NULLIF(notify,'')) AS nm
                       FROM whatsapp_contacts WHERE jid = ANY($1) AND COALESCE(name, notify) IS NOT NULL`, [lookup]);
    const byId = {}; r.rows.forEach(x => { byId[_bare(x.jid)] = x.nm; });
    const c = await q(`SELECT jid, COALESCE(NULLIF(custom_name,''), NULLIF(name,'')) AS nm
                       FROM whatsapp_chats WHERE jid = ANY($1) AND COALESCE(custom_name, name) IS NOT NULL`, [lookup]);
    c.rows.forEach(x => { if (!byId[_bare(x.jid)]) byId[_bare(x.jid)] = x.nm; });
    for (const [jid, ids] of Object.entries(alt)) {
      const hit = ids.map(i => byId[i]).find(Boolean);
      if (hit) out[jid] = hit;
    }
  } catch (e) { log.warn('bookNames: ' + e.message); }
  return out;
}
// One shared context builder for all three evaluation paths (live inbound,
// run-now preview, rule test) so they can never drift apart.
async function buildCtx(o) {
  const chat_jid = o.chat_jid;
  const from_jid = o.from_jid || chat_jid;
  const chatIds = await identityIds(chat_jid);
  const fromIds = await identityIds(from_jid);
  const ids = [...new Set([...chatIds, ...fromIds])];
  const names = await identityNames(fromIds, chatIds);
  if (o.from_name) names.unshift(o.from_name);
  return { wa_id: o.wa_id || null, chat_jid, from_jid,
    is_group: String(chat_jid || '').endsWith('@g.us'),
    from_name: o.from_name || null, body: o.body || '',
    ids, names: [...new Set(names.filter(Boolean))] };
}

function ruleMatches(rule, ctx) {
  const m = rule.match || {};
  const scope = m.scope || 'all';
  if (scope === 'people' && ctx.is_group) return false;
  if (scope === 'groups' && !ctx.is_group) return false;
  const froms = (m.from || []).filter(Boolean);
  if (froms.length) {
    // An id entry (what the From-picker writes) matches EXACTLY — substring would
    // make a DM id fire on the legacy group jid that embeds it
    // (972545259144 ⊂ 972545259144-1402322229@g.us). A text entry matches a name.
    const ids = ctx.ids || [];
    const names = (ctx.names || []).map(_lc);
    const ok = froms.some(f => {
      const raw = String(f).trim();
      const bare = _bare(raw);                       // strips @domain and :device
      // ids: a phone/lid (all digits) OR a LEGACY group jid <creator>-<created_ts>
      const isId = /^\d{5,}(-\d{5,})?$/.test(bare) && /^[\d@.:a-z-]+$/i.test(raw);
      if (isId) return ids.includes(bare);
      const t = _lc(raw);
      return names.some(n => n.includes(t));
    });
    if (!ok) return false;
  }
  const contains = (m.contains || []).filter(Boolean);
  if (contains.length) {
    const b = _lc(ctx.body);
    if (!contains.some(c => b.includes(_lc(c)))) return false;
  }
  return true;
}
async function logAuto(rule, ctx, action, mode, applied, note) {
  try {
    // popup_text = the rule's own sentence AT FIRE TIME. Stored on the row (not looked up
    // later) so a popup always shows the sentence that actually fired it.
    await q(`INSERT INTO whatsapp_automation_log
             (rule_id,rule_name,wa_id,chat_jid,from_jid,from_name,matched_text,action,mode,applied,note,popup_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [rule.id || null, rule.name || null, ctx.wa_id || null, ctx.chat_jid, ctx.from_jid, ctx.from_name,
       (ctx.body || '').slice(0, 500), action, mode, applied, note || null,
       (rule.popup && rule.popup.text) ? String(rule.popup.text).slice(0, 300) : null]);
  } catch (e) { log.warn('logAuto: ' + e.message); }
}
// Evaluate rules for one inbound message. live=false → PREVIEW ONLY (log dry-run, no
// send/popup — used by run-now). live=true → act only when the matched rule is mode:'live'.
async function applyAutomation(ctx, live) {
  const rules = await loadRules();
  for (const rule of rules) {
    if (!rule || !rule.active) continue;
    if (!ruleMatches(rule, ctx)) continue;               // first matching ACTIVE rule wins
    const doReply = !!(rule.reply && rule.reply.text);
    const doPopup = !!rule.popup;
    const action = doReply && doPopup ? 'both' : (doReply ? 'reply' : (doPopup ? 'popup' : 'none'));
    if (action === 'none') { await logAuto(rule, ctx, 'none', 'dryrun', false, 'matched, no action'); return true; }
    const liveMode = live && (rule.mode === 'live');
    if (!liveMode) {
      const preview = [doReply ? 'reply' : null, doPopup ? 'popup' : null].filter(Boolean).join(' + ');
      await logAuto(rule, ctx, action, 'dryrun', false, 'would ' + preview);
      return true;
    }
    let replied = false; const note = [];
    if (doReply) {
      try { await guardedSend(ctx.chat_jid, rule.reply.text); replied = true; note.push('replied'); }
      catch (e) { note.push('reply blocked: ' + (e.reason || e.message)); }
    }
    // popup is delivered by the reminders card (top-right, where medical/journal show):
    // it reads this LIVE popup log row via /api/reminders. No notification_events insert.
    if (doPopup) note.push('popup');
    await logAuto(rule, ctx, action, 'live', replied || doPopup, note.join('; '));
    return true;
  }
  return false;
}

// ── MQTT ────────────────────────────────────────────────────────────────────
let mqc = null;
function mqttConnect() {
  mqc = mqtt.connect('mqtt://' + (process.env.MQTT_HOST || '192.168.1.189') + ':1883', {
    username: process.env.MQTT_USER || 'whatsapp_agent',
    password: process.env.MQTT_PASS || '',
    reconnectPeriod: 5000,
  });
  mqc.on('connect', () => { log.info('MQTT connected'); mqc.subscribe('mur/home/whatsapp/send'); });
  mqc.on('message', async (topic, buf) => {
    if (topic !== 'mur/home/whatsapp/send') return;
    let cmd = {}; try { cmd = JSON.parse(buf.toString()); } catch (e) { return; }
    let jid = cmd.recipient || 'self';
    if (jid === 'self') jid = state.me && state.me.jid;
    if (!jid || !cmd.text) return;
    try { await guardedSend(jid, cmd.text, cmd.force); log.info('MQTT send -> ' + jid.slice(0, 8)); }
    catch (e) { log.warn('MQTT send blocked: ' + e.message); }
  });
  mqc.on('error', (e) => log.warn('MQTT: ' + e.message));
}
function publishInbound(m) {
  if (!mqc || !mqc.connected) return;
  const chat = m.key.remoteJid;
  const payload = {
    chat_jid: chat, is_group: chat.endsWith('@g.us'),
    from_jid: m.key.participant || m.participant || chat, from_name: m.pushName || null,
    text: bodyOf(m), type: typeOf(m), wa_id: m.key.id,
    ts: tsOf(m) ? tsOf(m).toISOString() : null,
  };
  mqc.publish('mur/home/whatsapp/message', JSON.stringify(payload), { qos: 1 });
}

// ── send-guard ───────────────────────────────────────────────────────────────
async function guardedSend(jid, text, force, quoted) {
  const now = Date.now();
  if ((now - lastSendTs) / 1000 < settings.min_gap_sec) { const e = new Error('rate'); e.reason = 'rate'; throw e; }
  // Count ONLY messages this agent actually sent (status='sent'); NOT the user's
  // own historical sent messages synced from the phone (those have status NULL).
  const hr = Number((await q(`SELECT count(*) c FROM whatsapp_messages WHERE status='sent' AND created_at > now()-interval '1 hour'`)).rows[0].c);
  if (hr >= settings.hourly_cap) { const e = new Error('hourly_cap'); e.reason = 'cap'; throw e; }
  const day = Number((await q(`SELECT count(*) c FROM whatsapp_messages WHERE status='sent' AND created_at > now()-interval '1 day'`)).rows[0].c);
  if (day >= settings.daily_cap) { const e = new Error('daily_cap'); e.reason = 'cap'; throw e; }
  if (settings.contact_only && !force && jid !== (state.me && state.me.jid)) {
    const known = Number((await q(`SELECT (EXISTS(SELECT 1 FROM whatsapp_chats WHERE jid=$1) OR EXISTS(SELECT 1 FROM whatsapp_contacts WHERE jid=$1))::int x`, [jid])).rows[0].x);
    if (!known) { const e = new Error('not_contact'); e.reason = 'not_contact'; throw e; }
  }
  if (!sock || state.connection !== 'open') { const e = new Error('not_connected'); e.reason = 'not_connected'; throw e; }
  // `quoted` (optional) makes this a REPLY to one specific message — WhatsApp shows the
  // quoted bubble above it. Baileys takes it as the 3rd arg (MiscMessageGenerationOptions).
  const sent = await sock.sendMessage(jid, { text: String(text) }, quoted ? { quoted } : undefined);
  lastSendTs = now;
  // log as outbound
  await q(`INSERT INTO whatsapp_messages (wa_id, chat_jid, sender_jid, sender_name, from_me, direction, type, body, ts, status)
           VALUES ($1,$2,$3,$4,true,'out','conversation',$5,now(),'sent')
           ON CONFLICT (wa_id, chat_jid) DO NOTHING`,
    [sent.key.id, jid, state.me && state.me.jid, null, String(text).slice(0, 8000)]);
  await upsertChat(jid, { last_ts: new Date() });
  return sent;
}

// ── Group metadata (owner + participant count) for the dashboard groups view ──
async function refreshGroups() {
  try {
    const gs = await sock.groupFetchAllParticipating();
    for (const g of Object.values(gs)) {
      await q(`INSERT INTO whatsapp_chats (jid, name, is_group, owner_jid, participant_count, updated_at)
               VALUES ($1,$2,true,$3,$4,now())
               ON CONFLICT (jid) DO UPDATE SET
                 name=COALESCE(EXCLUDED.name, whatsapp_chats.name), is_group=true,
                 owner_jid=EXCLUDED.owner_jid, participant_count=EXCLUDED.participant_count, updated_at=now()`,
        [g.id, g.subject || null, g.owner || null, (g.participants || []).length]);
    }
    log.info('refreshGroups: ' + Object.keys(gs).length + ' groups');
  } catch (e) { log.warn('refreshGroups: ' + e.message); }
}

// ── Baileys connect + event wiring ───────────────────────────────────────────
async function connect() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH);
  authKeys = authState.keys;            // local lid-mapping reads (see identityIds)
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: authState, logger: P({ level: 'silent' }), browser: ['whatsapp-agent', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    try {
      for (const c of (chats || [])) await upsertChat(c.id, { name: c.name || c.subject, unread: c.unreadCount });
      for (const c of (contacts || [])) await upsertContact(c.id, c.name || c.verifiedName, c.notify);
      for (const m of (messages || [])) if (m.message) await upsertMessage(m);
      state.lastSync = new Date(); await saveState();
      log.info(`history.set: +${(chats||[]).length}ch +${(contacts||[]).length}ct +${(messages||[]).length}msg`);
    } catch (e) { log.warn('history.set: ' + e.message); }
  });
  sock.ev.on('contacts.upsert', async (cs) => { for (const c of cs) await upsertContact(c.id, c.name || c.verifiedName, c.notify).catch(()=>{}); });
  sock.ev.on('chats.upsert', async (cs) => { for (const c of cs) await upsertChat(c.id, { name: c.name, unread: c.unreadCount }).catch(()=>{}); });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      try { await upsertMessage(m); } catch (e) { log.warn('msg upsert: ' + e.message); }
      // A reaction is stored (the thread shows it as a chip) but it is NOT an incoming
      // message: its body is empty, so a rule that matches only on the SENDER would fire a
      // real auto-reply just because someone tapped a thumbs-up. Never automate on one.
      const isReaction = !!(m.message && m.message.reactionMessage);
      if (!m.key.fromMe && !isReaction) {
        publishInbound(m);
        buildCtx({ wa_id: m.key.id, chat_jid: m.key.remoteJid,
          from_jid: m.key.participant || m.participant || m.key.remoteJid,
          from_name: m.pushName || null, body: bodyOf(m) })
          .then(ctx => applyAutomation(ctx, true))
          .catch(e => log.warn('automation: ' + e.message));
      }
    }
  });

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { state.qrDataUrl = await qrcode.toDataURL(qr).catch(() => null); state.connection = 'qr'; await saveState(); }
    if (connection === 'open') {
      state.connection = 'open'; state.qrDataUrl = null;
      state.me = { jid: sock.user && sock.user.id, name: sock.user && sock.user.name };
      await saveState(); log.info('connection OPEN as ' + (state.me.jid || '?'));
      setTimeout(refreshGroups, 5000);  // owner + participant counts for the groups view
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        state.connection = 'logged-out'; state.me = null; await saveState();
        log.warn('LOGGED OUT — clearing auth, need relink'); try { await import('fs').then(fs => fs.promises.rm(AUTH, { recursive: true, force: true })); } catch (e) {}
        setTimeout(connect, 2000);   // fresh QR
      } else {
        state.connection = 'connecting'; await saveState();
        log.warn('connection closed (code=' + code + ') — reconnecting'); setTimeout(connect, 2000);
      }
    }
  });
}

// ── HTTP API ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
// CORS — the dashboard (different origin) calls this API directly (like email/kitchen agents).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Same-origin live-QR linking page (used for first link before the dashboard tab exists).
app.get('/link', (req, res) => res.type('html').send(`<!doctype html><meta charset=utf-8>
<title>Link WhatsApp</title><body style="background:#0b141a;color:#e9edef;font-family:sans-serif;text-align:center;padding:24px">
<h2 id=h>Loading…</h2><img id=q style="width:340px;height:340px;background:#fff;border-radius:10px;padding:10px;display:none">
<div style="color:#8696a0;max-width:420px;margin:14px auto;font-size:14px">On your phone: <b>WhatsApp → Settings → Linked Devices → Link a device</b>, then scan. The QR refreshes automatically.</div>
<script>async function t(){try{const j=await(await fetch('/qr')).json();const h=document.getElementById('h'),q=document.getElementById('q');
if(j.connection==='open'){h.textContent='✅ Connected';q.style.display='none';}
else if(j.qr){h.textContent='Scan to link';q.src=j.qr;q.style.display='inline-block';}
else{h.textContent='Connecting…';}}catch(e){}}
t();setInterval(t,2000);</script></body>`));
const ok = (res, data) => res.json(Object.assign({ ok: true }, data));
const bad = (res, reason, http) => res.status(http || 400).json({ ok: false, reason });

app.get('/status', async (req, res) => {
  const counts = await q(`SELECT
    (SELECT count(*) FROM whatsapp_chats) chats,
    (SELECT count(*) FROM whatsapp_chats WHERE is_group) groups,
    (SELECT count(*) FROM whatsapp_contacts) contacts,
    (SELECT count(*) FROM whatsapp_messages) messages`).then(r => r.rows[0]).catch(() => ({}));
  ok(res, { connection: state.connection, me: state.me, lastSync: state.lastSync, counts });
});
app.get('/qr', (req, res) => ok(res, { qr: state.qrDataUrl, connection: state.connection }));
// All chats — name-resolved + searchable + recent-first + paged. Resolution chain:
// chat.name -> contact.name -> contact.notify -> latest message pushName -> number
// (for @s.whatsapp.net) -> raw jid (@lid = "unknown"). Empty stubs (no ts, no msgs)
// and status@broadcast are filtered out. count(*) OVER() gives the search-aware total.
app.get('/chats', async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit) || 40, 200);
  const off = Math.max(parseInt(req.query.offset) || 0, 0);
  const qs  = (req.query.q || '').trim();
  const like = '%' + qs.replace(/[%_\\]/g, m => '\\' + m) + '%';
  const filter = ['dm', 'group', 'unknown', 'renamed'].includes(req.query.filter) ? req.query.filter : 'all';
  const fSql = filter === 'dm' ? ' AND NOT is_group'
             : filter === 'group' ? ' AND is_group'
             : filter === 'unknown' ? ' AND disp IS NULL'
             : filter === 'renamed' ? ' AND custom_name IS NOT NULL' : '';
  const r = await q(`
    WITH base AS (
      SELECT c.jid, c.is_group, c.last_ts, c.unread, c.custom_name,
        COALESCE(NULLIF(c.custom_name,''), NULLIF(c.name,''), NULLIF(ct.name,''), NULLIF(ct.notify,''),
          NULLIF((SELECT m.sender_name FROM whatsapp_messages m
                  WHERE m.chat_jid=c.jid AND m.sender_name IS NOT NULL
                  ORDER BY m.ts DESC NULLS LAST LIMIT 1),''),
          CASE WHEN c.jid LIKE '%@s.whatsapp.net' THEN split_part(c.jid,'@',1) END) AS disp,
        EXISTS(SELECT 1 FROM whatsapp_messages m2 WHERE m2.chat_jid=c.jid) AS has_msgs
      FROM whatsapp_chats c
      LEFT JOIN whatsapp_contacts ct ON ct.jid=c.jid
      WHERE c.jid NOT LIKE '%@broadcast'
    )
    SELECT jid, is_group, last_ts, unread, disp AS name,
           (disp IS NOT NULL) AS resolved, count(*) OVER() AS total
    FROM base
    WHERE (last_ts IS NOT NULL OR has_msgs)
      AND ($1 = '' OR disp ILIKE $2 OR jid ILIKE $2)${fSql}
    ORDER BY last_ts DESC NULLS LAST
    LIMIT $3 OFFSET $4`, [qs, like, lim, off]);
  const total = r.rows[0] ? Number(r.rows[0].total) : 0;
  const chats = r.rows.map(({ total, ...c }) => c);
  // Same identity-based naming as the feed: an @lid chat with no contact row of its own
  // still has your address-book name hanging off its phone counterpart.
  try {
    const book = await bookNames(chats.filter(c => !c.is_group).map(c => c.jid));
    chats.forEach(c => { if (book[c.jid]) { c.name = book[c.jid]; c.resolved = true; } });
  } catch (e) { log.warn('chats names: ' + e.message); }
  ok(res, { chats, total, offset: off, limit: lim });
});
app.get('/groups', async (req, res) => {
  const r = await q(`SELECT c.jid, c.name, c.owner_jid, c.participant_count, c.last_ts, c.unread,
                            ct.name AS owner_name, ct.notify AS owner_notify
                     FROM whatsapp_chats c
                     LEFT JOIN whatsapp_contacts ct ON ct.jid = c.owner_jid
                     WHERE c.is_group ORDER BY c.name NULLS LAST`);
  ok(res, { groups: r.rows });
});
// Full participant list for ONE group, fetched live from Baileys (names resolved
// from the contacts cache; falls back to the number). Read-only, zero ban risk.
app.get('/group/:jid', async (req, res) => {
  try {
    const jid = req.params.jid;
    if (!sock || state.connection !== 'open') return bad(res, 'not_connected', 409);
    const md = await sock.groupMetadata(jid);
    const parts = md.participants || [];
    // Best-effort: WhatsApp now anonymizes group members as @lid; resolve to the
    // phone-jid via Baileys' learned LID map (only LIDs it has seen resolve).
    const lidStore = sock.signalRepository && sock.signalRepository.lidMapping;
    const pnOf = async (id) => {
      if (!id || !id.endsWith('@lid') || !lidStore || !lidStore.getPNForLID) return id;
      try { const pn = await Promise.resolve(lidStore.getPNForLID(id)); return pn || id; } catch (e) { return id; }
    };
    const norm = (j) => (j ? j.replace(/:\d+@/, '@') : j);   // strip :device so it matches contacts
    const resolved = await Promise.all(parts.map(async p => ({ lid: p.id, jid: norm(await pnOf(p.id)), admin: p.admin || null })));
    const ownerPn = norm(await pnOf(md.owner || null));
    const lookup = resolved.map(r => r.jid).concat(ownerPn ? [ownerPn] : []);
    const names = {};
    if (lookup.length) {
      const nr = await q(`SELECT jid, name, notify FROM whatsapp_contacts WHERE jid = ANY($1)`, [lookup]);
      for (const row of nr.rows) names[row.jid] = row.name || row.notify || null;
    }
    const numOf = (j) => (j && j.includes('@s.whatsapp.net')) ? j.split('@')[0] : null;
    const participants = resolved.map(r => ({ jid: r.jid, lid: r.lid, name: names[r.jid] || null, number: numOf(r.jid), admin: r.admin }));
    ok(res, {
      jid, subject: md.subject, desc: md.desc || null,
      owner: ownerPn, owner_name: (ownerPn && names[ownerPn]) || null, owner_number: numOf(ownerPn),
      creation: md.creation || null, size: md.size || participants.length,
      resolved_count: participants.filter(p => p.name || p.number).length,
      participants,
    });
  } catch (e) { bad(res, e.message, 500); }
});
// Senders for the rule From-picker: ONE entry per person, value = an id that is
// guaranteed to match an inbound message (the picker must never offer something the
// matcher can't see — an address-book name alone never appears in a message).
// A person reachable under both identities (@lid + phone) is merged into one row,
// labelled with the best name we know. LOCAL lid-mapping reads only — no USync.
app.get('/automation/senders', async (req, res) => {
  try {
    const scope = ['people', 'groups', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    const r = await q(`
      SELECT c.jid, c.is_group, c.last_ts,
        COALESCE(NULLIF(c.custom_name,''), NULLIF(c.name,''), NULLIF(ct.name,''), NULLIF(ct.notify,''),
          NULLIF((SELECT m.sender_name FROM whatsapp_messages m
                  WHERE m.chat_jid=c.jid AND m.sender_name IS NOT NULL
                  ORDER BY m.ts DESC NULLS LAST LIMIT 1),'')) AS name
      FROM whatsapp_chats c LEFT JOIN whatsapp_contacts ct ON ct.jid=c.jid
      WHERE c.jid NOT LIKE '%@broadcast'
        AND EXISTS (SELECT 1 FROM whatsapp_messages m2 WHERE m2.chat_jid=c.jid AND NOT m2.from_me)
      ORDER BY c.last_ts DESC NULLS LAST`);
    const byKey = new Map();
    for (const row of r.rows) {
      if (scope === 'people' && row.is_group) continue;
      if (scope === 'groups' && !row.is_group) continue;
      const ids = row.is_group ? [_bare(row.jid)] : await identityIds(row.jid);
      const key = ids.slice().sort().join('|');            // both identities => one entry
      const cur = byKey.get(key);
      if (!cur) { byKey.set(key, { id: ids[0], ids, name: row.name || null, is_group: row.is_group, last_ts: row.last_ts }); continue; }
      if (!cur.name && row.name) cur.name = row.name;      // fill the label from either row
      if (row.last_ts && (!cur.last_ts || row.last_ts > cur.last_ts)) cur.last_ts = row.last_ts;
    }
    const senders = [...byKey.values()].filter(x => x.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    ok(res, { senders });
  } catch (e) { bad(res, e.message, 500); }
});
// ── Media: preview + full file ──────────────────────────────────────────────
// The stored node (media_proto) is the only way back to an encrypted WhatsApp file.
// /thumb serves the jpegThumbnail that CAME WITH the message — zero WhatsApp traffic.
// /full downloads on demand (what the real client does) and caches the bytes on disk.
// ⚠ LXC 114 has an 8 GB root, so the cache is bounded: big files are streamed but not
// cached, and the directory is pruned oldest-first past the ceiling.
const MEDIA_CACHE = path.join(DIR, '.media_cache');
const CACHE_MAX_FILE = 25 * 1024 * 1024;    // don't cache anything larger
const CACHE_MAX_TOTAL = 300 * 1024 * 1024;  // prune oldest past this
function cachePrune() {
  try {
    const files = fs.readdirSync(MEDIA_CACHE).map(f => {
      const st = fs.statSync(path.join(MEDIA_CACHE, f));
      return { f, size: st.size, at: st.mtimeMs };
    }).sort((a, b) => a.at - b.at);
    let total = files.reduce((n, x) => n + x.size, 0);
    while (total > CACHE_MAX_TOTAL && files.length) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(MEDIA_CACHE, old.f)); total -= old.size; } catch (e) {}
    }
  } catch (e) { /* cache is best-effort */ }
}
async function mediaRowOf(waId) {
  const r = await q('SELECT wa_id, chat_jid, sender_jid, from_me, media_proto FROM whatsapp_messages WHERE wa_id=$1 AND media_proto IS NOT NULL LIMIT 1', [waId]);
  const row = r.rows[0]; if (!row) return null;
  let msg = null;
  try { msg = proto.Message.decode(row.media_proto); } catch (e) { return null; }
  const media = mediaNodeOf(msg); if (!media) return null;
  return { row, msg, media };
}
app.get('/media/:wa_id/thumb', async (req, res) => {
  try {
    const hit = await mediaRowOf(req.params.wa_id); if (!hit) return bad(res, 'not_found', 404);
    const t = hit.media.node.jpegThumbnail;
    if (!t || !t.length) return bad(res, 'no_thumbnail', 404);
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'max-age=86400').send(Buffer.from(t));
  } catch (e) { bad(res, e.message, 500); }
});
app.get('/media/:wa_id/full', async (req, res) => {
  try {
    const hit = await mediaRowOf(req.params.wa_id); if (!hit) return bad(res, 'not_found', 404);
    const mime = hit.media.node.mimetype || 'application/octet-stream';
    const cached = path.join(MEDIA_CACHE, req.params.wa_id.replace(/[^A-Za-z0-9_-]/g, '') );
    if (fs.existsSync(cached)) {
      return res.set('Content-Type', mime).set('Cache-Control', 'max-age=86400').send(fs.readFileSync(cached));
    }
    if (!sock || state.connection !== 'open') return bad(res, 'not_connected', 409);
    const buf = await downloadMediaMessage(
      { key: { remoteJid: hit.row.chat_jid, id: hit.row.wa_id, fromMe: !!hit.row.from_me,
               participant: String(hit.row.chat_jid).endsWith('@g.us') ? hit.row.sender_jid : undefined },
        message: hit.msg },
      'buffer', {}, { reuploadRequest: sock.updateMediaMessage, logger: log });
    try {
      if (buf.length <= CACHE_MAX_FILE) {
        fs.mkdirSync(MEDIA_CACHE, { recursive: true });
        fs.writeFileSync(cached, buf);
        cachePrune();
      }
    } catch (e) { log.warn('media cache: ' + e.message); }
    log.info('media served ' + req.params.wa_id + ' (' + mime + ', ' + buf.length + ' bytes)');
    res.set('Content-Type', mime).set('Cache-Control', 'max-age=86400').send(buf);
  } catch (e) { log.warn('media download: ' + e.message); bad(res, 'media_unavailable', 404); }
});
// Send-guard settings (read/update) for the dashboard WhatsApp Settings card.
app.get('/settings', (req, res) => ok(res, { settings }));
app.post('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const ci = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
    settings = Object.assign(settings, {
      min_gap_sec:  ci(b.min_gap_sec, 0, 3600, settings.min_gap_sec),
      hourly_cap:   ci(b.hourly_cap,  1, 1000, settings.hourly_cap),
      daily_cap:    ci(b.daily_cap,   1, 5000, settings.daily_cap),
      contact_only: b.contact_only === undefined ? settings.contact_only : !!b.contact_only,
      del_min_gap_sec: ci(b.del_min_gap_sec, 0, 3600, settings.del_min_gap_sec),
      del_hourly_cap:  ci(b.del_hourly_cap,  1, 1000, settings.del_hourly_cap),
      react_min_gap_sec: ci(b.react_min_gap_sec, 0, 3600, settings.react_min_gap_sec),
      react_hourly_cap:  ci(b.react_hourly_cap,  1, 1000, settings.react_hourly_cap),
    });
    await q(`UPDATE whatsapp_state SET settings=$1, updated_at=now() WHERE id=1`, [JSON.stringify(settings)]);
    log.info('settings updated: ' + JSON.stringify(settings));
    ok(res, { settings });
  } catch (e) { bad(res, e.message, 500); }
});
// Manual re-sync of group owner/counts (the dashboard "refresh groups" button).
app.post('/groups/refresh', async (req, res) => {
  try { await refreshGroups(); ok(res, {}); } catch (e) { bad(res, e.message, 500); }
});
app.get('/contacts', async (req, res) => {
  const r = await q(`SELECT jid,name,notify FROM whatsapp_contacts ORDER BY name NULLS LAST`);
  ok(res, { contacts: r.rows });
});
app.get('/messages', async (req, res) => {
  const jid = req.query.jid; if (!jid) return bad(res, 'jid required');
  const lim = Math.min(parseInt(req.query.limit) || 200, 1000);
  const r = await q(`SELECT wa_id,chat_jid,sender_jid,sender_name,from_me,direction,type,body,ts,status,media_proto
                     FROM whatsapp_messages WHERE chat_jid=$1 ORDER BY ts DESC NULLS LAST LIMIT $2`, [jid, lim]);
  // Media flags are derived by DECODING the stored node — never from `type`, which is
  // just the first key of the message and mislabels many rows.
  const msgs = r.rows.map(m => {
    const { media_proto, ...rest } = m;
    if (!media_proto) return rest;
    try {
      const hit = mediaNodeOf(proto.Message.decode(media_proto));
      if (!hit) return rest;
      const t = hit.node.jpegThumbnail;
      return { ...rest, has_media: true, media_kind: mediaKindOf(hit.key),
               mime: hit.node.mimetype || null, has_thumb: !!(t && t.length),
               file_name: hit.node.fileName || null };
    } catch (e) { return rest; }
  });
  // Reactions are not messages — they belong UNDER the message they answer.
  // Each person has AT MOST ONE reaction per message: changing it, or removing it (which
  // arrives as an empty text), supersedes their previous one. So keep only the LATEST row
  // per (answered message, author) — collecting every row would leave a removed 👍 on screen.
  const latest = {};                                   // "<target>|<author>" -> {ts, emoji, from_me, by}
  for (const m of r.rows) {                            // rows are newest-first (ORDER BY ts DESC)
    if (!m.media_proto || m.type !== 'reactionMessage') continue;
    try {
      const node = proto.Message.decode(m.media_proto).reactionMessage;
      const tid = node && node.key && node.key.id;
      if (!tid) continue;
      const k = tid + '|' + (m.from_me ? 'me' : (m.sender_jid || '?'));
      const ts = m.ts ? new Date(m.ts).getTime() : 0;
      if (latest[k] && latest[k].ts >= ts) continue;
      latest[k] = { ts, tid, emoji: node.text || '', from_me: !!m.from_me, by: m.sender_name || null };
    } catch (e) { /* unreadable node — skip */ }
  }
  const reactions = {};
  for (const k of Object.keys(latest)) {
    const v = latest[k];
    if (!v.emoji) continue;                            // their latest action was a removal
    (reactions[v.tid] = reactions[v.tid] || []).push({ emoji: v.emoji, from_me: v.from_me, by: v.by });
  }
  ok(res, { messages: msgs.reverse(), reactions });
});
// Live "new messages" monitor — latest INBOUND messages, newest first, chat name
// resolved via the same chain as /chats. Skips empty WhatsApp system rows
// (senderKeyDistributionMessage/protocolMessage with no body). Read-only, zero risk.
app.get('/recent', async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit) || 15, 50);
  const r = await q(`
    SELECT m.wa_id, m.chat_jid, m.sender_name, m.body, m.type, m.ts, m.media_proto, c.is_group,
      COALESCE(NULLIF(c.custom_name,''), NULLIF(c.name,''), NULLIF(ct.name,''), NULLIF(ct.notify,''),
        NULLIF(m.sender_name,''),
        CASE WHEN m.chat_jid LIKE '%@s.whatsapp.net' THEN split_part(m.chat_jid,'@',1) END) AS chat_name
    FROM whatsapp_messages m
    LEFT JOIN whatsapp_chats c     ON c.jid = m.chat_jid
    LEFT JOIN whatsapp_contacts ct ON ct.jid = m.chat_jid
    WHERE m.from_me = false
      -- Keep a real message, drop WhatsApp's noise (reactions / key rotation / context).
      -- ⚠ media_proto is checked FIRST: the type column is only the first key of the node, so a real
      -- photo can arrive labelled senderKeyDistributionMessage and, without a caption, the
      -- type test alone silently hid it from the feed (seen live 2026-09-01 17:33).
      AND (COALESCE(m.body,'') <> '' OR m.media_proto IS NOT NULL
           OR m.type ~* 'image|video|audio|ptt|sticker|document|location')
      -- (reactions ride in on media_proto: their node is stored, so they pass the line above
      --  and are LABELLED below — without that they would render as a blank feed row)
    ORDER BY m.ts DESC NULLS LAST
    LIMIT $1`, [lim]);
  // Same media flags as /messages so the feed can show a preview instead of "📷 photo".
  // Derived by DECODING the stored node — never from `type` (see mediaNodeOf).
  const rows = r.rows.map(m => {
    const { media_proto, ...rest } = m;
    if (!media_proto) return rest;
    try {
      const node = proto.Message.decode(media_proto);
      // Someone reacted to one of your messages. bodyOf() has no text for a reaction, so say
      // what happened instead of showing an empty line.
      if (node.reactionMessage) {
        const t = node.reactionMessage.text || '';
        return { ...rest, body: t ? ('reacted ' + t) : 'removed a reaction', is_reaction: true };
      }
      const hit = mediaNodeOf(node);
      if (hit) {
        const t = hit.node.jpegThumbnail;
        return { ...rest, has_media: true, media_kind: mediaKindOf(hit.key), has_thumb: !!(t && t.length) };
      }
      if (node.reactionMessage) {
        return { ...rest, is_reaction: true, reaction: node.reactionMessage.text || '',
                 target_id: (node.reactionMessage.key && node.reactionMessage.key.id) || null };
      }
      return rest;
    } catch (e) { return rest; }
  });
  // Prefer YOUR name for the chat over the sender's profile name (see bookNames).
  try {
    const book = await bookNames(rows.filter(x => !x.is_group).map(x => x.chat_jid));
    rows.forEach(x => { if (book[x.chat_jid]) x.chat_name = book[x.chat_jid]; });
  } catch (e) { log.warn('recent names: ' + e.message); }
  // Resolve, in ONE query, the text each reaction answers — a bare "👍" says nothing.
  const targets = [...new Set(rows.filter(x => x.target_id).map(x => x.target_id))];
  if (targets.length) {
    const tr = await q('SELECT wa_id, body, type FROM whatsapp_messages WHERE wa_id = ANY($1)', [targets]);
    const byId = {}; tr.rows.forEach(t => { byId[t.wa_id] = t; });
    rows.forEach(x => {
      if (!x.target_id) return;
      const t = byId[x.target_id];
      x.reaction_to = t ? (t.body || (/image/i.test(t.type || '') ? '📷 photo' : /video/i.test(t.type || '') ? '🎞 video' : '')) : '';
    });
  }
  ok(res, { messages: rows });
});
// ── Automation endpoints (dashboard calls the agent directly, CORS) ──
app.get('/automation/log', async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit) || 100, 500);
  const r = await q(`SELECT ts, rule_name, from_name, chat_jid, matched_text, action, mode, applied, note
                     FROM whatsapp_automation_log ORDER BY ts DESC LIMIT $1`, [lim]);
  ok(res, { log: r.rows });
});
app.post('/automation/test', async (req, res) => {
  try {
    const rule = (req.body || {}).rule; if (!rule) return bad(res, 'rule');
    const r = await q(`SELECT wa_id, chat_jid, sender_jid, sender_name, body
                       FROM whatsapp_messages WHERE from_me=false ORDER BY ts DESC LIMIT 80`);
    const matches = [];
    for (const m of r.rows) {
      const ctx = await buildCtx({ wa_id: m.wa_id, chat_jid: m.chat_jid,
        from_jid: m.sender_jid || m.chat_jid, from_name: m.sender_name, body: m.body || '' });
      if (ruleMatches(rule, ctx)) matches.push({ chat_jid: m.chat_jid, from_name: m.sender_name, body: (m.body || '').slice(0, 120) });
    }
    ok(res, { matches, scanned: r.rows.length });
  } catch (e) { bad(res, e.message, 500); }
});
// PREVIEW ONLY — evaluate recent inbound messages, write dry-run log rows, NEVER send/popup.
app.post('/automation/run-now', async (req, res) => {
  try {
    const lim = Math.min(parseInt((req.body || {}).limit) || 200, 500);
    const r = await q(`SELECT wa_id, chat_jid, sender_jid, sender_name, body
                       FROM whatsapp_messages WHERE from_me=false ORDER BY ts DESC LIMIT $1`, [lim]);
    const doneR = await q(`SELECT DISTINCT wa_id FROM whatsapp_automation_log WHERE wa_id IS NOT NULL`);
    const done = new Set(doneR.rows.map(x => x.wa_id));
    let logged = 0;
    for (const m of r.rows) {
      if (done.has(m.wa_id)) continue;
      const ctx = await buildCtx({ wa_id: m.wa_id, chat_jid: m.chat_jid,
        from_jid: m.sender_jid || m.chat_jid, from_name: m.sender_name, body: m.body || '' });
      if (await applyAutomation(ctx, false)) logged++;   // preview only; count real matches
    }
    ok(res, { scanned: r.rows.length, logged });
  } catch (e) { bad(res, e.message, 500); }
});
// Show a DEMO popup for a rule (a preview) — inserts one live popup log row so the
// reminders card shows it, letting the user SEE the popup without a real message.
app.post('/automation/test-popup', async (req, res) => {
  try {
    const rule = (req.body || {}).rule; if (!rule || !rule.popup) return bad(res, 'no_popup');
    await q(`INSERT INTO whatsapp_automation_log
             (rule_id,rule_name,wa_id,chat_jid,from_jid,from_name,matched_text,action,mode,applied,note,popup_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'popup','live',true,'test preview',$8)`,
      [rule.id || null, (rule.name || 'rule') + ' (test)', 'test_' + Date.now(),
       'preview@s.whatsapp.net', 'preview@s.whatsapp.net', 'Preview',
       // demo MESSAGE text — the rule's own popup sentence is rendered as the title
       // line by the reminders card, so putting it here too would show it twice
       'this is how a match popup looks',
       rule.popup.text ? String(rule.popup.text).slice(0, 300) : null]);
    ok(res, {});
  } catch (e) { bad(res, e.message, 500); }
});
app.post('/history', async (req, res) => {
  try { const { jid, count } = req.body || {}; if (!sock) return bad(res, 'not_connected', 409);
    const oldest = (await q(`SELECT wa_id, ts FROM whatsapp_messages WHERE chat_jid=$1 ORDER BY ts ASC LIMIT 1`, [jid])).rows[0];
    if (!oldest) return ok(res, { requested: false });
    await sock.fetchMessageHistory(Math.min(count || 50, 200), { remoteJid: jid, id: oldest.wa_id, fromMe: false }, Math.floor(new Date(oldest.ts).getTime() / 1000));
    ok(res, { requested: true });
  } catch (e) { bad(res, e.message, 500); }
});
// writes (P3 — behind the guard; wired now so the API is complete)
// Build the minimal WAMessage Baileys needs to quote a message we already cached.
// Resolved HERE from wa_id (never trusted from the browser) and only within the same chat.
async function quotedStub(jid, waId) {
  if (!waId) return null;
  const r = await q(`SELECT wa_id, chat_jid, sender_jid, from_me, body FROM whatsapp_messages
                     WHERE wa_id=$1 AND chat_jid=$2 LIMIT 1`, [waId, jid]);
  const m = r.rows[0]; if (!m) return null;
  const key = { remoteJid: m.chat_jid, id: m.wa_id, fromMe: !!m.from_me };
  if (String(m.chat_jid).endsWith('@g.us') && m.sender_jid) key.participant = m.sender_jid;
  return { key, message: { conversation: m.body || '' } };
}
app.post('/send', async (req, res) => {
  try { const { jid, text, force, quoted_id } = req.body || {}; if (!jid || !text) return bad(res, 'jid_and_text');
    const quoted = await quotedStub(jid, quoted_id);
    if (quoted_id && !quoted) return bad(res, 'quoted_not_found');
    await guardedSend(jid, text, !!force, quoted); ok(res, { quoted: !!quoted }); }
  catch (e) { bad(res, e.reason || e.message, e.reason === 'cap' || e.reason === 'rate' ? 429 : 400); }
});
// React to ONE message with an emoji (empty emoji = remove the reaction).
// The target key is rebuilt HERE from our own row — the browser sends only an id, never a key.
// ⚠ We must write our own row: sendMessage emits its event as upsertMessage(msg,'append')
// (Socket/messages-send.js), and the ingest only handles 'notify' — which is why guardedSend
// also inserts by hand. And it must NOT be status='sent': the hourly/daily caps count exactly
// that value, so a 👍 would silently spend the message budget. status='reacted' keeps them apart.
app.post('/react', async (req, res) => {
  try {
    const { jid, wa_id, emoji } = req.body || {};
    if (!jid || !wa_id) return bad(res, 'jid_and_wa_id');
    const text = (emoji == null) ? '' : String(emoji);
    const r = await q(`SELECT wa_id, chat_jid, sender_jid, from_me FROM whatsapp_messages
                       WHERE wa_id=$1 AND chat_jid=$2 LIMIT 1`, [wa_id, jid]);
    const m = r.rows[0];
    if (!m) return bad(res, 'not_found', 404);
    if (!sock || state.connection !== 'open') return bad(res, 'not_connected', 409);
    guardReact();
    const key = { remoteJid: m.chat_jid, id: m.wa_id, fromMe: !!m.from_me };
    if (String(m.chat_jid).endsWith('@g.us') && m.sender_jid) key.participant = m.sender_jid;
    const sent = await sock.sendMessage(jid, { react: { text, key } });
    // keep our own reaction so the chip survives a reload (see the note above)
    let node = null;
    try { node = Buffer.from(proto.Message.encode({ reactionMessage: { key, text } }).finish()); }
    catch (e) { log.warn('react encode: ' + e.message); }
    await q(`INSERT INTO whatsapp_messages (wa_id, chat_jid, sender_jid, from_me, direction, type, body, ts, status, media_proto)
             VALUES ($1,$2,$3,true,'out','reactionMessage','',now(),'reacted',$4)
             ON CONFLICT (wa_id, chat_jid) DO UPDATE SET media_proto=EXCLUDED.media_proto`,
      [sent.key.id, jid, state.me && state.me.jid, node]);
    log.info('react ' + (text || '(removed)') + ' -> ' + wa_id);
    ok(res, { emoji: text });
  } catch (e) {
    bad(res, e.reason || e.message, (e.reason === 'rate' || e.reason === 'cap') ? 429 : 400);
  }
});
app.post('/leave', async (req, res) => {
  try {
    const { jid } = req.body || {}; if (!jid || !jid.endsWith('@g.us')) return bad(res, 'group_jid');
    if (!sock || state.connection !== 'open') return bad(res, 'not_connected', 409);
    guardAction();
    await sock.groupLeave(jid);
    // VERIFY the leave actually took before removing the row (a silent no-op would
    // otherwise hide a group we're still in; a re-sync then resurrects it).
    await new Promise(r => setTimeout(r, 1500));
    let stillIn = false;
    try { const gs = await sock.groupFetchAllParticipating(); stillIn = !!gs[jid]; } catch (e) {}
    if (stillIn) { log.warn('leave did NOT take for ' + jid + ' — still a member'); return bad(res, 'leave_not_confirmed', 409); }
    await q(`DELETE FROM whatsapp_chats WHERE jid=$1`, [jid]);
    log.info('LEFT group ' + jid);
    ok(res, {});
  } catch (e) {
    if (e.reason === 'rate' || e.reason === 'cap') return bad(res, e.reason, 429);
    log.warn('leave error ' + (req.body && req.body.jid) + ': ' + e.message); bad(res, e.message, 500);
  }
});
app.post('/delete', async (req, res) => {
  try { const { jid, key } = req.body || {}; if (!jid || !key) return bad(res, 'jid_and_key');
    guardAction();
    await sock.sendMessage(jid, { delete: key }); ok(res, {}); }
  catch (e) {
    if (e.reason === 'rate' || e.reason === 'cap') return bad(res, e.reason, 429);
    bad(res, e.message, 500);
  }
});
app.post('/read', async (req, res) => {
  try { const { jid } = req.body || {}; await q(`UPDATE whatsapp_chats SET unread=0 WHERE jid=$1`, [jid]); ok(res, {}); }
  catch (e) { bad(res, e.message, 500); }
});
// Rename a chat with a local custom label (dashboard-only; NOT synced to WhatsApp).
// Empty/blank name clears it (reverts to the resolved name / "unknown"). Zero ban risk.
app.post('/chat/name', async (req, res) => {
  try {
    const { jid } = req.body || {}; if (!jid) return bad(res, 'jid');
    const nm = (req.body.name || '').trim().slice(0, 120) || null;
    const r = await q(`UPDATE whatsapp_chats SET custom_name=$2, updated_at=now() WHERE jid=$1`, [jid, nm]);
    if (!r.rowCount) return bad(res, 'no_such_chat', 404);
    // Return the freshly-RESOLVED display name (same chain as /chats) so the UI is
    // correct whether the label was set or cleared.
    const d = await q(`
      SELECT COALESCE(NULLIF(c.custom_name,''), NULLIF(c.name,''), NULLIF(ct.name,''), NULLIF(ct.notify,''),
        NULLIF((SELECT m.sender_name FROM whatsapp_messages m WHERE m.chat_jid=c.jid AND m.sender_name IS NOT NULL
                ORDER BY m.ts DESC NULLS LAST LIMIT 1),''),
        CASE WHEN c.jid LIKE '%@s.whatsapp.net' THEN split_part(c.jid,'@',1) END) AS disp
      FROM whatsapp_chats c LEFT JOIN whatsapp_contacts ct ON ct.jid=c.jid WHERE c.jid=$1`, [jid]);
    const disp = d.rows[0] ? d.rows[0].disp : null;
    ok(res, { name: disp, resolved: disp != null });
  } catch (e) { bad(res, e.message, 500); }
});
// Delete a DM conversation. Best-effort real WhatsApp delete-for-me (account-local)
// via chatModify; if that's unavailable/fails, fall back to a dashboard-only hide.
// Either way the DB rows go so the chat leaves the list. Groups use /leave instead.
app.post('/chat/delete', async (req, res) => {
  try {
    const { jid } = req.body || {}; if (!jid) return bad(res, 'jid');
    if (jid.endsWith('@g.us')) return bad(res, 'use_leave_for_groups', 400);
    guardAction();
    let removed = 'local';
    if (sock && state.connection === 'open') {
      try {
        const last = (await q(`SELECT wa_id, from_me, ts FROM whatsapp_messages
                               WHERE chat_jid=$1 ORDER BY ts DESC NULLS LAST LIMIT 1`, [jid])).rows[0];
        if (last && last.wa_id) {
          const key = { id: last.wa_id, remoteJid: jid, fromMe: !!last.from_me };
          const tsSec = last.ts ? Math.floor(new Date(last.ts).getTime() / 1000) : Math.floor(Date.now() / 1000);
          await sock.chatModify({ delete: true, lastMessages: [{ key, messageTimestamp: tsSec }] }, jid);
          removed = 'whatsapp';
        }
      } catch (e) { log.warn('chatModify delete failed for ' + jid + ': ' + e.message + ' — local hide only'); }
    }
    await q(`DELETE FROM whatsapp_messages WHERE chat_jid=$1`, [jid]);
    await q(`DELETE FROM whatsapp_chats WHERE jid=$1`, [jid]);
    log.info('chat deleted (' + removed + ') ' + jid);
    ok(res, { removed });
  } catch (e) {
    if (e.reason === 'rate' || e.reason === 'cap') return bad(res, e.reason, 429);
    bad(res, e.message, 500);
  }
});
app.post('/relink', async (req, res) => {
  try { await import('fs').then(fs => fs.promises.rm(AUTH, { recursive: true, force: true }).catch(()=>{}));
    state.connection = 'connecting'; if (sock) try { sock.end(); } catch (e) {}
    setTimeout(connect, 500); ok(res, {}); }
  catch (e) { bad(res, e.message, 500); }
});
app.get('/health', (req, res) => res.json({ ok: true, connection: state.connection }));

// ── boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadSettings();
  mqttConnect();
  app.listen(PORT, () => log.info('HTTP API on :' + PORT));
  await connect();
})();
