# WHATSAPP — personal-account agent via **Baileys** (LXC 114)

**STATUS: P1 + P2 + P3 BUILT + LIVE (2026-08-31).** Reads + sends the user's REAL WhatsApp from an always-on
LXC; the Communication dashboard page + full "manage all chats" surface (browse/search/filter, conversation
read/send/delete, rename, live monitor) are live. P4 (notifications surface) pending. The old **Cloud-API**
plan is kept at the bottom as a separate no-risk option for a future *business* channel — it CANNOT touch
personal chats.

## Why Baileys (what the POC proved)
Goal = manage the user's **real** WhatsApp (all contacts/groups, read conversations, reply, delete, leave
groups). Tested three routes on the laptop:
- **Meta Cloud API** — business-number only, no personal chats. ✗
- **whatsapp-web.js** (Chromium) — broken against current WhatsApp Web (`Execution context was destroyed`
  at inject, every time; 5 attempts + source read). ✗
- **Baileys** (`@whiskeysockets/baileys`, no browser, WebSocket protocol) — **WORKS.** Live-verified:
  591 chats / 43 groups / 1,224 contacts / thousands of messages read; sent + deleted; left a group.

**Tradeoff (accepted):** Baileys links the user's **OWN number** → unofficial client = **real ban risk**.
Ban model: **reads are safe** (a linked device syncing is normal); **human-paced sends to known contacts =
low**; **bulk / strangers / fast cadence / spam reports = ban**. Design is read-primary + a hard send-guard;
notifications default to the user's **own self-chat** (zero-risk, reaches the phone anywhere).

## Architecture (LXC 114, `192.168.1.228`, MAC BC:24:11:9A:4F:A5, DHCP-reserved)
Isolated container like Email/110 (untrusted ingest), **but a Node service** (Baileys is Node-only) — the
first Node service on an LXC. Debian 12, Node 20, unprivileged, 2 GB / 8 GB.
- **`whatsapp-agent` service** (`/opt/whatsapp-agent/index.mjs`, systemd `whatsapp-agent.service`, port
  **8790**): one persistent Baileys socket (**auto-reconnect**, handles the 515 restart-after-pair);
  **multi-file auth on disk** (`.wa_auth/` — link once, survives restarts, verified reconnect-without-QR);
  Express HTTP API; MQTT client; writes all events to Postgres.
- **Data flow (Email→DB→API pattern):** Baileys events persist to Postgres (Baileys 7 has no in-memory
  store); the dashboard reads from Postgres.
  - `messaging-history.set` → upsert chats/contacts/messages (bulk history).
  - `messages.upsert` (notify) → upsert message; inbound (`!fromMe`) also `publish mur/home/whatsapp/message`.
  - `contacts.upsert` / `chats.upsert` keep the maps fresh; `creds.update` → saveCreds.
- **⚠ Baileys history caveat:** bulk-history GROUP messages often lack the per-sender field → old group
  messages attribute to the group jid; **live** messages carry the real sender (`key.participant` /
  `m.participant` — both checked). So a "messages-by-person" view is accurate for live, partial for history.

## Linking (headless LXC)
The agent serves a **same-origin live-QR page** at `http://192.168.1.228:8790/link` (an `<img>` re-fetching
`/qr` every 2 s — a static QR expires; this auto-refresh is the approach that worked). Open it, scan in
WhatsApp → Linked Devices. Session then persists. `/qr` also returns the QR as a data-URL for the dashboard.

## HTTP API (`:8790`, CORS-enabled so the dashboard can call it directly)
**Read (free, zero ban risk):** `GET /status` (connection/me/counts) · `GET /qr` · `GET /link` (HTML) ·
`GET /chats?q=&limit=&offset=&filter=` (P3 — resolved names, search, paging, filter all/dm/group/unknown/
renamed, `total`) · `GET /groups` · `GET /group/:jid` · `GET /contacts` · `GET /messages?jid=&limit=` ·
**`GET /recent?limit=`** (P3 — live inbound feed, empty system rows filtered) · `GET /settings` ·
`POST /history {jid,count}`.
**Write:** `POST /send {jid,text,force?}` (send-guard) · `POST /leave {jid}` · `POST /delete {jid,key}` ·
**`POST /chat/delete {jid}`** (P3 — DM delete-for-me or dashboard-hide) · **`POST /chat/name {jid,name}`** (P3
— rename label, DB-only) · `POST /read {jid}` · `POST /settings` (send-guard + del limits) · `POST /relink`.
`/leave` + `/delete` + `/chat/delete` also pass **`guardAction()`** (del min-gap + hourly cap → 429).

