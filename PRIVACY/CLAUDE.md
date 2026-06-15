# Privacy Agent

**Status: BUILDING (started 2026-06-13).** Phases 1–5 done: LXC + Docker + Vaultwarden (hardened) + Cryptomator docs vault in Google Drive + LXC copy + nightly QNAP backup. Phases 6–7 (phone/laptop clients, dashboard tile) pending.

### Built so far (2026-06-13)
- **LXC 109 `privacy`** on Proxmox host `192.168.1.101` — Debian 12.12, 2 vCPU / 2 GB / 16 GB, **static `192.168.1.196`**, privileged + `features: nesting=1,keyctl=1` (for Docker), `onboot=1`, SSH via the PVE `claude-code` key. Created with `pct create … local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst`.
- **Docker** 29.5.3 + compose v5.1.4 (official docker.com repo).
- **Vaultwarden 1.36.0** (≥ 1.35.5 ✓) + **Caddy** (HTTPS, internal CA) via `docker compose` at `/opt/privacy/` → repo copies: [docker-compose.yml](docker-compose.yml) + [Caddyfile](Caddyfile). URL **`https://192.168.1.196`**.
  - Hardening applied: `SIGNUPS_ALLOWED=false` (locked after the 1 account `murochvadim@gmail.com` was created — register now returns 422), `ORG_CREATION_USERS=none` (orgs disabled → removes the 2026-CVE surface), **no `ADMIN_TOKEN` → `/admin` disabled**.
  - **HTTPS gotcha solved:** serving on a bare IP failed TLS (`tlsv1 alert internal error`) because clients can't send an IP as SNI → fixed with Caddy global `default_sni 192.168.1.196`.
  - **Caddy internal root CA** at `/opt/privacy/caddy-data/caddy/pki/authorities/local/root.crt` (copied to the Windows host `C:\Users\muroc\caddy-root-CA.crt`) — **install on each device** to trust the cert.
- **User DONE:** KDF = **Argon2id** (64 MB/3/4, verified in DB); Caddy root CA installed in the laptop's Trusted Root (HTTPS lock clean). Data volume `/opt/privacy/vw-data` (NOT in git — vault DB).
- **Cryptomator docs vault (Phase 4, 2026-06-13):** vault created by the user on the laptop at **`G:\My Drive\Privacy`** (named "Privacy") via the Cryptomator desktop app (v1.19.2) + WinFsp. Encrypted (client-side AES-256); Google Drive desktop syncs the ciphertext to the cloud + everywhere. Vault password is the user's alone (stored in Vaultwarden, never with the assistant) — separate from the Vaultwarden master password. To use: Cryptomator → Unlock → mounts a drive → drop files in.
- **Read-only Drive access (Phase 4c):** `rclone` remote `gdrive` with **`scope = drive.readonly`** (OAuth token obtained via `rclone authorize` on the laptop, browser consent). Token copied to **LXC 109** (`/root/.config/rclone/rclone.conf`) AND **LXC 104**. Read-only = the servers can pull the vault but can NEVER modify/delete anything in the user's Drive. LXC 109 holds a manual ciphertext copy at `/opt/privacy/vault-copy/Privacy`.
- **Nightly QNAP backup (Phase 5):** `scripts/privacy-vault-backup.sh` → `/opt/privacy-vault-backup.sh` on **LXC 104** (per the timers-on-104 rule). `rclone sync gdrive:Privacy → /mnt/qnap-claude/Privacy_Vault`, cron **`15 3 * * *`**, log `/var/log/privacy-vault-backup.log`. Ciphertext only (no vault password). **3 copies of the encrypted vault:** Google Drive (primary/offsite/view-anywhere) + LXC 109 (manual snapshot) + QNAP (nightly automated). Verified: backup ran, copy landed on QNAP.
- **Pending (Phases 6–7):** install Bitwarden + Cryptomator + Caddy root CA on the **phone** (and Bitwarden extension on the laptop). Phone = user opted out (2026-06-13).

## Dashboard page — Privacy (Personal group, first; since 2026-06-13)
`BOILER/dashboard/public/privacy.html` + `js/privacy.js`, sidebar **Privacy** as the **first item in Personal** (above Medical). Backend: **`routes-privacy.js`** (own module, architecture-guard pattern). Tables on LXC 102: `privacy_sites`, `privacy_site_docs`, `privacy_doc_crypto` (migration `PRIVACY/migrations/002_privacy_dashboard.sql`).

