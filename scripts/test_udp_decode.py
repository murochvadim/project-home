import socket, select, time, struct, json, hashlib, sys

sys.path.insert(0, '/opt/device-agent')
from tinytuya.core import AESCipher

with open('/opt/device-agent/devices.json') as f:
    devs = json.load(f)

by_ip = {}
for d in devs:
    ip = d.get('ip')
    key = d.get('key')
    if ip and key:
        by_ip[ip] = d

def decrypt_payload(data, key, version):
    try:
        if len(data) < 20:
            return None
        length = struct.unpack('>I', data[12:16])[0]
        payload = data[16:16+length-8]
        ver = float(version) if version else 3.3
        if ver >= 3.3:
            aes_key = hashlib.md5(('yGAdlopoPVldABfn' + key + 'fybSdxkjJklSDXds').encode()).digest()[:16]
        else:
            aes_key = hashlib.md5(key.encode()).digest()[:16]
        cipher = AESCipher(aes_key)
        decrypted = cipher.decrypt(payload, False, decode_text=False)
        if ver >= 3.3:
            decrypted = decrypted[15:]
        return json.loads(decrypted)
    except Exception:
        return None

socks = []
for p in [6666, 6667]:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('', p))
    s.setblocking(False)
    socks.append(s)

print('Listening 12s, decoding packets...')
decoded = 0
failed = 0
end = time.time() + 12
seen = set()

while time.time() < end:
    readable, _, _ = select.select(socks, [], [], 1.0)
    for sock in readable:
        data, (ip, _) = sock.recvfrom(4096)
        dev = by_ip.get(ip)
        if not dev or ip in seen:
            continue
        seen.add(ip)
        result = decrypt_payload(data, dev['key'], dev.get('version', '3.3'))
        name = dev.get('name', '?')[:30]
        dtype = dev.get('device_type', '?')
        if result:
            print('  OK  ' + ip.ljust(18) + ' ' + name.ljust(30) + ' dps=' + str(result))
            decoded += 1
        else:
            print('  ERR ' + ip.ljust(18) + ' ' + name.ljust(30))
            failed += 1

for s in socks:
    s.close()
print('Decoded: ' + str(decoded) + '  Failed: ' + str(failed) + '  Total seen: ' + str(len(seen)))
