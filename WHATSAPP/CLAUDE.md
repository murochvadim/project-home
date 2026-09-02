# WHATSAPP — personal-account agent via **Baileys** (LXC 114)

**STATUS: P1 + P2 + P3 + AUTOMATION BUILT + LIVE (2026-08-31).** Reads + sends the user's REAL WhatsApp from an
always-on LXC; the Communication dashboard page + full "manage all chats" surface (browse/search/filter,
conversation read/send/delete, rename, live monitor) + an **Automation tab** (rules → auto-reply and/or a
top-right blue popup card, via the reminders system) are live. P4 (notifications surface) pending. The old
**Cloud-API** plan is kept at the bottom as a separate no-risk option for a future *business* channel — it
CANNOT touch personal chats.

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
  click a row → **`waOpenRecent(i)`** → `openChatObj` opens that conversation (where you can reply).
  ⚠ **This was DEAD until 2026-09-01:** the row's `onclick` embedded the chat name via
  `JSON.stringify(name)`, whose raw double quotes **closed the double-quoted attribute** — the browser
  parsed `waOpenChatJid('<jid>',` as the handler (silent syntax error) plus `Maya` / `Muroch",false)"`
  as stray attributes, so every NAMED row did nothing (a nameless chat, `JSON.stringify(null)` →
  unquoted, was the only one that worked). Rows now carry only their **index** into a `_recent` array —
  the pattern the Chats list already used (`waOpenChat(i)`). **Never put data in an HTML attribute**;
- **Any message in the thread can be answered (2026-09-01).** Clicking a **text bubble** arms the reply
  to it and marks it in place (`.wa-bubble.armed` — green left bar + tint), so you can answer an old
  message, not just the newest. A **media bubble keeps click = open the file** (otherwise a photo could
  never be viewed), so those are answered via their green **↩**, which carries `event.stopPropagation()`.
  The mark is toggled on the live node by `armHighlight(i)` — **never re-render to highlight**, it would
  scroll the thread back to the bottom and lose your place.
- **↩ Reply to ONE message (quoted reply, 2026-09-01).** A send used to be a plain new message in the
  chat. Now clicking a monitor row **arms a reply to THAT message** (and every bubble in a thread has a
  faint `↩`): a green bar above the input shows `↩ <who>: <preview>` with `✕` to cancel, and the send
  attaches it so WhatsApp renders the quoted bubble. Wiring: `/recent` now also returns **`wa_id`** (it
  did not — without it a monitor click could not identify the message and the reply silently armed
  nothing); `POST /send` takes **`quoted_id`** and resolves it in **`quotedStub()`** server-side —
  `SELECT … WHERE wa_id=$1 AND chat_jid=$2`, so the browser never supplies quoted content and a quote
  can't cross chats; `guardedSend(jid, text, force, quoted)` passes it as Baileys'
  `sendMessage(jid, {text}, {quoted})` (`MiscMessageGenerationOptions.quoted`, Types/Message.d.ts:246).
  An unresolvable `quoted_id` is refused **before** `guardedSend` (`quoted_not_found`) so a bad quote can
  never turn into a send. The reply clears after a successful send. **Ban-risk unchanged** — same single
  guarded send, no extra traffic. UI: `#wa-reply-bar` + `.wa-brep` in `communication.html`,
  `_replyTo`/`replyBarRender`/`replyTo(i)`/`cancelReply` in `js/whatsapp.js?v=43`.
  if you must, escape it like `js/medical.js:420` (`JSON.stringify(x).replace(/"/g,'&quot;')`). **Self-gating poll** (`setInterval` 5 s, started once on
  `onShow`) — no-ops unless `#comm-whatsapp` is the visible tab AND `document.visibilityState==='visible'`, so
  it stops when you leave the tab / background the window (no wasted traffic). Read-only.
