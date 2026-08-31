// WhatsApp agent (LXC 114) — Baileys personal-account bridge.
//   • one persistent Baileys socket (auto-reconnect, multi-file auth on disk)
//   • persists chats/contacts/messages to Postgres (dashboard reads from there)
//   • MQTT: publishes inbound -> mur/home/whatsapp/message ; subscribes mur/home/whatsapp/send
//   • Express HTTP API for the dashboard (read free; writes behind the send-guard)
// Ban-risk: read-primary; the send-guard enforces min-gap + hourly/daily caps + no-bulk
// + contact-only. Notifications default to self-chat (recipient:"self").
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode';
import express from 'express';
import mqtt from 'mqtt';
import pg from 'pg';
import path from 'path';
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
let settings = { min_gap_sec: 4, hourly_cap: 20, daily_cap: 100, contact_only: true };
let lastSendTs = 0;

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
const bodyOf = (m) => (m.message && (m.message.conversation
  || (m.message.extendedTextMessage && m.message.extendedTextMessage.text))) || '';
const typeOf = (m) => (m.message && Object.keys(m.message)[0]) || 'unknown';
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
  await q(`INSERT INTO whatsapp_messages (wa_id, chat_jid, sender_jid, sender_name, from_me, direction, type, body, ts, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (wa_id, chat_jid) DO UPDATE SET status=COALESCE(EXCLUDED.status, whatsapp_messages.status)`,
    [m.key.id, chat, sender, m.pushName || null, !!m.key.fromMe,
     direction || (m.key.fromMe ? 'out' : 'in'), typeOf(m), (body || '').slice(0, 8000), tsOf(m), null]);
  await upsertChat(chat, { last_ts: tsOf(m) });
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
async function guardedSend(jid, text, force) {
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
  const sent = await sock.sendMessage(jid, { text: String(text) });
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
      if (!m.key.fromMe) publishInbound(m);
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
app.get('/chats', async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit) || 500, 1000);
  const r = await q(`SELECT jid,name,is_group,last_ts,unread FROM whatsapp_chats ORDER BY last_ts DESC NULLS LAST LIMIT $1`, [lim]);
  ok(res, { chats: r.rows });
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
  const r = await q(`SELECT wa_id,chat_jid,sender_jid,sender_name,from_me,direction,type,body,ts,status
                     FROM whatsapp_messages WHERE chat_jid=$1 ORDER BY ts DESC NULLS LAST LIMIT $2`, [jid, lim]);
  ok(res, { messages: r.rows.reverse() });
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
app.post('/send', async (req, res) => {
  try { const { jid, text, force } = req.body || {}; if (!jid || !text) return bad(res, 'jid_and_text');
    await guardedSend(jid, text, !!force); ok(res, {}); }
  catch (e) { bad(res, e.reason || e.message, e.reason === 'cap' || e.reason === 'rate' ? 429 : 400); }
});
app.post('/leave', async (req, res) => {
  try {
    const { jid } = req.body || {}; if (!jid || !jid.endsWith('@g.us')) return bad(res, 'group_jid');
    if (!sock || state.connection !== 'open') return bad(res, 'not_connected', 409);
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
  } catch (e) { log.warn('leave error ' + (req.body && req.body.jid) + ': ' + e.message); bad(res, e.message, 500); }
});
app.post('/delete', async (req, res) => {
  try { const { jid, key } = req.body || {}; if (!jid || !key) return bad(res, 'jid_and_key');
    await sock.sendMessage(jid, { delete: key }); ok(res, {}); }
  catch (e) { bad(res, e.message, 500); }
});
app.post('/read', async (req, res) => {
  try { const { jid } = req.body || {}; await q(`UPDATE whatsapp_chats SET unread=0 WHERE jid=$1`, [jid]); ok(res, {}); }
  catch (e) { bad(res, e.message, 500); }
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
