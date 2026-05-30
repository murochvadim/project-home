#!/usr/bin/env python3
"""ARP scan agent — runs on LXC 104, writes results to PostgreSQL on LXC 102."""
import subprocess, re, psycopg2
from datetime import datetime, timezone, timedelta

DB = dict(host='192.168.1.219', dbname='home_data', user='postgres')
IFACE = 'eth0'
ONLINE_GRACE_MIN = 15  # device considered online if seen within this many minutes

def get_local_iface_info():
    """Read this host's own IP + MAC on IFACE. arp-scan can't see the scanning
    host itself (a box doesn't ARP its own NIC), so we inject it manually."""
    try:
        with open(f'/sys/class/net/{IFACE}/address') as f:
            mac = f.read().strip().lower()
        out = subprocess.run(
            ['ip', '-4', '-o', 'addr', 'show', IFACE],
            capture_output=True, text=True
        ).stdout
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)/', out)
        ip = m.group(1) if m else None
        if not ip or not mac:
            return None
        return (ip, mac, None, 'LXC 104')
    except Exception:
        return None


def run_arp():
    # --retry=4 (was 2): doubles the per-target retry count to catch
    # devices that drop the first 1-2 probe replies. Adds ~3-5 s to scan
    # duration per /24 sweep but materially improves hit rate on noisy
    # WiFi (sparse-push devices like Ring Doorbell, Aqara FP2, ESP boards
    # were frequently slipping past the 10-min frontend threshold because
    # a single missed scan = 5+ min red.) Time budget at 5-min cadence
    # is generous (scan takes ~2 s currently → ~5-7 s after).
    result = subprocess.run(
        ['arp-scan', f'--interface={IFACE}', '--localnet', '--retry=4'],
        capture_output=True, text=True
    )
    devices = []
    for line in result.stdout.splitlines():
        m = re.match(r'^(\d+\.\d+\.\d+\.\d+)\s+([\da-f:]{17})\s+(.+?)(?:\s+\(DUP.*\))?$', line, re.IGNORECASE)
        if m:
            ip, mac, vendor = m.group(1), m.group(2).lower(), m.group(3).strip()
            if vendor == '(Unknown)':
                vendor = None
            elif vendor.startswith('(Unknown:'):
                vendor = 'Locally administered'
            devices.append((ip, mac, vendor, None))

    # arp-scan excludes the scanning host — add it so LXC 104 appears too
    self_info = get_local_iface_info()
    if self_info and not any(d[1] == self_info[1] for d in devices):
        devices.append(self_info)

    return devices

def merge_replaced_macs(cur, now):
    """Detect MAC changes for the same physical device and merge them.

    A new MAC X 'replaces' an old MAC Y at the same IP if all of:
      1. X was seen this scan (last_seen ~= now)
      2. Y has been silent for at least 30 minutes (>= 6 missed scans)
         — protects against transient gateway/sub-device flapping
      3. Either:
           a. X.vendor == Y.vendor (both known + equal OUI), OR
           b. Y.vendor == 'Locally administered' AND X.vendor is a KNOWN vendor.
         (3b handles the privacy-MAC-cycle case — a device cycling random
          MACs that finally commits to a stable manufacturer MAC. We require
          X.vendor to be known so we don't merge unrelated devices that
          coincidentally share an IP via DHCP reuse — empty/unknown vendor
          is too weak a link to assume same physical device.)
      4. NOT (both X and Y exist as separate rows in the `devices` table).
         If our system already tracks them as distinct devices, they are
         distinct — common case is Tuya gateways that surface multiple
         sub-devices at the same gateway IP with different MACs.

    On match: transfer Y's name + earliest first_seen onto X, re-point any
    devices.mac FK from Y to X, then DELETE Y. The devices.mac re-point is
    critical — without it, device_agent's _update_net_device call on next
    cycle would re-INSERT Y as a ghost.

    Returns count of merges performed.
    """
    fresh_cutoff = now - timedelta(minutes=5)   # NEW must be alive this scan
    silent_cutoff = now - timedelta(minutes=30)  # OLD must be silent ≥ 30 min (≥ 6 missed scans)
    cur.execute("""
        SELECT new.mac, new.ip, new.vendor, new.first_seen,
               old.mac, old.vendor, old.name, old.first_seen
          FROM net_devices new
          JOIN net_devices old
            ON old.ip = new.ip AND old.mac <> new.mac
         WHERE new.last_seen >= %s
           AND old.last_seen <  %s
    """, (fresh_cutoff, silent_cutoff))
    candidates = cur.fetchall()

    merged = 0
    for new_mac, ip, new_vendor, new_first, old_mac, old_vendor, old_name, old_first in candidates:
        same_vendor    = new_vendor and old_vendor and new_vendor == old_vendor
        # Random predecessor → only merge if NEW has a known, non-random vendor
        # (otherwise it's likely IP reuse via DHCP between unrelated devices)
        random_to_known = (
            old_vendor == 'Locally administered'
            and bool(new_vendor)
            and new_vendor != 'Locally administered'
        )
        if not (same_vendor or random_to_known):
            continue
        # Anti-corruption guard: if both MACs are already tracked as distinct
        # rows in the devices table, they're known to be different physical
        # devices (e.g. Tuya gateway sub-devices sharing an IP). Don't merge.
        cur.execute(
            "SELECT COUNT(DISTINCT mac) FROM devices WHERE mac IN (%s, %s)",
            (new_mac, old_mac)
        )
        if cur.fetchone()[0] >= 2:
            continue
        # The old MAC may already have been deleted by a previous iteration if
        # multiple predecessors collide on one new MAC. Skip if gone.
        cur.execute("SELECT 1 FROM net_devices WHERE mac = %s", (old_mac,))
        if not cur.fetchone():
            continue
        # Transfer name (only if new has none) + earliest first_seen
        cur.execute("""
            UPDATE net_devices
               SET name       = COALESCE(name, %s),
                   first_seen = LEAST(first_seen, %s)
             WHERE mac = %s
        """, (old_name, old_first, new_mac))
        # Re-point devices table FK so device_agent doesn't resurrect old MAC
        cur.execute("UPDATE devices SET mac = %s WHERE mac = %s", (new_mac, old_mac))
        # Delete the ghost
        cur.execute("DELETE FROM net_devices WHERE mac = %s", (old_mac,))
        merged += 1
        print(f"[arp_scan] merged {old_mac} ({old_vendor}) -> {new_mac} ({new_vendor or '?'}) at {ip}")
    return merged