- **Layout/UX polish**: Chats + Groups side-by-side (`#wa-layout` grid `1.4fr 1fr`, stacks < 820px); **Groups
  collapsed by default on every tab entry** (`_groupsHidden` reset in `onShow` — NOT persisted, so it can't
  reopen itself between pages); the old top "Filter groups…" box removed (redundant with the Chats search +
  the Groups filter); ↺ button relabeled "Refresh" (reloads status+groups+chats+monitor).

## Automation — rules → auto-reply and/or popup (BUILT 2026-08-31, mirror of the Email agent)
An **Automation** sub-tab on the WhatsApp panel (`[💬 Chats][⚙ Automation]` inner tabs via `waSubTab`). Rules
in **`dashboard_settings.whatsapp.rules`** (generic dashboard endpoint — no server change), evaluated **in the
agent** on each inbound message (`applyAutomation(ctx,true)` from the `!m.key.fromMe` branch), 30 s TTL cache.
- **Rule shape:** `{id,name,active,mode:'dryrun'|'live', match:{from:[...],contains:[...],scope:'all'|'people'|
  'groups'}, reply:{text}|null, popup:{text}|null}`. **First matching ACTIVE rule wins** (like email). `from`/
  `contains` are case-insensitive OR-match substrings; `scope` filters on `is_group`.
- **⚠ Matching in the @lid era — IDENTITY-based since 2026-09-01 (was display-name, and it was broken).**
  WhatsApp now delivers many messages from **anonymized `@lid` ids that carry NEITHER the phone number NOR your
  saved contact name** — only the sender's **profile name (pushName)**. The old matcher hayed
  `chat_jid + from_jid + from_name`, so a `from` picked from the dropdown (the chat's *display* name, which comes
  mostly from your address book) **could never match**: measured on live data, **300 of the 302** real-name DM
  options the picker offered were unmatchable. A rule only fired if the saved name happened to equal the pushName.
  Now:
  - **`identityIds(jid)`** returns every id that is the same person — the bare id plus its **lid↔phone
    counterpart**. ⚠ **LOCAL reads only:** it reads the Baileys signal key store directly
    (`authKeys.get('lid-mapping', ['<lid>_reverse'])` / `['<pn>']`, the same store Baileys reads, backed by
    `.wa_auth/lid-mapping-*.json`). **Never call `getLIDForPN`** — on a cache miss it does a **USync query to
    WhatsApp's servers**, and bulk contact lookups from an unofficial client are a ban risk. `getPNForLID` is
    local-only and safe. Verified: **104 of 105** `@lid` DM chats resolve locally; 10-min LRU.
  - **`identityNames(ids, chatIds)`** collects every name the person is known by — pushName + the chat's
    `custom_name`/`name` + `whatsapp_contacts.name`/`notify` **for either identity** — so an address-book name
    ("Mayicha Muroch") now matches a message that arrives under her `@lid` profile name ("Maya Muroch").
  - **`buildCtx()`** is the single context builder for all three evaluation paths (live inbound,
    `/automation/run-now`, `/automation/test`) so they can't drift.
  - **`ruleMatches`**: a `from` entry that is an **id** (≥5 digits after stripping `@domain`/`:device`) matches
    `ctx.ids` **EXACTLY**; anything else is a case-insensitive substring over `ctx.names`. An "id" is
    `^\d{5,}(-\d{5,})?$` after stripping `@domain`/`:device` — the optional `-<ts>` half is the **legacy
    group jid** form (`972542993344-1594042272@g.us`); without it 7 of the 21 groups the picker offers were
    unmatchable (audit 2026-09-01). ⚠ Exact-match is
    load-bearing: with the old `includes()`, a DM id fired on the **legacy group jid that embeds it**
    (`972545259144` ⊂ `972545259144-1402322229@g.us`) — 358 such collisions in live data. Regression-tested:
    that rule now returns **0** matches while 35 of the group's messages were in the scan window.
