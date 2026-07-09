# Live Jura statistics read, exactly per AlexxIT/Jura:
#   key = first byte of BLE mfg-data payload (company id 171)
#   write encrypt([0x2A,00,01,FF,FF]) to STATS_COMMAND -> poll until ready
#   read STATS_DATA, decrypt -> 3-byte counters indexed by product @Code
# The stats REQUEST is a read-command (no brewing).
import asyncio
from bleak import BleakScanner, BleakClient
ADDR="D5:B2:75:CC:85:CB"; NAME="TT214H BlueFrog"; BASE="-ab2e-2548-c435-08c300000710"
STATS_CMD=f"5a401533{BASE}"; STATS_DATA=f"5a401534{BASE}"
JURA_NUM1=[14,4,3,2,1,13,8,11,6,15,12,7,10,5,0,9]; JURA_NUM2=[10,6,13,12,14,11,1,9,15,7,0,5,3,2,4,8]
def m(i): return i%256
def sh(dn,nc,kL,kR):
    i5=m(nc>>4); t1=JURA_NUM1[m(dn+nc+kL)%16]; t2=JURA_NUM2[m(t1+kR+i5-nc-kL)%16]
    t3=JURA_NUM1[m(t2+kL+nc-kR-i5)%16]; return m(t3-nc-kL)%16
def encdec(data,key):
    kL,kR=key>>4,key&0xF; nib=0; out=bytearray(len(data))
    for o in range(len(data)):
        out[o]=(sh(data[o]>>4,nib,kL,kR)<<4)|sh(data[o]&0xF,nib+1,kL,kR); nib+=2
    return out
def encrypt(data,key):
    b=bytearray(data); b[0]=key; return encdec(b,key)
PRODUCTS={1:"Ristretto",2:"Espresso",3:"Coffee",4:"Cappuccino",6:"Espresso Macchiato",
 7:"Latte Macchiato",10:"Milk Portion",13:"Hotwater",17:"2 Ristretti",18:"2 Espressi",
 19:"2 Coffee",46:"Flat White",15:"Powder product"}

async def main():
    found=await BleakScanner.discover(timeout=12.0, return_adv=True)
    target=None; key=None
    for addr,(dev,adv) in found.items():
        if addr.upper()==ADDR.upper() or (dev.name or "")==NAME:
            target=dev
            md=adv.manufacturer_data or {}
            print("manufacturer_data:", {cid:bytes(v).hex() for cid,v in md.items()})
            if 171 in md and md[171]: key=md[171][0]
            elif md: key=list(md.values())[0][0]
            break
    if not target: print("BlueFrog not found (machine on + near laptop?)"); return
    if key is None: key=0xAB
    print(f"Found {target.name} | KEY = 0x{key:02X}\n")
    async with BleakClient(target, timeout=20.0) as c:
        # 1) send stats request
        req=encrypt([0x2A,0x00,0x01,0xFF,0xFF], key)
        await c.write_gatt_char(STATS_CMD, bytes(req), response=True)
        print("stats request sent, waiting for ready ...")
        # 2) poll STATS_COMMAND until byte[1] != 0xE1 (225 = not ready)
        ready=False
        for i in range(25):
            st=await c.read_gatt_char(STATS_CMD)
            if len(st)>1 and st[1]!=0xE1:
                print(f"ready after {i} polls (status byte1=0x{st[1]:02X})"); ready=True; break
            await asyncio.sleep(0.8)
        if not ready: print("machine never signalled ready");
        # 3) read + decrypt stats data
        raw=await c.read_gatt_char(STATS_DATA)
        dec=encdec(list(raw), key)
        print("STATS_DATA raw:", bytes(raw).hex())
        print("decrypted     :", bytes(dec).hex())
        counts=[int.from_bytes(dec[i:i+3],"big") for i in range(0,len(dec)-2,3)]
        counts=[0 if x==0xFFFF else x for x in counts]
        print(f"\n>>> TOTAL products dispensed: {counts[0] if counts else '?'}")
        print(">>> Per-drink counts:")
        for i,cnt in enumerate(counts):
            if i==0: continue
            nm=PRODUCTS.get(i)
            if nm and cnt: print(f"      {nm:<20} {cnt}")
asyncio.run(main())
