# WHATSAPP — WhatsApp Cloud API agent (two-way send + receive)

**STATUS: PLANNED (2026-08-29) — not built.** Full plan below; execution paused (starts with the free
Meta test number, P0). Nothing on any system has been changed for this yet.

## Purpose
Add a **WhatsApp channel** to the project using Meta's **official WhatsApp Cloud API** (free tier,
**non-Chinese** — Meta/US, honors [[feedback_no_chinese_tools]]). Goal: **send** (Kitchen shopping list,
alerts) and **receive** (message the house → it reacts), wired into MQTT / rules — modeled on the existing
**Email agent (LXC 110)**. Two surfaces the user explicitly wants:
1. A **full WhatsApp dashboard page** (chat/inbox presentation like the Email page).
2. **WhatsApp as a delivery channel in the Notifications subsystem** — so any notification can reach the
   phone **anywhere (away from home, e.g. abroad)**.

Replaces today's manual `wa.me` share link (Kitchen shopping list) with real automation.

> ⚠ **Honest caveat:** the **Email agent already gives two-way messaging** with none of the WhatsApp
> overhead. WhatsApp's unique value is **phone-native immediacy + reaching the family chat**; if the goal
> is only "ping my phone," **ntfy** ([[project_phone_push_ntfy_plan]]) is far lighter. **Do Phase 0 first**
> (free, ~15 min, zero infra) before committing the dedicated number + tunnel + business verification.