def unicast_probe_missed(cur, online_macs, now):
    """Pass 2 — catch sparse-broadcast responders that ignore arp-scan's
    broadcast ARP requests but DO answer unicast IP traffic once the
    sender knows their MAC.

    Verified affected devices on 2026-05-30 (8 of 14 currently-red
    devices answered unicast ping after MAC pre-seed): Star Projector,
    Aura Air, Ring Doorbell, Aqara FP2, Tuya IR remotes, ESP boards,
    plus various Tuya local devices. Many WiFi-power-saving devices
    only wake on unicast IP traffic addressed directly to them — the
    broadcast ARP packet that arp-scan sends is filtered before they
    notice it.

    The Pass-2 technique:
      1. Look up every MAC seen in net_devices in the last 7 days
         that WASN'T caught by the just-finished broadcast pass.
      2. Pre-seed the kernel's ARP cache with the known MAC so the
         next outbound packet to that IP goes out as unicast.
      3. Send one unicast ping (1 s timeout). If the device replies
         the ping returns 0 → mark online.
      4. Otherwise leave it alone (device genuinely offline; the
         broadcast pass already missed it).

    Returns set of MACs recovered."""
    cutoff_recent = now - timedelta(days=7)
    if online_macs:
        cur.execute(
            "SELECT mac, ip FROM net_devices "
            "WHERE last_online >= %s AND mac != ALL(%s)",
            (cutoff_recent, list(online_macs)),
        )
    else:
        cur.execute(
            "SELECT mac, ip FROM net_devices WHERE last_online >= %s",
            (cutoff_recent,),
        )
    candidates = cur.fetchall()
    recovered = set()
    for mac, ip in candidates:
        # Pre-seed the kernel ARP cache so the next packet to `ip`
        # goes out as unicast to `mac` (skipping the broadcast ARP
        # request that the device would ignore). `ip neigh replace`
        # is local to LXC 104; no traffic on the wire yet.
        subprocess.run(
            ['ip', 'neigh', 'replace', ip, 'lladdr', mac,
             'dev', IFACE, 'nud', 'reachable'],
            capture_output=True,
        )
        r = subprocess.run(
            ['ping', '-c', '1', '-W', '1', ip],
            capture_output=True,
        )
        if r.returncode == 0:
            cur.execute(
                "UPDATE net_devices SET last_seen = %s, last_online = %s "
                "WHERE mac = %s",
                (now, now, mac),
            )
            recovered.add(mac)
    return recovered


def main():
    devices = run_arp()
    now = datetime.now(timezone.utc)
    online_macs = {d[1] for d in devices}
    grace_cutoff = now - timedelta(minutes=ONLINE_GRACE_MIN)

    with psycopg2.connect(**DB) as conn:
        with conn.cursor() as cur:
            for ip, mac, vendor, name in devices:
                cur.execute("""
                    INSERT INTO net_devices (mac, ip, vendor, name, first_seen, last_seen, last_online)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (mac) DO UPDATE SET
                        ip          = EXCLUDED.ip,
                        vendor      = COALESCE(net_devices.vendor, EXCLUDED.vendor),
                        last_seen   = EXCLUDED.last_seen,
                        last_online = EXCLUDED.last_online
                """, (mac, ip, vendor, name, now, now, now))

            # Pass-2 unicast pinger — catches devices in WiFi power-save
            # that ignored the broadcast ARP probes above.
            recovered = unicast_probe_missed(cur, online_macs, now)
            online_macs |= recovered

            # Dedup pass — collapse replaced MACs of existing physical devices
            merged = merge_replaced_macs(cur, now)

            cur.execute("SELECT COUNT(*) FROM net_devices")
            total_ever = cur.fetchone()[0]

            # Count online with grace period: responded this scan OR seen within ONLINE_GRACE_MIN
            cur.execute(
                "SELECT COUNT(*) FROM net_devices WHERE last_online >= %s",
                (grace_cutoff,)
            )
            total_online  = cur.fetchone()[0]
            total_offline = total_ever - total_online

            cur.execute(
                "INSERT INTO net_scans (ts, total_online, total_offline, total_ever_seen) VALUES (%s, %s, %s, %s)",
                (now, total_online, total_offline, total_ever)
            )
        conn.commit()
    print(f"[arp_scan] {now.isoformat()} — online:{total_online} offline:{total_offline} ever:{total_ever} merged:{merged} pass2_recovered:{len(recovered)} (grace:{ONLINE_GRACE_MIN}m)")

if __name__ == '__main__':
    main()