## Send-guard (`guardedSend`, ban-risk firewall) — config in `whatsapp_state.settings`
`min_gap_sec` (4) · `hourly_cap` (20) · `daily_cap` (100) · `contact_only` (true → refuse a jid not in
`whatsapp_chats`/`whatsapp_contacts` unless `force`) · **no bulk endpoint** (every send takes ONE jid).
⚠ **Caps count ONLY agent sends** (`status='sent'`), NOT the user's historical sends synced from the phone
(those are `direction='out'` with `status NULL`) — counting `direction='out'` wrongly tripped the cap on the
first real send (thousands of historical out-rows); fixed to `status='sent'`.
The limits are editable from the dashboard via **`GET/POST /settings`** (added P2) — GET returns the current
`settings`; POST clamps each field (`min_gap_sec` 0–3600, `hourly_cap` 1–1000, `daily_cap` 1–5000,
`contact_only` bool), updates the in-memory `settings` **and** `UPDATE whatsapp_state SET settings=…`, and
returns the clamped result. (The dead `/group/:jid/remove-me` endpoint — owner-sole-member groups return
"not-allowed" — was replaced by `/settings`.)

## Groups view + @lid resolution (P2)
`GET /groups` = `groupFetchAllParticipating()` → each chat's `owner_jid` + `participant_count` (upserted into
`whatsapp_chats`, migration `003_group_meta.sql`). `GET /group/:jid` returns the full participant list with
names + admin roles. **WhatsApp anonymises group members as `@lid`** (e.g. `1327…@lid`); the agent resolves
each to a phone-jid via `sock.signalRepository.lidMapping.getPNForLID(lid)` **after stripping the `:device`
suffix** (`.replace(/:\d+@/, '@')`) so the contact-name lookup matches (7/7 members resolved live).
**Owner-sole-member "announcement" groups (e.g. Smary) can't be left/deleted** — WhatsApp returns
"not-allowed" for the owner removing self; `/leave` therefore **verifies the leave actually took** (re-fetches
participating groups after `groupLeave`, 409 `leave_not_confirmed` if still in) **before** deleting the DB row,
so a failed leave never silently drops the group from the list.

## MQTT (broker LXC 107; user `whatsapp_agent`, ACL `readwrite mur/home/whatsapp/#`)
- **Inbound** `mur/home/whatsapp/message` (QoS 1): `{chat_jid,is_group,group_name,from_jid,from_name,text,
  type,wa_id,ts}` → `rule_engine.on_mqtt_event` synthetic **`device_id='whatsapp'`** (rule_engine.py, next to
  the email branch; subscribe list gained `('mur/home/whatsapp/message',1)`). Rules use `triggers=['whatsapp']`.
- **Outbound** `mur/home/whatsapp/send`: `{recipient,text}` (`recipient='self'` → the agent resolves
  `sock.user.id`) → send-guard → send. `rule_engine` granted `read …/message` + `write …/send`.

## DB (LXC 102, `WHATSAPP/migrations/`)
`whatsapp_chats` · `whatsapp_messages` (metadata + text cache, **180 d**) · `whatsapp_contacts` ·
`whatsapp_state` (singleton: connection + settings, forever). `002_agent_row.sql` = `agents` row
(`data_table/settings_table NULL`, like email — a service cache, not a decision loop). `003_group_meta.sql` =
`whatsapp_chats.owner_jid`/`participant_count`. **`004_custom_name.sql` = `whatsapp_chats.custom_name`** (P3
rename label; own column so the sync never clobbers it). Registered in Health DB-Volumes + retention_policies.

