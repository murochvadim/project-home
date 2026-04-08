"""Capture one packet per device and show raw structure — no decryption."""
import socket, select, time, struct, json

with open('/opt/device-agent/devices.json') as f:
    devs = json.load(f)

by_ip = {d['ip']: d for d in devs if d.get('ip')}

COMMANDS = {
    0x00: 'UDP', 0x03: 'HEART_BEAT', 0x08: 'STATUS',
    0x09: 'SET', 0x0a: 'HEART_BEAT_RESP', 0x12: 'BROADCAST_LAN_STATUS',
    0x13: 'BROADCAST_LAN_HEARTBEAT', 0x18: 'UDP_NEW',
}

socks = []
for p in [6666, 6667]:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('', p))
    s.setblocking(False)
    socks.append(s)

end = time.time() + 8
seen = {}  # ip -> first packet

while time.time() < end:
    readable, _, _ = select.select(socks, [], [], 1.0)
    for sock in readable:
        data, (ip, _) = sock.recvfrom(4096)
        if ip not in seen:
            seen[ip] = data

for s in socks:
    s.close()

print('Packets captured per device:')
for ip, data in sorted(seen.items()):
    dev = by_ip.get(ip, {})
    name = dev.get('name', 'unknown')[:25]
    ver = dev.get('version', '?')

    if len(data) >= 16:
        magic = data[:4].hex()
        seq = struct.unpack('>I', data[4:8])[0]
        cmd = struct.unpack('>I', data[8:12])[0]
        length = struct.unpack('>I', data[12:16])[0]
        cmd_name = COMMANDS.get(cmd, f'0x{cmd:02x}')
        payload_raw = data[16:16+length-8] if len(data) >= 16+length-8 else b''

        # Try plain JSON (v3.1 unencrypted)
        try:
            plain = json.loads(payload_raw)
            state = 'PLAIN:' + str(plain)
        except Exception:
            # Show first 32 bytes hex
            state = 'ENC:' + payload_raw[:32].hex()

        print(f'  {ip:18} v{ver}  cmd={cmd_name:25} len={length:4}  {name:25} | {state[:80]}')
    else:
        print(f'  {ip:18} too short: {len(data)} bytes | {name}')