- **From-picker = `GET /automation/senders`** (not `/chats`): **one entry per PERSON** (the two rows of a
  migrated contact — `@lid` + phone — merged by identity), only chats that have actually **received** an inbound
  (so nothing offered is unmatchable), label = the best known name, **value = the identity id**. The rule row
  renders the resolved sender **name under the From field in big bold green** (15 px, `#166534`) — the stored
  value is an unreadable id, so WHO the rule listens to must be legible at a glance. ⚠ `/chats` is deliberately
  **untouched** — merging there would hide a migrated contact's old phone-chat history in the Chats card.
- **reply (live):** `guardedSend(chat_jid, text)` — ban-guarded (min-gap/caps/contact-only); dry-run logs only.
  Flagged in the UI "⚠ auto-sends a real WhatsApp reply from your number".
- **popup text = an optional TITLE line (2026-09-01).** It used to be **dead** — `applyAutomation` only read
  `!!rule.popup`, and the card's label is built from the log row (`💬 <chat>: <matched_text>`), so whatever you
  typed was discarded. Now `routes-reminders.js` looks the rule up in `dashboard_settings.whatsapp.rules` by the
  log row's own **`popup_text`** column (migration `006_popup_text.sql`, written at fire time by `logAuto` and by
  `/automation/test-popup`) — falling back to a lookup in `dashboard_settings.whatsapp.rules` by `rule_id` for
  rows written before the column existed — and returns it as **`item.title`**, which `reminders-badge.js` renders **bold above the
  message**; no sentence → message only. Read live, so editing the sentence updates rows already on screen.
  `/automation/test-popup` stores a demo MESSAGE (not the sentence) so the preview doesn't show it twice.
- **popup (live):** delivered through the **reminders card** (top-right, same place as medical/journal) — NOT
  a notification_events/notify-toast popup. The live log row (mode='live', action popup/both) IS the source:
  **`/api/reminders` (`routes-reminders.js`) surfaces recent live popup rows from `whatsapp_automation_log`** as
  `kind:'whatsapp'` items (chat name resolved like /chats, rkey `whatsapp:<id>` for Clear/Delay), and
  **`reminders-badge.js` renders them in a dedicated BLUE card** (`renderWhatsApp`, stacked below the red
  reminders badge; the split at ~:243 routes `kind==='whatsapp'`). Controlled ONLY by the rules (like meds) —
  no separate on/off in reminders settings; a WhatsApp popup shows only when a rule is **active + LIVE + popup**
  AND the reminder badge is enabled AND the page is in the reminders page list (`communication` added). The
  Automation tab shows a live 🟢/🔴 "Show Popup enabled/disabled in Reminders" hint per rule.
- **Endpoints** (agent, CORS, dashboard calls directly): `GET /automation/log` · `POST /automation/test {rule}`
  (dry-run vs last 80 inbound, no writes) · **`GET /automation/senders?scope=`** (From-picker source, see above) · **`POST /automation/run-now`** (PREVIEW ONLY — logs dry-run rows,
  **never sends replies or fires popups**; deduped on `wa_id`) · `POST /automation/test-popup {rule}` (inserts
  one demo live-popup log row so the reminders card shows a preview — the ▶ Test button uses it). Table
  **`whatsapp_automation_log`** (migration `005_automation.sql`, 90 d) + Health DB-Volumes. The Activity-log
  card has a **show-last 10 / 20 / 50** selector (default 10, remembered per browser in `localStorage`
  `wa.logLimit`). ⚠ There is deliberately **NO Clear button** — one was built and then removed by request:
  the 90-day retention policy owns cleanup, so nothing in the UI deletes audit rows. `js/whatsapp.js?v=38` + `js/reminders-badge.js?v=15`.

## Media — open photos / videos in a chat (BUILT 2026-09-01)
A photo used to render as the text `📷 photo` and could not be opened: `upsertMessage` stored only
`wa_id/chat_jid/sender/type/body/ts`, and WhatsApp media is **encrypted** — without the message node
(mediaKey / directPath / fileEncSha256 / mimetype) the bytes are unreachable forever.
- **`whatsapp_messages.media_proto BYTEA`** (migration `007_media.sql`) = `proto.Message.encode(m.message)`
  for media messages. **Protobuf, NOT JSON** — every binary field is a `Uint8Array` that
  `JSON.stringify` mangles (runtime-verified: encode→decode keeps `mediaKey` + `jpegThumbnail`).
  ~1 KB/row. `ON CONFLICT` fills it only when still NULL.
