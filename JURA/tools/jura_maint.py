import asyncio
from bleak import BleakScanner, BleakClient
ADDR="D5:B2:75:CC:85:CB"; NAME="TT214H BlueFrog"; BASE="-ab2e-2548-c435-08c300000710"
STATS_CMD=f"5a401533{BASE}"; STATS_DATA=f"5a401534{BASE}"
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
async def read(c,key,t):
    await c.write_gatt_char(STATS_CMD, bytes(enc([0x2A,(t>>8)&0xFF,t&0xFF,0xFF,0xFF],key)), response=True)
    for _ in range(20):
        st=await c.read_gatt_char(STATS_CMD)
        if len(st)>1 and st[1]!=0xE1: break
        await asyncio.sleep(0.6)
    dec=encdec(list(await c.read_gatt_char(STATS_DATA)),key)
    return dec
async def main():
    found=await BleakScanner.discover(timeout=12.0, return_adv=True)
    target=None; key=None
    for addr,(dev,adv) in found.items():
        if addr.upper()==ADDR.upper() or (dev.name or "")==NAME:
            target=dev; md=adv.manufacturer_data or {}
            key=(md.get(171) or (list(md.values())[0] if md else b"\x2a"))[0]; break
    if not target: print("BlueFrog not found"); return
    async with BleakClient(target, timeout=20.0) as c:
        for t in (0x0008,0x0004):
            dec=await read(c,key,t)
            print(f"\n=== dataset 0x{t:04X} ===")
            print("raw bytes:", " ".join(f"{b:02X}" for b in dec[:24]))
            print("as bytes :", [b for b in dec[:12]])
            print("as u16   :", [int.from_bytes(dec[i:i+2],'big') for i in range(0,24,2)])
            print("as 3byte :", [int.from_bytes(dec[i:i+3],'big') for i in range(0,24,3)])
asyncio.run(main())
