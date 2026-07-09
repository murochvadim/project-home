# Capture all readable Jura characteristics into a labeled file, so two captures
# (e.g. machine ON vs OFF) can be diffed to find the state bytes. Read-only.
import asyncio, sys
from bleak import BleakScanner, BleakClient
ADDR="D5:B2:75:CC:85:CB"; NAME="TT214H BlueFrog"
label = sys.argv[1] if len(sys.argv)>1 else "cap"
outpath = f"cap_{label}.txt"

async def main():
    print(f"[{label}] scanning 12s ...")
    devs = await BleakScanner.discover(timeout=12.0)
    target=None
    for d in devs:
        if (d.address or "").upper()==ADDR.upper() or (d.name or "")==NAME:
            target=d; break
    if not target:
        print("NOT FOUND — machine powered + within ~5 m of laptop?"); return
    lines=[]
    async with BleakClient(target, timeout=20.0) as c:
        for s in c.services:
            if not s.uuid.lower().startswith("5a4015"): continue
            for ch in s.characteristics:
                if "read" not in ch.properties: continue
                short = ch.uuid[4:8]
                try:
                    raw = await asyncio.wait_for(c.read_gatt_char(ch.uuid), timeout=6.0)
                    hexs = " ".join(f"{x:02X}" for x in raw)
                    lines.append(f"{short}: {hexs}")
                except Exception as e:
                    lines.append(f"{short}: <read failed: {type(e).__name__}>")
    with open(outpath,"w") as f: f.write("\n".join(lines)+"\n")
    print(f"[{label}] wrote {len(lines)} chars -> {outpath}")
    for ln in lines: print("  "+ln)
asyncio.run(main())