- **`bodyOf` now takes media CAPTIONS** (`imageMessage/videoMessage/documentMessage.caption`) — they
  were silently dropped (all 2,800 pre-existing image rows have an empty body).
- ⚠ **Never decide "is this media" from the `type` column** — `typeOf` is just `Object.keys(m.message)[0]`,
  so real messages get labelled `messageContextInfo` (214 rows) / `senderKeyDistributionMessage`.
  `mediaNodeOf()` decodes the stored node instead; `/messages` returns `has_media`/`media_kind`/`mime`/
  `has_thumb`/`file_name` from it.
- **`GET /media/:wa_id/thumb`** → the `jpegThumbnail` that CAME WITH the message: a real preview for
  **zero** WhatsApp traffic (measured 460 bytes). 404 when the node has none (audio/document).
- **`GET /media/:wa_id/full`** → `downloadMediaMessage(node,'buffer',{},{reuploadRequest:
  sock.updateMediaMessage, logger})`, served with the node's mimetype. ⚠ **LXC 114 root is 8 GB**, so
  the cache at `/opt/whatsapp-agent/.media_cache/` is bounded: files >25 MB are streamed but not
  cached, and the dir is pruned oldest-first past 300 MB.
- **The 🔔 monitor feed shows previews too** (`/recent` carries the same decoded flags): an incoming
  photo renders as a 30 px thumbnail + its caption instead of the text `📷 photo`. ⚠ The feed keeps a row when it has TEXT **or a stored media key**
  or a media-looking type — `media_proto IS NOT NULL` had to be added 2026-09-01 because a real photo
  can arrive labelled `senderKeyDistributionMessage` and, with no caption, the type test alone hid it
  (live case: רינה רצון's photo in "קציר 15", 17:33). `messageContextInfo` / key-rotation rows are still
  dropped — that is the noise the filter is for. **Reactions ARE shown** (2026-09-02): the emoji and
  the message it answers live only inside the node, so `upsertMessage` now stores the node for
  `reactionMessage` too (same `media_proto` column) — which also makes them pass the filter above —
  and `/recent` returns `is_reaction` / `reaction` / `reaction_to`, the last resolved for all rows in
  ONE extra query. The feed renders `👍 → <the message it answers>`, because a bare 👍 says nothing.
  ⚠ Only reactions arriving AFTER 2026-09-02 — older rows have no stored node. Feed depth is
  **30 rows** (`/recent?limit=30`, server cap 50) in a 385 px window (~5 rows more than the old 220 px). ⚠ The feed is
  **incoming-only** (`WHERE m.from_me = false`), so a photo you send YOURSELF never appears there —
  it is in the chat, not the feed. That is not a bug; it is what the feed means.
- **UI** (`js/whatsapp.js?v=46`): thumbnail + caption in the bubble (▶ badge on video), click → a
  lightbox (`#wa-media-modal`) with `<img>` / `<video controls>` / `<audio controls>` / download link,
  all hitting `…/full` — so the real file is fetched **only on click**, one at a time, like the real
  client. Ban-risk unchanged; viewing never sends.
- ⚠ **Only messages received AFTER this deploy.** The 2,800 images / 337 videos already in history have
  no stored node and can never be opened. `sock.fetchMessageHistory(count, key, ts)` exists
  (`Socket/messages-recv.d.ts:11`) and could back-fill, but it drags thousands of old messages through
  the personal number — **deliberately not done**; possible later as a small opt-in per-chat button.
- Verified live: 3 photos ingested with `media_proto` (1020-1202 B) + caption "טסט"; `/thumb` = 460 B
  JPEG; `/full` = 97,770 B JPEG, byte-identical on the cached second call.

### Display hygiene (2026-09-02 audit)
Two things a contract-level check could not catch — both were visible on screen:
- **Chat names via the OTHER identity.** A DM delivered as an anonymized `@lid` has no contact row of
  its own, so the name chain fell through to the SENDER'S OWN profile name — which can be junk (live:
  Alon Muroch's chat displayed as **"."**, because that is literally his profile name). `bookNames()`
  now resolves the lid↔phone counterpart from the LOCAL key store and prefers **your** address-book
  name; applied in `/recent` and `/chats`. After it: 0 of 200 chats unnamed (22 legitimately show a
  phone number — people not in your contacts).
- **Protocol records were rendered as messages.** A thread showed literal rows reading
  `(messageContextInfo)`, `(senderKeyDistributionMessage)`, `(protocolMessage)` — 18 in one group
  thread of 200. `renderMessages` now drops those (and reactions it cannot render, i.e. any stored
  before 2026-09-02) BEFORE assigning `_msgs`, so the reply/media indices stay aligned.
⚠ Lesson for future audits: "endpoint 200 + flag present" proves nothing about what the user sees.
Render the real payload through the real function and read the output.

### 💾 Save a chat photo/video into the Daily Journal (BUILT 2026-09-02)
The media lightbox (journal-styled: `rgba(0,0,0,.85)`, `92vw x 88vh`, white ✕ top-right) carries a
**💾 Save to Journal** button. One click, no questions:
- **day** = the message time in the journal's timezone — `activeTzFor('daily_journal')`, so Travel mode
  applies exactly as it does to the journal itself (⚠ it is **sync over a preloaded cache**, so the
  handler `await`s `loadTravelSettings()` first, else it silently falls back to Asia/Jerusalem);
- **slot** = the configured slot nearest that time (בוקר 08:00 · יום 14:00 · ערב 21:00 → 16:24 = יום),
  read live from `dashboard_settings.journal`;
- bytes = `GET <agent>/media/<wa_id>/full` → `Blob` → `File` named
  `<YYYY-Month-DD>_<HHMM>_wa_<wa_id><ext>`; ext comes from the message **mimetype** because the media
  agent rejects unknown extensions. The name is derived from `wa_id`, so re-saving overwrites its own
  file, and the link row is checked first — a second Save reports "already in the journal".
- then the journal's own **📸 Add details** prompt (Event / Year / Location / People, Skip allowed) →
  `PATCH :8767/api/media/library`.
**Shared code:** upload + prompt + metadata PATCH now live in **`js/journal-media.js`**, used by BOTH
`privacy.js` (the journal) and `whatsapp.js` — one implementation, so the two pages cannot drift into
different folders or questions. The prompt reuses `#pvj-media-meta` on Privacy and **builds the same
overlay + injects its CSS** on Communication (those classes live inside `privacy.html`, not a shared
stylesheet). `communication.html` also loads `travel-tz.js`. Verified end-to-end on a real photo:
file on the NAS, `journal_media` row with the **message's** day + the right slot, library row indexed.

## Reactions — answer a message with an emoji (BUILT 2026-09-02)

Tap the **😊** on any bubble → a one-row picker (**👍 ❤️ 😂 😮 😢 🙏** + **✕** to remove) attaches the
emoji to *that* message instead of sending a new one. Baileys: `sock.sendMessage(jid, { react: { text, key } })`
(`AnyRegularMessageContent.react`); an **empty `text` removes** the reaction (`Utils/messages.js` — it also
auto-fills `senderTimestampMs`, so we don't).

- **`POST /react` `{jid, wa_id, emoji}`** — the browser sends only an **id**; the message `key`
  (`remoteJid`/`id`/`fromMe`/`participant`) is rebuilt server-side from our own row, exactly like `quotedStub()`.
- ⚠ **The endpoint writes its own row.** `sendMessage` emits its event as `upsertMessage(msg, 'append')`
  (`Socket/messages-send.js`) and the ingest returns early on `type !== 'notify'` — the same reason
  `guardedSend` inserts by hand. Without this the chip vanishes on reload.
- ⚠ **That row is `status='reacted'`, never `'sent'`.** The hourly/daily send caps count exactly
  `status='sent'`, so writing it as a send would silently spend the message budget on a 👍. Verified live:
  4 reactions → `sends_last_10min = 0`.
- **Own lighter guard `guardReact()`** (same in-memory sliding-hour shape as `guardAction`):
  `react_min_gap_sec` (default 2) + `react_hourly_cap` (default 60), in `whatsapp_state.settings`,
  editable on the shared **Settings** tab. The 4 s message gap would make tapping an emoji feel broken, and a
  reaction can only ever land on a message in a chat you are already in — it cannot reach a stranger, which is
  the pattern that actually gets numbers banned. ⚠ `POST /settings` **clamps an explicit key list** — a new key
  must be added there or it is silently dropped.
- **Rendering:** reactions are not messages, so `/messages` returns them **grouped under the message they
  answer** (`reactions[target_id] = [{emoji, from_me, by}]`) and the thread keeps filtering the rows themselves
  out. Chips sit under the bubble; the same emoji from several people collapses with a count; yours is tinted
  green. Repaint is **per bubble** (`reactRedraw`) — a full re-render would scroll the thread back to the bottom.
- ⚠ **Only the LATEST reaction per (message, author) counts.** Every change/removal is its own row with its own
  id; collecting them all left a **removed 👍 still on screen** (caught in test, fixed).
- ⚠ **A reaction must never trigger automation.** Its body is empty, so a rule matching only on the SENDER
  would fire a **real auto-reply because someone tapped 👍**. `messages.upsert` now skips `reactionMessage`
  for both `publishInbound` and `applyAutomation` (it is still stored, for the chip).
- ⚠ In the 🔔 monitor an incoming reaction passes the `media_proto IS NOT NULL` filter, so `/recent`
  **labels** it `reacted <emoji>` / `removed a reaction` — otherwise it rendered as a blank row.

**No reaction can be sent without a deliberate click** (audited 2026-09-02). The whole project contains
exactly ONE caller of `/react` (`doReact`) and ONE `sendMessage({react})` (inside the endpoint). `doReact`
is reachable only from the picker's own click handler, and only for a target carrying `data-e`; the picker
opens only from the bubble's 😊. No timer, retry or open-chat path touches it — the 5 s interval refreshes
only the monitor feed, and the thread re-renders solely on open / send / delete, so a picker can never end up
pointing at a different message. **No automation rule can react** either: rules only reply with text or pop up.

**Rule replies obey the Settings limits.** `applyAutomation` calls `guardedSend(jid, text)` with **no `force`**,
so `min_gap_sec` + `hourly_cap` + `daily_cap` + `contact_only` all apply, and a blocked reply is logged with the
reason rather than retried. (`force` — used only by an explicit `/send`/MQTT request — relaxes **contact_only
alone**; the rate and caps are unconditional.) A rule also only sends when it is set to **live**; otherwise it
logs "would reply". Replies are `status='sent'`, so they count against the same caps as manual sends.
`contact_only` is not re-checked for reactions because it cannot fail there: `/react` requires a stored message,
and storing one always upserts its chat — so the chat is known by construction.

Verified 2026-09-02 on the **self-chat** (a note to yourself — reaches nobody else): bogus `wa_id` → `not_found`
with nothing sent; two back-to-back calls → second `429 rate`; apply → chip returned by `/messages`; remove →
chips empty; the real `reactChips()` rendered against the live payload. Not exercised: `react_hourly_cap`
(would need 60 reactions — same code shape as the live-proven `guardAction` cap).

## Ban-safety audit (full sweep, 2026-09-02)

Every call that touches WhatsApp's servers was enumerated (`sock.*`) and traced to its trigger.

**Clean:**
- **No bulk lookups anywhere** — no `onWhatsApp`, no `getLIDForPN` (USync), no `profilePictureUrl`, no
  `presenceSubscribe`/`sendPresenceUpdate`, no `readMessages`. LID→phone resolution is a LOCAL key-store
  read. Bulk contact-checking is the classic way these numbers get banned; we never do it.
- **Nothing on a timer talks to WhatsApp.** The only intervals are the monitor feed (reads OUR Postgres)
  and the QR page (polls our own endpoint). `groupFetchAllParticipating` runs once 5 s after connect, on the
  manual ↺ Refresh, and once after a leave; `groupMetadata` only when you open one group;
  `fetchMessageHistory` has no caller at all.
- **Every write endpoint is guarded:** `/send` → `guardedSend`, `/react` → `guardReact`,
  `/leave` + `/delete` + `/chat/delete` → `guardAction`. `/read` never leaves the box (a DB `unread=0`;
  we don't even send read receipts).
- **Rule replies obey the Settings limits** — `guardedSend` with no `force`, and only when the rule is
  `mode:'live'`. `force` (explicit `/send` or MQTT only) relaxes **contact_only alone**; rate + caps are
  unconditional. Live inventory 2026-09-02: **1 rule, popup-only (`reply:null`) — it cannot send.**
- `rule_engine` holds a `write mur/home/whatsapp/send` ACL (the planned P4 notify path). **Nothing publishes
  it and 0 MQTT sends have ever occurred** — latent capability, not an active risk.

**Origin lock (2026-09-02).** The API used to answer `Access-Control-Allow-Origin: *` with no auth, so
**any website opened on the home network could call it** — `/send` from the real number, `/leave`,
`/chat/delete`, or read every chat. Now only pages served from INSIDE the network may call it: same-origin,
`localhost`/`127.0.0.1`, or an RFC1918 / NetBird (100.64/10) host — an attacker page comes from a public
domain and is refused. `ALLOWED_ORIGINS` (comma-separated) adds exceptions. ⚠ The refusal is an explicit
**403**, not just withheld headers: a *simple* request needing no preflight (e.g. `POST /groups/refresh`,
no JSON body) would otherwise still **execute** server-side while the browser merely hid the reply.
A request with **no Origin** (curl, server-side callers, same-origin GET) is untouched, so the LAN trust
model is unchanged. Verified live: evil-origin preflight **403**, evil `POST /send` **403**, evil
`POST /groups/refresh` **403**; `http://localhost:3000` and `http://192.168.1.128:3000` **200** on
status/chats/recent/settings/groups; no-Origin **200**; `/link` still serves.

**Fixed by this audit:**
1. **Reconnect had no backoff** — a flat `setTimeout(connect, 2000)` on every close. Normal drops are rare
   (measured: 21 in 3 days, max 2/h, codes 428/503/515) so it never bit, but a *persistent* refusal would
   have hammered a login every 2 s forever — a connect storm is exactly what turns a temporary block into a
   ban. Now exponential with jitter, **2→4→9→17→35→60→119→237→297 s (cap 5 min)**, reset on a successful
   connection, and ≥ 60 s when logged out (only a human QR scan can fix that). Worst case **12 attempts/h
   instead of 1800**; the first retry is still 2 s, so ordinary drops recover exactly as fast as before.
2. **Live automation had no duplicate-delivery guard.** Baileys can re-emit the same message (reconnect,
   unacked delivery) and the rule would have fired a **second real auto-reply**. `applyAutomation` now skips
   a `wa_id` that already has an `applied` log row — the same dedupe the retroactive sweep always had.
3. **`markOnlineOnConnect` was Baileys' default `true`** — the account was presented as **online 24/7**
   (bot-like, and WhatsApp suppresses phone push notifications while a linked device is online). Now `false`.
4. **`syncFullHistory` was Baileys' default `true`** — asked the phone for the entire history on every fresh
   link. Now `false`: everything is already cached in Postgres, and `/history` can pull older on demand.

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