## Integration wired in P1
- **rule_engine** (LXC 105) subscribes + ingests → `device_id='whatsapp'` (restarted).
- **Orchestrator SSH key** (LXC 105 root) authorized on 114 (sshd installed) → no `service_ssh_failed`.
- **Health page**: `server.js` tcpCheck + `r.lxc114`, `health.html` cell + `js/health.js` → **LXC 114 green**.
- **Off-site backup**: 114 added to `scripts/guests-cloud-backup.sh` GUESTS (weekly Drive).
- **UPS auto-recovery**: 114 in phase 2 of PVE `doshutdown_recover` (QNAP-independent — no mount).
- **UPS shutdown propagation**: 114 in `PHASE_A_CLIENTS` of PVE `/etc/apcupsd/doshutdown` (graceful stop on
  power loss). ⚠ noticed **113/kitchen is missing from both** the shutdown + recovery lists — pre-existing gap.
- **On-site PVE vzdump**: storage `QNAP_WHATSAPP_Backup` (NFS `10.0.0.1:/PBS_Data/WHATSAPP_Data`) + a per-guest
  vzdump job (daily **05:30**, keep-daily=4), mirroring kitchen/113.

## Deploy
- Service: `cat WHATSAPP/agent/index.mjs | ssh root@<pve> "pct exec 114 -- bash -c 'cat > /opt/whatsapp-agent/index.mjs && systemctl restart whatsapp-agent'"`. Env `/etc/whatsapp-agent.env` (MQTT + DB creds + PORT).
- rule_engine: `scp` to `/opt/main-agent/project/RULES/rule_engine.py` on LXC 105 + `systemctl restart rule-engine`.
- Dashboard changes: `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`.

## P2 — Communication dashboard (BUILT 2026-08-31)
- **`email.html` → `communication.html`** (old page `git rm`'d; sidebar re-pointed across **22 pages**, label
  Email→**Communication**, `.active` preserved per page). Title/h1 → Communication.
- **Top-level tab bar** `[📧 Email][💬 WhatsApp][⚙ Settings]` driven by inline **`commTab(name, btn)`** showing
  one of three `.comm-panel`s (`#comm-email` / `#comm-whatsapp` / `#comm-settings`). `.comm-tab` is its **own
  class** — email.js's `emShowTab` clears every `.tab-btn`, so a shared class would let it steal the active
  state; the separate class keeps the top bar independent. `commRefresh()` routes ↺ to whichever panel is open.
- **Email panel** = the untouched Inbox + Automation `emShowTab` sub-tabs; the inner **🔧 Settings button was
  removed** and its `#tab-settings` content moved into the shared Settings panel.
- **WhatsApp panel** (`js/whatsapp.js`, **read-only**, calls LXC 114 directly `WA_API='http://192.168.1.228:8790'`)
  = **all groups + owner + participants**: a searchable group list (name · owner · participant count) → click
  opens the participant list (names + admin/owner badges, @lid-resolved) + a per-row 🗑 **leave** (strong
  confirm → guarded `/leave`). `waOnShow` loads once on first tab open.
