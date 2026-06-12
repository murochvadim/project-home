# Privacy Agent

**Status: PLANNED — scoped 2026-06-12. Nothing built yet** (no LXC, no installs). This file is the agreed design + build plan; the build is pending user go-ahead + Proxmox host access.

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