**Tab: Sites** — a CRM of services/accounts (bank, insurance, gov…). Each site: kind / name / Main Tel / **Additional phones** (list of `{tel, person}`, editable) / fax / email / website / optional **Vault item** (powers a **🔑 Vaultwarden** link that opens `https://192.168.1.196`) / notes. Add/edit (modal) + delete. Stored plaintext (LAN-only, like `medical_contacts`). Also a **📅 Next appointment** (date + HH + MM 24h inputs + reason; `next_appointment_at` TIMESTAMPTZ + `next_appointment_note`) and a **🔔 Reminder** (standalone text; `reminder_text`) — same pattern as Medical Contacts: red appointment mini-card (turns muted + "past" pill once elapsed) + blue reminder mini-card on the site card; date+HH+MM combine to a UTC ISO client-side (`_pvPartsToISO`). **Appointment color bands** (since 2026-06-15) — the single appointment card is *colored by proximity* (still one appointment + one reminder; no `!` square — that earlier same-day idea was replaced). A far-off appointment is 🟢 **green**; as it approaches it turns 🟡 **yellow** then 🔴 **red**. After the appointment day it **stays red** for `grey_days` more days, then turns ⚪ **grey forever**. The **Settings** tab has **3** day inputs: `red_days` = days right before the appointment (red), `yellow_days` = days before red (yellow), `grey_days` = days it stays red *after* the appointment before going grey. 🟢 green is the automatic catch-all for anything further out than yellow (no far cutoff — a 76-day appointment is green). Stored in `dashboard_settings` key `privacy.settings` = `{yellow_days,red_days,grey_days}` (defaults 7/3/7) via the generic `/api/dashboard-settings/:key` GET/POST — **no privacy backend / DB change**. **Styling:** card text is always **black**; every card (grey/red/yellow/green + the reminder) is **frameless** (border == fill). Logic: `_pvApptBand(date)` → `_pvApptCard` styles bg/border; `pvLoadSettings()` runs in `pvRefresh`, `pvSaveSettings()` re-renders sites on save. (Earlier same-day iterations — a "flip to `!` square", then a 4-band model with `green_days`+`grey_days` widths and a plain far/long-past zone — were all replaced; stale `green_days`/`grey_days` may linger in the saved JSON until the next Save, harmless/unread.)

**Drag-to-reorder sites** (since 2026-06-15) — each site card has a **⋮⋮ handle** (top-left, by the kind/name); drag a card onto another to reorder (dashed-blue drop highlight). Persisted in a new `privacy_sites.sort_order INTEGER` (migration `002`); `POST /api/privacy/sites/reorder {order:[ids]}` writes `sort_order = position`; GET orders `sort_order ASC NULLS LAST, kind, name` (new sites fall to the end). Only the handle is `draggable`; wiring (`pvWireSiteDrag`) is skipped while a filter is active. Mirrors power.js `mdWireDragReorder`, adapted for the 2-col card grid.

**Documents card launchers** (Sites tab top row, since 2026-06-14) — `pvRenderLockState()` renders, to the right of the lock action button (Set password / Unlock / Lock), two same-size `btn-sm` launchers: green **🔑 Vaultwarden** → `https://192.168.1.196` and dark (`#222`, the card name color) **📁 Google Drive** → `https://drive.google.com/drive/u/0/my-drive`. Plain `window.open` links — no vault access (password CRUD stays in the native Bitwarden clients by design).

**Per-site 📄 Docs window** — each site holds documents, each **🔒 encrypted OR 🔓 plain** (user chooses per doc at add time). Add / open / rename / delete; PDFs+images preview in a new tab, others download.

