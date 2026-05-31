# NetBird VPN (transport layer for off-network access)

**Status:** ACTIVE — hosted tier @ `app.netbird.io`, LXC 108 gateway peer routing whole home LAN (2026-05-31). Project Gateway dashboard page under construction.

## Update 2026-05-31 — LXC 108 gateway + dashboard agent

Two milestones today:

### Milestone A — Gateway peer for whole-LAN access

LXC 108 created on Proxmox host as the dedicated NetBird gateway. Replaces the earlier "only the Windows host is a peer" topology, so now ANY peer in the tenant can reach ANY home LAN IP regardless of whether the Windows laptop is on.

| Spec | Value |
|---|---|
| Proxmox CT ID | 108 |
| Hostname | `netbird-gw` |
| LAN IP | `192.168.1.195/24` (gateway `192.168.1.1`) |
| Template | `debian-12-standard_12.12-1_amd64` |
| Resources | 1 vCPU, 512 MB RAM, 4 GB disk (`local-zfs`) |
| Privileged | yes (matches the rest of the project's LXCs — kernel WireGuard works instead of userspace fallback) |
| Features | `nesting=1` |
| onboot | 1 |
| SSH keys | inherited from Proxmox host's `/root/.ssh/authorized_keys` (claude-code + root@proxmox) |
| NetBird version | 0.71.4 (Linux client) |
| NetBird IP | `100.102.204.103/16` |
| NetBird FQDN | `netbird-gw.netbird.cloud` |
| Interface type | Kernel (not userspace) |
| `ip_forward` | enabled + persisted in `/etc/sysctl.conf` |

NetBird Cloud admin has `home-lan` network resource (CIDR `192.168.1.0/24`) with `netbird-gw` as the routing peer. Confirmed via `netbird status -d` on the Windows host (`newasus.netbird.cloud`, IP `100.102.207.1`) — it sees the peer announcing `192.168.1.0/24`.

**What this unlocks:** any NetBird peer in the tenant (Windows laptop, smartphone when its Android VPN-permission issue is fixed, future devices) can reach every home LAN service directly:
- `http://192.168.1.110:8123` — Home Assistant
- `http://192.168.1.128:3000` — Dashboard (Windows host)
- `192.168.1.219:5432` — Postgres
- All LXCs at `192.168.1.{114,138,187,188,189,219,227,190}`
- QNAP, router admin, etc.

No port forwarding on the home router. No public exposure. NetBird Cloud handles tenant auth via Google SSO.

### Milestone B — Project Gateway dashboard agent

NetBird/CLAUDE.md becomes the index for a new dashboard agent: **Project Gateway** (`gateway.html` + `js/gateway.js`). The agent's purpose is the controls NetBird Cloud admin doesn't natively cover:

1. **Peer identity overlay** — map NetBird peers (which only know FQDNs like `ahmed-iphone`) to project identities (User, Role, Device label). The mapping is consulted by other project features so "who is connecting via NetBird" propagates into rules, dashboards, and notifications.
2. **Tenant-event alerts** — push NetBird state into the existing `system_alerts` pipeline so unknown peers joining the tenant, peers offline beyond a per-peer threshold, or routes silently dropping all surface in the same dashboard badge as every other alert.

**File locations** (per project convention — files live in shared dirs, this CLAUDE.md is the index):

| Artifact | Path |
|---|---|
| Dashboard page | `BOILER/dashboard/public/gateway.html` + `BOILER/dashboard/public/js/gateway.js` |
| Server endpoints | `BOILER/dashboard/server.js` → `/api/gateway/*` cluster |
| DB tables (LXC 102) | `netbird_peers_local` (peer identity overlay) + `netbird_tenant_settings` (tenant-wide alert prefs) |
| Watchdog | `scripts/netbird_watchdog.py` → deployed to `/opt/netbird_watchdog.py` on LXC 104, cron every 5 min |
| Token storage | `BOILER/dashboard/.env` → `NETBIRD_API_TOKEN` (server.js consumer) + `/etc/netbird-watchdog.env` on LXC 104 (watchdog consumer); both must hold the same NetBird Personal Access Token generated in `app.netbird.io` → Profile → Personal Access Tokens |
| Sidebar slot | between Project Network and Project Boards |
| Sidebar status sub-badge | `NetBird ✓ N/M online` / `NetBird ⚠ alert` — added to `alerts-monitor.js`, polls `/api/gateway/status` |
| Alert namespace | `netbird:new_peer:<peer_id>` / `netbird:peer_offline:<peer_id>` / `netbird:route_dropped:<route_id>` — consistent with existing `group_stale:*` and `network:*` patterns; auto-resolve when condition clears |
| Watchdog `source` in `system_alerts` | `netbird_watchdog` |

**DB schemas** (LXC 102, both retention=forever via `retention_policies`):

```sql
CREATE TABLE netbird_peers_local (
  peer_id           text PRIMARY KEY,
  netbird_name      text,
  netbird_fqdn      text,
  user_name         text,
  role              text,
  device_label      text,
  alert_offline_min int,
  alert_on_join     boolean DEFAULT false,
  notes             text,
  bookmarks         jsonb DEFAULT '[]'::jsonb,
  created_at        timestamptz DEFAULT NOW(),
  updated_at        timestamptz DEFAULT NOW()
);

CREATE TABLE netbird_tenant_settings (
  id                int PRIMARY KEY DEFAULT 1,
  alert_new_peer    boolean DEFAULT true,
  alert_route_drop  boolean DEFAULT true,
  trusted_peers     jsonb DEFAULT '[]'::jsonb,
  poll_interval_sec int DEFAULT 60,
  updated_at        timestamptz DEFAULT NOW(),
  CHECK (id = 1)
);
```

**API auth pattern:** Bearer token in `Authorization` header against `https://api.netbird.io/api/peers` (and `/api/networks`, `/api/groups`, etc.). Token revocable from NetBird Cloud admin at any time — both consumers (server.js + watchdog) will fail the same way when that happens, which is intentional and surface-able as an alert.

**Mobile Cockpit (PWA) lives separately** at `NETBIRD/MOBILE/CLAUDE.md` — different scope (end-user touch surface), runs on LXC 105 as the `mobile-api` service. Not affected by today's work; both efforts share the NetBird transport layer.

---

## Update 2026-05-20 — hosted-tier setup completed

Skipped the LXC 108 self-host route for tonight; went with the hosted free tier at **app.netbird.io** (max 5 peers, sufficient for current needs):

- ✓ NetBird account created at `app.netbird.io`
- ✓ Setup key created: `ClaudeProjectKey` (shared in chat; if "Active" still, recommend revoking — both currently-paired peers have their own tokens)
- ✓ NetBird **Windows** installed on laptop → peer `newasus` @ NetBird IP `100.102.207.1`
- ✓ NetBird **Android** installed on phone (official `io.netbird.client`) → connected via Google SSO
- ✓ McAfee VPN port collision resolved — NetBird using **UDP 51821** instead of default 51820 (`netbird up --wireguard-port 51821`)
- ⏳ Untested end-to-end (laptop was asleep during the verification step)
- ⏳ Gateway peer on LXC for whole-LAN access — NOT yet installed. Tonight only laptop is reachable.

### Pivot decision pending

The hosted free tier covers ≤5 peers and a single account. It is sufficient for one-user, ~3-4 peer use cases. **Decide before adding more peers**: stay hosted, or migrate to the self-hosted plan below.

- **Stay hosted:** no further infra; just install NetBird Linux client on LXC 104 (or 105) and advertise the home LAN route. ~30 min.
- **Self-host (existing plan below):** LXC 108 + Docker + Caddy + DuckDNS + Google OIDC. ~2-4 hrs initial. Gives unlimited peers + EU-jurisdiction self-control + no third-party account dependency.

Mobile-cockpit work (see `NETBIRD/MOBILE/CLAUDE.md`) does NOT depend on which option you pick — both make the LXC reachable from phone the same way.

---

# NetBird Self-Hosted VPN (original Phase 1-5 plan — STILL VALID if you migrate)

**Status:** PLANNING — not yet implemented. User is evaluating; this doc captures the plan + the audit + the open decisions so the work can be picked up whenever.

## Purpose

Give the user remote access to the home dashboard (and all 7 LXCs) from
outside the home LAN via a self-hosted mesh VPN over WireGuard. Replaces
the "naked port-forward to dashboard" anti-pattern (the dashboard has
no authentication; exposing it directly is unsafe).

**Why NetBird specifically:**
- Berlin-based (EU jurisdiction, GDPR-native)
- Fully open source (AGPL-3 across server + clients)
- Same WireGuard data-plane performance as Tailscale
- Official self-host with **feature parity** to the hosted version (unlike Headscale, which lags Tailscale features)
- Free for unlimited use when self-hosted (no licensing tier)

## Pre-decision audit findings (2026-05-16)

Proxmox host @ `192.168.1.101` capacity check:

| Resource | Status | Headroom for new LXC 108 |
|---|---|---|
| Proxmox version | 9.1.6 (current stable) | n/a |
| Free RAM | 46 GB available out of 61 GB | 46× — Netbird needs 1 GB |
| Free disk | 892 GB on root + 892 GB on /var/lib/vz | 89× — Netbird needs 10 GB |
| Existing LXCs | 100-107 running (Media, postgresql, Agents, Servers, MainAgent, Voice, Mqtt) | LXC 108 slot free |
| Public IP | `87.71.202.169` (HOT Israeli ISP, **routable**, NOT CGNAT) | Direct inbound 443 works |
| Router | Technicolor MediaAccess DGA2232 | Supports port forwarding |
| Backup story | QNAP NFS storage already wired up | Netbird config auto-included |
| Docker | NOT installed on any current LXC | Will install on LXC 108 |
| Reverse proxy | None yet | Will install Caddy on LXC 108 |
| DDNS | None running | Will set up DuckDNS cron on LXC 108 |

**Verdict: GO** — infrastructure is more than sufficient. Only the user-side
choices (Proxmox WebUI access, router admin access, domain preference) need
confirmation before starting.

## Open decisions (user must answer before Phase 2 starts)

1. **Domain:** DuckDNS free subdomain (`<name>.duckdns.org`) — recommended for simplicity, OR an owned domain (`vpn.yourname.com`)?
2. **SSO provider:** Google login (uses existing Google account, simplest), OR self-managed user accounts (more setup, no Google dependency)?
3. **DDNS update method:** cron on LXC 108 (simplest), OR built-in DDNS in the DGA2232 router if it supports DuckDNS (some firmwares do)?
4. **Internal IP for LXC 108:** suggested `192.168.1.150` (free) — confirm not conflicting with anything in `net_devices`.

## TO-DO — Four-phase implementation plan

### Phase 1 — User: provision LXC 108 (10 min in Proxmox WebUI)

In Proxmox WebUI at `https://192.168.1.101:8006`:

- [ ] Create CT → ID `108`, hostname `vpn` (or `netbird`)
- [ ] **Template:** `debian-12-standard` from `local` storage
- [ ] **Disk:** 10 GB on rpool (same storage as other LXCs)
- [ ] **RAM:** 1024 MB
- [ ] **CPU:** 1 core
- [ ] **Network:** bridge `vmbr0`, static IP `192.168.1.150/24`, gateway `192.168.1.1`
- [ ] **DNS:** `8.8.8.8 1.1.1.1`
- [ ] **Features:** keep defaults
- [ ] **Privileged:** YES (Netbird needs the WireGuard kernel module visible — unprivileged container can't see /dev/net/tun cleanly)
- [ ] Start container, verify `ssh root@192.168.1.150` works
- [ ] Add LXC 108 to QNAP backup target via `pvesm` (mirror the pattern from other LXCs)

### Phase 2 — Software install on LXC 108 (~1 hr, automated via SSH)

Driven by Claude/agent over SSH. User just watches output.

- [ ] **Update + base packages:**
  ```
  apt update && apt full-upgrade -y
  apt install -y curl wget git ca-certificates jq sudo
  ```
- [ ] **Install Docker:**
  ```
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ```
- [ ] **Install Caddy** (reverse proxy with auto-TLS):
  ```
  apt install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy.list
  apt update && apt install -y caddy
  ```
- [ ] **Set up DuckDNS** (or owned domain):
  - Sign up at https://www.duckdns.org/ → pick subdomain → grab token
  - Cron job `*/5 * * * * curl -s "https://www.duckdns.org/update?domains=<sub>&token=<token>&ip=" >> /var/log/duckdns.log`
- [ ] **Caddyfile** at `/etc/caddy/Caddyfile`:
  ```
  vpn.yourname.duckdns.org {
      reverse_proxy localhost:80 {
          header_up Host {host}
      }
  }
  ```
  Caddy auto-fetches Let's Encrypt cert. systemctl reload caddy.
- [ ] **Deploy Netbird stack:** clone https://github.com/netbirdio/netbird and use their official `docker-compose.yml` template at `/opt/netbird/`. Configure:
  - `NETBIRD_DOMAIN=vpn.yourname.duckdns.org`
  - SSO provider (Google OIDC — needs client ID + secret from Google Cloud Console, one-time setup ~10 min)
  - `NETBIRD_TURN_USER` + `NETBIRD_TURN_PASSWORD` (auto-generated)
  - `docker compose up -d`
- [ ] **Smoke-test internal:** `curl -k https://localhost` from LXC 108 should return Netbird dashboard HTML.

### Phase 3 — User: open router ports (10 min in DGA2232 admin)

Login to router admin (rotate the password we just exposed in chat history).
Navigate to NAT / Port Forwarding (Technicolor menu varies by firmware — usually under "Network Sharing" or "Game & Application Sharing"):

- [ ] **Port forward TCP 443** → `192.168.1.150` (Netbird dashboard + sign-in over HTTPS)
- [ ] **Port forward UDP 3478** → `192.168.1.150` (STUN/TURN coordination)
- [ ] **Port forward UDP 49152-65535** → `192.168.1.150` (direct peer connections — optional but improves direct-mesh success rate)
- [ ] **Reserve DHCP lease** for `192.168.1.150` (so LXC 108 always gets the same IP from router even after reboots) — OR just confirm LXC 108 has static IP set (already covered in Phase 1)
- [ ] **Disable IPv6 firewall** for LXC 108 if IPv6 is enabled (Netbird is IPv4-only by default; IPv6 firewall blocking is a separate axis)
- [ ] **Verify external reachability:** from outside (e.g. phone on cellular, not WiFi), browse to `https://vpn.yourname.duckdns.org`. Should hit Netbird's login page over valid TLS.

### Phase 4 — Install Netbird clients (5-10 min on each device)

- [ ] **Windows laptop:**
  - Download installer from https://app.netbird.io/peers (or `https://vpn.yourname.duckdns.org/peers`)
  - Run `.msi` installer
  - During first launch, change "Management URL" to your self-hosted: `https://vpn.yourname.duckdns.org`
  - Sign in (Google OIDC opens browser)
  - Verify peer appears in Netbird admin dashboard
- [ ] **Phone (iOS or Android):**
  - Install Netbird app from App Store or Play Store
  - In settings, change "Management URL" to your self-hosted URL
  - Sign in
  - Verify peer appears in admin
- [ ] **(Optional) LXCs you want directly reachable** — install Netbird Linux client on LXC 103/105/107, repeat
- [ ] **Smoke test:** turn off WiFi on phone, use cellular only → browse to `http://192.168.1.128:3000` (or whatever the Windows laptop's LAN IP is) → dashboard loads. If it loads, the mesh is working end-to-end.

### Phase 5 (optional) — Update root CLAUDE.md to reflect new module

When implementation succeeds, add to root `CLAUDE.md`:
- Project Modules table: row for NetBird Agent → `NETBIRD/` → this CLAUDE.md
- LXC table: row for LXC 108 (192.168.1.150)
- One line in Infrastructure Connections section noting the VPN bridge

## Files this folder will eventually hold

- `CLAUDE.md` (this file) — purpose + plan + decisions
- `docker-compose.yml` — Netbird stack config (drop-in from upstream + filled secrets)
- `Caddyfile` — reverse proxy config
- `duckdns-update.sh` — DDNS cron script
- `setup-lxc.sh` — bootstrap script for fresh LXC 108 install (idempotent)
- `migrations/setup.sql` — none planned (Netbird brings its own DB)

## Rollback plan

If at any point Netbird doesn't work after deploy:
1. Stop the Docker compose: `docker compose down` in `/opt/netbird/`
2. Close router port forwards (single click in admin)
3. LXC 108 stays — costs nothing to keep around
4. Worst case: destroy LXC 108 — no impact on the rest of the system

The home automation stack does not depend on Netbird in any way; this is
a pure-add of an access channel, not an integration into existing flows.

## Cost summary

| Item | Cost |
|---|---|
| Netbird software | $0 (AGPL open source) |
| LXC 108 hosting | $0 (existing Proxmox host) |
| DuckDNS subdomain | $0 (free tier, unlimited time) |
| Let's Encrypt TLS cert | $0 (free, auto-renew) |
| Owned domain (optional alternative to DuckDNS) | ~$10-15/year if user wants their own |
| Maintenance | ~1-2 hrs/year (Docker image updates, port-forward sanity checks) |

**Total:** $0 cash, ~2-4 hrs initial setup, ~1-2 hrs/year ongoing.

## When user decides to proceed

Tell me **"start netbird phase 1"** (or "phase N" for any phase). I will:
- For phase 1: walk you through the Proxmox WebUI clicks
- For phase 2: SSH into LXC 108 and execute everything
- For phase 3: give you exact field-by-field router instructions
- For phase 4: walk through client installs

For ANY phase, I'll show you the exact commands/screenshots before executing on your behalf.

## Related project memory

- [[project_dashboard_mqtt_autoheal]] — current dashboard is bound to 127.0.0.1; making it externally accessible safely is the entire reason this VPN is being added.