- **Shared ⚙ Settings panel** = **📧 Email Settings** card (moved: spam→Trash-after-N-days, `esLoad`/`esSave`
  already exposed by email.js) **+ 💬 WhatsApp — Safety & Send Limits** card: a red ban-risk banner + editable
  send-guard inputs (min-gap / hourly / daily / contact-only) wired to the agent's `/settings`
  (`waSettingsLoad`/`waSettingsSave`, reflecting the agent's clamped values back) **+ a 🟢/🔴 ban-risk table**
  (`.wa-risk`: 🟢 Safe—read · 🟢 Low risk—write · 🔴 Bans the number). `commTab('settings')` calls both
  `esLoad()` + `waSettingsLoad()`. Files: `js/whatsapp.js?v=3`.

## P3 — "manage all chats" + write UI + live monitor (BUILT 2026-08-31)
A full chat-management surface on the WhatsApp panel (`js/whatsapp.js`, `?v=13`). **All read-only pieces are
zero ban risk; every write goes through a guard.**
- **Chats card** — browse EVERY chat (589 rows: ~410 after filtering). `GET /chats?q=&limit=&offset=&filter=`:
  name resolved via a COALESCE chain **`custom_name → chat.name → contact.name → contact.notify → latest
  message pushName → number(@s.whatsapp.net) → raw @lid`** (a lateral subquery for the pushName fallback);
  drops `@broadcast` + **empty stubs** (`last_ts IS NULL AND no messages`); `q` ILIKE-searches name/notify/
  pushName/jid; **`count(*) OVER()`** = search-aware total; recent-first, paged (default 40 + "Load more").
  **Filter dropdown**: All · **People** (`filter=dm`, badge 👤) · Groups (👥) · **Unknown** (`disp IS NULL` —
  the anonymized @lid chats) · **Renamed** (`custom_name IS NOT NULL`). Rows show name · badge · unread · time.
- **Conversation window** (modal, stays until Cancel) — `openChat(idx)` delegates to **`openChatObj(c)`**;
  reads via `GET /messages?jid=` (in/out bubbles, sender in groups, `msgBody` media placeholders; a zero-cached
  chat shows "no messages cached yet — you can still send"); **Send** = `POST /send` (send-guard, shows the
  block reason); per-own-message **🗑 delete** = `POST /delete` (key rebuilt `{id:wa_id, remoteJid, fromMe,
  participant:sender_jid}`); header **Delete** (DM) / **Leave** (group) + **✏️ Rename**.
- **Rename ANY chat** — dashboard-only label. Column **`whatsapp_chats.custom_name`** (migration
  `004_custom_name.sql`; in its OWN column so the Baileys sync — which only writes `name` — never clobbers it;
  first in the resolution chain). `POST /chat/name {jid,name}` (blank clears → reverts to the resolved name);
  the endpoint returns the freshly-RESOLVED display name so the UI is right whether set or cleared. Zero WhatsApp
  traffic → zero ban risk.
- **Delete a DM chat** — `POST /chat/delete {jid}`: best-effort real delete-for-me via `sock.chatModify({delete})`
  (VERIFY-ON-BUILD — falls back to a **dashboard-only hide** if chatModify errors), then removes the local
  `whatsapp_messages`/`whatsapp_chats` rows so it leaves the list. Groups reject → use `/leave`.
- **Destructive-action throttle** (`guardAction()`, in-memory sliding hour) on `/leave` + `/delete` +
  `/chat/delete` — `del_min_gap_sec` (4) + `del_hourly_cap` (30), editable in the Settings card; returns 429
  `rate`/`cap`. Separate from the send-guard (which only covers `/send`). Closes the "rapid mass-delete = ban
  pattern" gap the user flagged.
- **🔔 Live monitor** (top of the panel, above Chats/Groups) — `GET /recent?limit=15` = latest **inbound**
  messages (`from_me=false`), newest first, chat name resolved (same chain), **`AND (body<>'' OR type ~*
  'image|video|audio|ptt|sticker|document|location')`** to drop empty `senderKeyDistributionMessage`/system
  rows. `renderRecent` → a 3-column grid (time · message · name); rows within ~30 s get a "fresh" highlight;
  click a row → `openChatJid` opens that conversation. **Self-gating poll** (`setInterval` 5 s, started once on
  `onShow`) — no-ops unless `#comm-whatsapp` is the visible tab AND `document.visibilityState==='visible'`, so
  it stops when you leave the tab / background the window (no wasted traffic). Read-only.
- **Layout/UX polish**: Chats + Groups side-by-side (`#wa-layout` grid `1.4fr 1fr`, stacks < 820px); **Groups
  collapsed by default on every tab entry** (`_groupsHidden` reset in `onShow` — NOT persisted, so it can't
  reopen itself between pages); the old top "Filter groups…" box removed (redundant with the Chats search +
  the Groups filter); ↺ button relabeled "Refresh" (reloads status+groups+chats+monitor).

## Pending phases
- **P4** — Notifications `surfaces.whatsapp` (`_build_whatsapp` mirror of `_build_panel_alert`; rule_engine
  `protocol=='whatsapp'` branch → self-chat notify-anywhere); incoming automation `RULES/rules/whatsapp_*.py`.

## Related
[EMAIL](../EMAIL/CLAUDE.md) (the isolation pattern this mirrors) · [NOTIFICATIONS](../NOTIFICATIONS/CLAUDE.md)
(the surface P4 plugs into) · [[project_agent_whatsapp]] · [[incident_dhcp_pool_ip_collision]].

---
## ALTERNATIVE (not built) — Meta WhatsApp Cloud API (no ban risk, business-number only)
The official Cloud API is **no-ban** but **cannot access personal chats/groups** — only a dedicated business
number's conversations, template-gated proactive sends, and needs a Cloudflare Tunnel + Meta Business
verification. Kept as an option for a future *business* channel; NOT the "manage my real WhatsApp" build.
See the git history of this file for the full Cloud-API plan.