**Encryption — server is BLIND, all client-side in `js/privacy.js`:**
- **One "Documents password"** for the whole page (stored in Vaultwarden; forget it = encrypted docs unrecoverable). Per-session unlock; Lock button + lock-state indicator.
- **WebCrypto AES-256-GCM**, key from **PBKDF2-SHA256 @ 600,000 iters** (OWASP 2025/2026-verified) + a random 16-byte salt; per-file random 12-byte IV. `privacy_doc_crypto` (singleton) stores ONLY the salt + a **verifier** (a known token encrypted with the key) → lets the page detect a wrong password without being able to decrypt anything. The password/key/plaintext/real filename **never reach the server**.
- Encrypted docs: the **filename is encrypted too** (`enc_name`) — the real name is stored as `displayName||originalFilename` so the file TYPE is derived from the decrypted name on open (not leaked). File bytes uploaded as ciphertext.
- Plain docs: stored as-is with plaintext name + mime.
- **Storage:** file bytes on **QNAP** `\\192.168.1.155\Claude_Data\Privacy_Site_Docs\` (ciphertext for encrypted, as-is for plain); **DELETE tunnels via LXC 104 SSH** (same QNAP-ACL reason as Medical Documents). 25 MB cap (30 MB multer headroom). Verified end-to-end 2026-06-13.

**Tab: Doc Create** (since 2026-06-14) — generate a document from a **template ("kind")**, sign it, and print/save it. Logic in `js/privacy-doccreate.js` (`pvdc*`); all client-side, no new backend endpoint (save reuses the Sites docs upload). Vendored libs in `public/vendor/doccreate/`: `signature_pad.umd.min.js` (hand-drawn signature, v4 — `addEventListener('endStroke')`) + `html-docx.js` (HTML→DOCX, `window.htmlDocx.asBlob`).
- **Engine history — html2canvas/jsPDF were tried and REMOVED.** `html2pdf.bundle.min.js` (html2canvas) mangled RTL Hebrew every way (right-edge clipped, dropped spaces, phantom `<table>` row gaps, blank/empty canvas via `foreignObjectRendering`, half-rendered signature box). A `jsPDF` + embedded-Alef-font vector path was then built for real PDF-blob-to-site, but its manual BiDi mixed fields and was abandoned per user. **Final design: PDF via the browser's NATIVE print engine** (`pvdcPrint()` opens a new window with the doc HTML + `@page` CSS + `print-color-adjust:exact` so backgrounds survive Save-as-PDF, then `window.print()`), and **DOCX (`html-docx-js`) for saving into a site**. A correct PDF *blob* can't be produced reliably client-side, so PDFs go to disk via Print; sites store the editable DOCX.
- **Templates** — `PVDC_TEMPLATES` map; each entry = `{label, fields[], title, fileName(d), html(d, sigHtml)}`. Add a template by adding one entry + an `<option>` in the kind `<select>`. First template **`bank_transfer`** = Hebrew **בקשה לביצוע העברה בנקאית** (RTL form: date / requester name / ID / beneficiary / target bank / branch / account / amount + amount-in-words / purpose). Rendered as a styled RTL document; the field grid is **flex `<div>`s, not a `<table>`**. Colors match the user's example bank-form PDF (extracted from its color operators): header band + labels `#2b4c7e`, label cells `#f4f7fa`, borders `#e0e0e0`, amount accent `#b13d3d`, secondary `#64748b`, warm page `#fdfbf7`. Values are HTML-escaped (`_pvdcEsc`).
- **Visual e-signature** (NOT cryptographic PKI) — a dashed **חתימה אלקטרונית / ELECTRONIC SIGNATURE** box containing ONLY the label + the optional **hand-drawn signature** (`signature_pad` canvas → PNG dataURL). (Per user: the name/ID/timestamp/CONFIRMED lines that matched the example were removed — the document body already carries the date.) Live preview updates on every field/stroke change.
- **Export row** — Format radio **PDF** / **Google Doc (DOCX)**, plus **💾 Save** + **🖨 Print / Save as PDF** (the ⬇ Download button was removed per user). **🖨 Print** → native print to disk (perfect Hebrew/colors). **💾 Save** → stores a **DOCX** into a chosen Privacy Site (🔒 Encrypt checkbox; encrypted path reuses privacy.js `pvEnsureUnlocked`/`_pvEncBytes`/`_pvEncStr`/`_pvKey` and POSTs ciphertext to `/api/privacy/sites/:id/docs`, same contract as a Sites-tab upload). Saving with Format=PDF shows a message to use Print instead.
- `js/privacy.js` `showTab()` calls `pvdcOnShow()` on the Doc Create tab (renders the form, inits the sig pad, fills the site dropdown from the global `_pvSites`). privacy.js must load BEFORE privacy-doccreate.js (shared global lexical scope; both are classic scripts).

---

**Original plan below (design rationale + remaining phases).**

## Goal
A dedicated, private LXC to: (1) **store documents that can only be opened with a password**, and (2) **self-host a password manager**. Redundancy to **Google Drive** (offsite) + **QNAP** (local). **LAN-only** (nothing exposed to the internet).

## Locked design
| Part | Solution |
|---|---|
| **New LXC** | "PRIVACY" (next free ID ~109), Debian 12, LAN-only, static `192.168.1.x` |
| **Passwords** | **Vaultwarden** on the LXC (self-hosted Bitwarden-compatible, Rust, ~100 MB RAM). E2E / zero-knowledge — vault encrypted with the master password; the server never sees plaintext. Remote = **Bitwarden app offline cache** (chosen over NetBird) |
| **Docs** | **Cryptomator** encrypted vault → **Google Drive** (remote view) + copy on LXC + backup on QNAP. All ciphertext; **per-session unlock** with the master password — home AND away, no plaintext shortcut |
| **Backups** | **QNAP** (existing LXC 104 cron infra) + **Google Drive** (`rclone`), both encrypted |
| **Cloud** | Google **Drive free tier** (15 GB) on the user's gmail |
| **Access** | LAN-only at home; remote docs via Cryptomator+Drive; remote passwords via the offline cache |

