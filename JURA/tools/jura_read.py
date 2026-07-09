# Read-only Jura (BlueFrog) probe from the laptop's Bluetooth. Non-destructive:
# scans, connects, reads readable characteristics, decrypts with the Jura key,
# and parses the statistics counters. NOTHING is written to the machine.
import asyncio, sys
from bleak import BleakScanner, BleakClient

ADDR = "D5:B2:75:CC:85:CB"
NAME = "TT214H BlueFrog"
BASE = "-ab2e-2548-c435-08c300000710"
def uuid(x): return f"5a4015{x}{BASE}"
STATS_UUID = uuid("31")            # statistics (56 bytes in Phase 1)

JURA_NUM1 = [14,4,3,2,1,13,8,11,6,15,12,7,10,5,0,9]
JURA_NUM2 = [10,6,13,12,14,11,1,9,15,7,0,5,3,2,4,8]
def m256(i): return i % 256
def shuf(dn, nc, kL, kR):
    i5 = m256(nc >> 4)
    t1 = JURA_NUM1[m256(dn + nc + kL) % 16]
    t2 = JURA_NUM2[m256(t1 + kR + i5 - nc - kL) % 16]
    t3 = JURA_NUM1[m256(t2 + kL + nc - kR - i5) % 16]
    return m256(t3 - nc - kL) % 16
def encdec(data, key):
    kL, kR = key >> 4, key & 0x0F
    nib = 0; out = bytearray(len(data))
    for off in range(len(data)):
        d = data[off]
        rL = shuf(d >> 4, nib, kL, kR); nib += 1
        rR = shuf(d & 0x0F, nib, kL, kR); nib += 1
        out[off] = (rL << 4) | rR
    return out
def hx(b): return " ".join(f"{x:02X}" for x in b)
def cnt3(b, i):
    o = i*3
    return None if o+2 >= len(b) else (b[o]<<16)|(b[o+1]<<8)|b[o+2]

async def main():
    print("Scanning 15s for the BlueFrog ...")
    key = None; target = None
    def cb(dev, adv):
        nonlocal key
        for cid in (adv.manufacturer_data or {}):
            k = cid & 0xFF
            if key is None: key = k
    devs = await BleakScanner.discover(timeout=15.0, detection_callback=cb)
    for d in devs:
        if (d.address or "").upper() == ADDR.upper() or (d.name or "") == NAME:
            target = d; break
    if not target:
        print("NOT FOUND. Is the machine powered on and within ~5 m of the laptop?")
        print("Nearby devices seen:", [f"{d.name}" for d in devs if d.name][:12])
        return
    if key is None: key = 0xAB
    print(f"Found {target.name} @ {target.address}  | key=0x{key:02X}")

    async with BleakClient(target, timeout=20.0) as c:
        print("Connected. Services / readable characteristics:")
        readable = []
        for s in c.services:
            if not s.uuid.lower().startswith("5a4015"): continue
            for ch in s.characteristics:
                props = ",".join(ch.properties)
                short = ch.uuid[4:8]
                print(f"  {short}  [{props}]")
                if "read" in ch.properties: readable.append((short, ch.uuid))
        print()
        for short, u in readable:
            try:
                raw = await asyncio.wait_for(c.read_gatt_char(u), timeout=7.0)
                dec = encdec(bytearray(raw), key)
                print(f"[{short}] {len(raw)}B raw: {hx(raw)}")
                print(f"       dec: {hx(dec)}")
                if short == "31":
                    print(f"       >> total dispensed = {cnt3(dec,0)}")
                    print("       >> counters[0..15]:", [cnt3(dec,i) for i in range(16)])
                print()
            except asyncio.TimeoutError:
                print(f"[{short}] READ TIMED OUT (7s) — this char doesn't answer on this dongle\n")
            except Exception as e:
                print(f"[{short}] read error: {e}\n")

asyncio.run(main())