## Prerequisites (real commitments — gather before P1)
1. **A dedicated phone number** (spare SIM / VoIP) that can receive an SMS/voice OTP — **NOT** the personal
   WhatsApp number (the Business Platform consumes it; it can't run in the normal app at the same time).
2. **Meta Business account + business verification** (business docs) — for a permanent token + production
   messaging limits.
3. **A public HTTPS webhook** for *receiving* — a **Cloudflare Tunnel** (free, non-Chinese) from the
   internet → the agent service. Sending needs none of this. ⚠ **NEW dependency** — nothing in the project
   uses Cloudflare Tunnel today, and **NetBird can't serve it** (private overlay, no public URL). A
   *stable* named tunnel needs a **Cloudflare account + a domain**; the free `trycloudflare` quick-tunnels
   give an **ephemeral** random URL (fine for P2 testing, not for a permanent webhook). Alternatives if no
   domain: a tiny public VPS, or defer receiving (send-only works with zero public ingress).

## How to GET the Cloud API (P0, user-side — a few browser clicks)
1. **developers.facebook.com** → log in → register as a developer.
2. **Create App** → type **Business** → name it.
3. In the app → **WhatsApp → Set up** (creates/links a Meta Business account).
4. Meta gives a **free test number + 24 h token** immediately, and lets you send to up to **5 verified
   recipients** — the fastest way to prove sending before committing anything.
5. Send the built-in `hello_world` template to your own number via a `curl` call → confirms send works.
6. (Later, production) register the **real dedicated number** in WhatsApp Manager (SMS/voice OTP), complete
   **Business Verification**, create a **System User** with a **permanent token**, and submit **templates**.

## Architecture (mirrors the Email agent, LXC 110)
- **New dedicated LXC** ("whatsapp"; scaffold via `/create-agent`). Isolated like Email/110 because it is
  **internet-facing + ingests untrusted content** — not on the core boxes. ⚠ **id: 100–111 + 113 are in
  use; 112 is the stopped/empty FR shell, 114+ free** → reuse 112 or take 114 (confirm at build).
- **`whatsapp-agent` service** (Python Flask, like `email-agent`):
  - **Send:** `POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages` with the system-user token
    → free-form text (only inside the 24 h window after the user messages first) or an approved
    **template** (for proactive sends).
  - **Receive:** a **webhook** — `GET /webhook` (verify-token handshake) + `POST /webhook` (incoming
    messages + delivery statuses). ⚠ **verify Meta's `X-Hub-Signature-256`** against the app secret;
    **bleach-sanitize** message bodies (untrusted, same discipline as Email — never store raw).
- **Cloudflare Tunnel** → the service's `/webhook` (the only inbound path).
- **MQTT:** incoming → publish `mur/home/whatsapp/message` → **rule engine group `whatsapp`**
  (`device_id='whatsapp'`), exactly like the `email` group. Outbound send exposed as a dashboard endpoint
  + a rule-dispatch path.

## Secrets / config (service `.env`, never committed)
`WA_TOKEN` (permanent system-user token, scopes `whatsapp_business_messaging` + `_management`),
`WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, MQTT creds (LXC 107). New broker user
`whatsapp_agent` (ACL `mur/home/whatsapp/#`) via the manual LXC-107 ACL step.

## DB (LXC 102, migration under `WHATSAPP/migrations/`)
- `whatsapp_messages` — metadata + text cache (from/to, ts, direction, wa_id, status), retention 180 d
  (Email-shaped).
- `whatsapp_state` — singleton (token expiry/watermark + settings), forever.
- `whatsapp_contacts` (optional) — wa_id → name map.
Register in Health **DB-Volumes** + `retention_policies`. `agents` row with **data_table/settings_table
NULL** (a service cache, not a decision-loop agent — same as `email`).

## Dashboard — WhatsApp presentation (`whatsapp.html` + `js/whatsapp.js`, Personal group, under Email)
A **full chat-style page**, same shape as the Email page (UI-only, calls the agent's Flask API directly
like `email.js`):
- **Thread list** (left) — conversations grouped by contact (wa_id → name from `whatsapp_contacts`), last
  message + unread marker, newest first.
- **Read pane / chat view** (right) — message bubbles for the selected thread (inbound vs outbound styled),
  delivery/read ticks from the webhook status events, media thumbnails if received.
- **Compose / send** — free-form text (allowed only inside the 24 h window — greyed out with "session
  closed, use a template" when outside) + a **template picker** (approved templates + their variables) for
  proactive sends.
- **Automation tab** (later) — sender rules → react/extract, Email-style.
- **First real use:** Kitchen shopping list — switch the `wa.me` button to `POST` the list via the agent
  (via an approved template for the proactive send).

## Notifications integration — WhatsApp as a delivery surface
The project-wide **Notifications** subsystem ([[project_agent_notifications]]) already has surfaces
(`popup`, `tablet`); add **`surfaces.whatsapp`** so any user-authored notification can be delivered to
WhatsApp — the channel that reaches the phone **anywhere (away from home)**.
- **Def shape:** `surfaces.whatsapp = { enabled, template, recipient, vars_map }` (parallel to
  `surfaces.tablet`). Authored on **Main Agent → Notifications tab** (a WhatsApp toggle + template picker +
  recipient).
- **Dispatch:** `RULES/rules/notifications.py` (group `notify`) gets a `_build_whatsapp` helper (mirror of
  `_build_panel_alert`, `notifications.py:243-262`) → emits `{protocol:'whatsapp'}`; the rule engine's
  `_dispatch_command` (rule_engine.py:1869; the `protocol=='panel_alert'` branch at :1962 is the model)
  gets a new `protocol=='whatsapp'` branch → publishes to `mur/home/whatsapp/send` → the agent sends a
  Graph API template. Engine-core edit → one `systemctl restart rule-engine`.
- **⚠ Template constraint (Meta rule):** a notification is a *proactive* message → outside the 24 h window
  it **MUST use a pre-approved template**, not free-form text. Define a **small set of notification
  templates** (e.g. `home_alert` with a `{{1}}` body variable, maybe `home_alert_urgent`); the
  notification's rendered text fills the template variable. Submit for approval in P4. Recipient = a
  configured household number (default in settings, overridable per notification).
- **Recipient / opt-in:** to receive proactive template messages the recipient must have messaged the
  business number once — a one-time step per household phone.

## Rules (`RULES/rules/`, group `whatsapp`)
Ingest rule: incoming WhatsApp → parse intent → act (e.g. "boiler off", "status") — same pattern as the
email group. Authored via `/create-rule`.

## Phased build (each a stop-and-verify gate)
- **P0 — prove it, ZERO infra:** Meta dev account → Business app → add WhatsApp → free test number + 24 h
  token → send `hello_world` to your own number via `curl`. ~15 min, no LXC/tunnel/verification.
- **P1 — LXC + service (send):** scaffold the LXC + `whatsapp-agent`; real dedicated number; permanent
  token; send text/template from a dashboard endpoint.
- **P2 — receive:** Cloudflare Tunnel → `/webhook`; signature verify + sanitize; publish incoming → MQTT →
  the `whatsapp` rule group.
- **P3 — dashboard presentation:** `whatsapp.html` full chat page; switch the Kitchen shopping-list button
  to the API.
- **P4 — templates + Notifications surface + automation:** submit the `home_alert` templates; add
  `surfaces.whatsapp` (def + Notifications tab + the `_dispatch_command` `protocol:'whatsapp'` path);
  sender-rule automation (Email-style).

## Files (on execution)
- New: `WHATSAPP/` (this doc + `migrations/`), the LXC `whatsapp-agent` service, `whatsapp.html` +
  `js/whatsapp.js`, `RULES/rules/whatsapp_*.py`, memory `project_agent_whatsapp.md`.
- Edit: root `CLAUDE.md` (Dashboard Pages + Project Modules rows), `MEMORY.md`, Kitchen shopping-list send
  path, broker ACL (LXC 107), Cloudflare Tunnel config.
- No change to the core stack; the agent is self-contained like Email.

## Cost
Effectively **free** for home volume (Meta's free service-conversation allowance; test tier free).
Cloudflare Tunnel free.

## Verification
- **P0:** `hello_world` arrives on your phone from the test number (curl → 200 + message received).
- **P2:** send yourself a WhatsApp → it lands in `whatsapp_messages` + fires `mur/home/whatsapp/message`.
- **P3:** the page renders threads/messages; a manual send arrives on the phone; Kitchen "Send to WhatsApp"
  delivers via the API (not `wa.me`).
- **P4:** a test notification with `surfaces.whatsapp` on → a **template** WhatsApp message arrives on the
  phone **away from home** (proving notify-anywhere); a reply reaches the `whatsapp` rule group.

## Plan re-checked against live code (2026-08-29) — verified accurate
- ✅ **Email mirror:** `EMAIL/agent/agent.py:134` publishes `mur/home/email/message`;
  `rule_engine.on_mqtt_event` → synthetic `device_id='email'`. Our WhatsApp topic/id is the same shape.
- ✅ **Notifications surface dispatch:** `notifications.py:243-262` `_build_panel_alert` → `protocol:'panel_alert'`;
  `rule_engine._dispatch_command:1962` has that branch (one of ~13). `surfaces.whatsapp` mirrors it faithfully.
- ⚠ **LXC id** (112 FR shell / 114+) + ⚠ **Cloudflare Tunnel = new dep needing a domain** — see Prerequisites/Architecture.

## Constraints honored
- **Non-Chinese** (Meta/US + Cloudflare/US). Isolated internet-facing LXC (untrusted ingest, like Email).
- No core-stack change; broker ACL is the one manual LXC-107 step. `/create-agent` + `/create-rule`
  scaffold the boilerplate. **Start with P0 (free, no commitment) before P1+.**

## Related
- [EMAIL](../EMAIL/CLAUDE.md) — the two-way messaging agent this is modeled on (LXC 110, `/create-email-rule`).
- [NOTIFICATIONS](../NOTIFICATIONS/CLAUDE.md) — the delivery-surface system WhatsApp plugs into
  ([[project_agent_notifications]]).
- [[project_phone_push_ntfy_plan]] — the lighter phone-push alternative if only "ping my phone" is wanted.