## Security model (the load-bearing part)
- An LXC's filesystem is **readable from the Proxmox host (root)**. So "only by password" is real ONLY because the data is **encrypted with a key derived from the password, not stored on disk**:
  - **Vaultwarden** — inherently E2E (master password) → satisfied automatically.
  - **Docs** — Cryptomator **client-side** encryption → ciphertext at rest *everywhere* (LXC / QNAP / Drive); only the user's device decrypts, with the password.
- **Anything sent to Google MUST be ciphertext** (Google can read plaintext). The Cryptomator vault is already ciphertext → safe to sync as-is; the Vaultwarden backup blob is wrapped with `rclone crypt`/`age` before Drive.
- **Per-session unlock:** Cryptomator asks for the password once per session (not per file); locks on close/idle. This *is* the privacy guarantee — the only way to skip it is plaintext (rejected).
- **Nothing exposed to the internet.** LAN-only; remote docs via Drive+Cryptomator, remote passwords via the Bitwarden offline cache.

## Password-manager capabilities (Vaultwarden server + Bitwarden clients)
- Store all passwords + secure notes + **TOTP/2FA** + attachments + generator.
- **Autofill:** browser extension fills matched logins by URL (websites); mobile OS autofill fills *other apps* on the phone. **Native Windows desktop apps = copy-paste** (limited auto-inject — the one spot it's not fully automatic).
- **Suggest + generate a strong password on signup**, then auto-saves the login (like Chrome/Edge's built-in suggestion).
- **Offline cache:** the Bitwarden apps keep an encrypted local copy → read/autofill when away; edits sync when back on the LAN.

## Security review + hardening (2026-06-12)
**Verdict: keep Vaultwarden + Cryptomator with the hardening below — do NOT switch to the no-server KeePassXC variant** (for this home, non-targeted user). Reasoning: KeePassXC's only security win is removing the self-hosted server surface, which is already contained here (LAN-only, HTTPS, native clients not the web vault, patched). Bitwarden's far better usability (autofill, generator, live sync) produces *better real-world* hygiene (unique strong passwords everywhere) than KeePassXC's friction. The dominant risks are identical in both designs (see below) and the user has the ops discipline to keep one more LAN-only service patched. **Flip to KeePassXC only if:** targeted high-value subject, or "zero self-hosted services" on principle.

**The risks that actually dominate (independent of tool choice) + mandatory hardening:**
1. **Master-password strength is the root of trust, and the encrypted blobs LEAVE the house (Drive + QNAP) → offline brute-force is the real threat.** → long, high-entropy, *unique* passphrases for Vaultwarden AND Cryptomator; **set Bitwarden KDF to Argon2id**. Non-negotiable.
2. **Endpoints are the weak link** (plaintext in RAM when unlocked) → laptop/phone patched, **full-disk-encrypted (BitLocker)**, auto-lock.
3. **Google account holds the offsite ciphertext** → strong **2FA (hardware key/TOTP, not SMS)** on the gmail.
4. **Forgotten master password = permanent loss** → secure **recovery copy** (printed, in a physical safe) + Bitwarden Emergency Access.
5. **Vaultwarden server hygiene** → HTTPS even on LAN; use native app + browser extension (avoid the web vault, which a compromised server could trojan to steal the master password); lock down `/admin`; patch discipline; Vaultwarden 2FA for online login.

Component notes: Vaultwarden vault = client-side E2E (server never holds the key); Cryptomator = client-side AES-256, Cure53-audited. Metadata caveats: Vaultwarden DB leaks account email/timestamps/counts (contents encrypted); Cryptomator leaks file sizes/count/mtimes (names + content encrypted). Both acceptable for this use. **Pre-build TODO:** verify current Vaultwarden/Cryptomator CVEs + audit status before deploying (knowledge has a cutoff; do a quick web check at build time).

## CVE / security web-check (done 2026-06-13)
Web-checked current CVEs/audit status before committing to the build. **Verdict: design unchanged — Vaultwarden + Cryptomator remains sound for a single-user, LAN-only, patched setup.** Findings:

- **Vaultwarden — 3 recent CVEs, all about MULTI-USER ORGS / the admin panel, all patched. None break single-user vault crypto.**
  - `CVE-2026-43912` cross-organization data access → fixed in **1.35.5**
  - `CVE-2026-27802` privilege escalation (bulk permission update) → fixed in **1.35.4**
  - `CVE-2026-26012` org cipher auth bypass → fixed in **1.35.3**
  - earlier 2025 advisories: CSRF + **RCE in the admin panel** + priv-esc.
  - **→ Firm build requirements (added by this check):** deploy **Vaultwarden ≥ 1.35.5**, run **single-user (no organizations)**, **lock down `/admin`** (strong `ADMIN_TOKEN` or disable the admin panel), keep patched. The E2E vault is not affected by any of these.
- **Cryptomator — clean.** Cure53-audited (crypto "exceptional robustness", no break). Only minor advisories: a low-severity Mar-2026 issue (two ciphertext files could be swapped) + a 2025 MSI-installer local priv-esc. No serious CVE. Verdict stays: solid.
- **Argon2id KDF** — Bitwarden supports it (OWASP-recommended). At build time set concrete params (OWASP baseline ≥ 19 MiB / 2 iters / 1 parallelism, raised higher since our encrypted blobs go offsite to Drive/QNAP → offline brute-force is the real threat); bump memory in ~100 MB steps and test on all devices.

Sources: [Vaultwarden advisories](https://github.com/dani-garcia/vaultwarden/security/advisories), [Cryptomator security](https://github.com/cryptomator/cryptomator/security), [Cryptomator audit](https://community.cryptomator.org/t/has-there-been-a-security-review-audit-of-cryptomator/44), [Bitwarden KDF](https://bitwarden.com/help/kdf-algorithms/). Re-check at actual build time if much later than 2026-06-13.

## Build plan (phases — pending approval, one at a time)
1. **Provision the LXC** — Proxmox host `pct create`; Debian 12; 2 vCPU / 2 GB RAM / 16 GB disk (more if many docs); static IP.
2. **Vaultwarden** — Docker compose (`vaultwarden/server`), persistent data volume, **signups disabled after account created**, HTTPS via Caddy / internal cert.
3. **Cryptomator doc vault** — recommended topology: the PC creates the vault **inside the Google Drive folder** (Drive syncs it everywhere = remote view + offsite copy); the **LXC pulls a copy** (so the LXC "keeps the docs"); **QNAP backs it up**. (Alt: LXC-primary, shared to the PC over the LAN — clunkier.)
4. **`rclone` → Google Drive** — install on the LXC, one-time gmail OAuth, dedicated Drive folder; `rclone crypt` layer for the Vaultwarden backup blob.
5. **Backups (nightly)** — Vaultwarden data → encrypted archive → QNAP + Drive; Cryptomator vault (already ciphertext) → QNAP + Drive. Scheduled via the existing **LXC 104** cron pattern.
6. **Clients** — Bitwarden Windows app + browser extension + phone (Server URL = the LXC; offline cache on by default); Cryptomator on laptop + phone; Google Drive desktop client on the PC.
7. **Integration** — this `CLAUDE.md`, an infra-table row in root `CLAUDE.md`, retention/backup registration, and (optional) a **Project Privacy dashboard tile** (Vaultwarden up? last backup? Drive sync OK?).

## Decisions already made
- **Password manager = Vaultwarden** (over KeePassXC / Passbolt / Nextcloud-Passwords) — lightweight, E2E, full Bitwarden client ecosystem.
- **Docs encryption = Cryptomator** (over gocryptfs) — chosen for first-class mobile apps so the Drive copy is viewable on a phone/laptop with the password.
- **Remote passwords = offline cache** (option A, over NetBird) — simplest, nothing exposed.
- **Cloud = Google Drive free tier.**
- **Access = LAN-only.**
- **Per-session password unlock** for docs is accepted (the privacy trade-off).

## Open decisions / needed to start
1. **Proxmox host access** to create the LXC — or the user creates an empty Debian 12 LXC + gives SSH (can't `pct` from inside an LXC).
2. **gmail** for the rclone OAuth (user clicks through the one-time auth).
3. **Doc topology** — PC+Drive-primary (recommended) vs LXC-primary.
4. **Final disk size** — depends on doc volume (15 GB is the free-tier Drive cap).
5. **Optional dashboard tile** — build a Project Privacy status tile, or keep standalone.

## Convention note
Folder is `PRIVACY/` (correct spelling, matching the other module folders). The user wrote "PRIVECY" in chat — treated as a typo; confirm if the literal spelling is wanted.
