import asyncio
from bleak import BleakScanner, BleakClient
ADDR="D5:B2:75:CC:85:CB"; NAME="TT214H BlueFrog"; BASE="-ab2e-2548-c435-08c300000710"
MACHINE_STATUS=f"5a401524{BASE}"; P_MODE=f"5a401529{BASE}"
N1=[14,4,3,2,1,13,8,11,6,15,12,7,10,5,0,9]; N2=[10,6,13,12,14,11,1,9,15,7,0,5,3,2,4,8]
def m(i): return i%256
def sh(dn,nc,kL,kR):
    i5=m(nc>>4); t1=N1[m(dn+nc+kL)%16]; t2=N2[m(t1+kR+i5-nc-kL)%16]; t3=N1[m(t2+kL+nc-kR-i5)%16]
    return m(t3-nc-kL)%16
def encdec(data,key):
    kL,kR=key>>4,key&0xF; nib=0; out=bytearray(len(data))
    for o in range(len(data)):
        out[o]=(sh(data[o]>>4,nib,kL,kR)<<4)|sh(data[o]&0xF,nib+1,kL,kR); nib+=2
    return out
def enc(data,key):
    b=bytearray(data); b[0]=key; return encdec(b,key)
ALERTS={0:"insert tray",1:"FILL WATER (tank empty)",2:"empty grounds",3:"empty tray",
 4:"insert coffee bin",8:"fill system",10:"NO BEANS",13:"coffee ready",18:"coffee rinsing",
 21:"fill powder",24:"remove water tank",25:"press rinse",32:"filter",33:"descale",
 34:"cleaning",35:"cappu rinse",47:"switch-off delay"}
async def main():
    found=await BleakScanner.discover(timeout=12.0, return_adv=True)
    target=None; key=None
    for addr,(dev,adv) in found.items():
        if addr.upper()==ADDR.upper() or (dev.name or "")==NAME:
            target=dev; md=adv.manufacturer_data or {}
            key=(md.get(171) or (list(md.values())[0] if md else b"\x2a"))[0]; break
    if not target: print("BlueFrog not found"); return
    async with BleakClient(target, timeout=20.0) as c:
        for i in range(4):
            try:
                await c.write_gatt_char(P_MODE, bytes(enc([0x00,0x7F,0x80], key)), response=True)
            except Exception as e:
                print("heartbeat err:", e)
            await asyncio.sleep(1.0)
            raw=await c.read_gatt_char(MACHINE_STATUS)
            dec=encdec(list(raw), key)
            active=[f"{b}:{n}" for b,n in ALERTS.items() if ((b>>3)+1)<len(dec) and (dec[(b>>3)+1]>>(7-(b&7)))&1]
            nowater = ((1>>3)+1)<len(dec) and (dec[(1>>3)+1]>>(7-(1&7)))&1
            print(f"[{i}] status={bytes(dec).hex()}  alerts={active or 'none'}  NO_WATER={'YES' if nowater else 'no'}")
asyncio.run(main())
