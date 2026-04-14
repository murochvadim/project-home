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
    result = subprocess.run(
        ['arp-scan', f'--interface={IFACE}', '--localnet', '--retry=2'],
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
    print(f"[arp_scan] {now.isoformat()} — online:{total_online} offline:{total_offline} ever:{total_ever} (grace:{ONLINE_GRACE_MIN}m)")

if __name__ == '__main__':
    main()
