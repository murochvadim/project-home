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
