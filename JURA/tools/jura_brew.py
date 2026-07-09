# Send a brew/dispense command to the Jura J6 (EF557), per its machine file.
# ⚠ PHYSICAL ACTION — the machine dispenses immediately. Put a cup under the spout.
#
# Usage:  python jura_brew.py <product_code_hex> [water_ml] [temp]
#   product codes (EF557 / J6): 01 Ristretto · 02 Espresso · 03 Coffee ·
#     04 Cappuccino · 06 Espresso Macchiato · 07 Latte · 0A Milk · 0D Hot water ·
#     0F Powder · 11 2 Ristretti · 12 2 Espressi · 13 2 Coffee · 2E Flat White
#   temp: 00 Low · 01 Normal · 02 High   (default 01)
#
# Packet (validated live 2026-07-10 with hot water = 0D): data[1]=code,
# data[4]=water_ml/5 (WATER_AMOUNT arg F4, step 5), data[7]=temp (TEMPERATURE
# arg F7), data[0]=data[17]=key; encrypt -> write START_PRODUCT 5a401525.
# Simple coffee/water drinks share this layout; milk drinks (cappuccino/latte)
# carry extra args in the machine file — extend from documents/xml/EF557/1.0.xml.
import asyncio, sys
from bleak import BleakScanner, BleakClient
ADDR="D5:B2:75:CC:85:CB"; NAME="TT214H BlueFrog"; BASE="-ab2e-2548-c435-08c300000710"
START_PRODUCT=f"5a401525{BASE}"
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

async def main():
    code=int(sys.argv[1],16) if len(sys.argv)>1 else 0x0D
    water=int(sys.argv[2]) if len(sys.argv)>2 else 220
    temp=int(sys.argv[3],16) if len(sys.argv)>3 else 0x01
    found=await BleakScanner.discover(timeout=12.0, return_adv=True)
    target=None; key=None
    for addr,(dev,adv) in found.items():
        if addr.upper()==ADDR.upper() or (dev.name or "")==NAME:
            target=dev; md=adv.manufacturer_data or {}
            key=(md.get(171) or (list(md.values())[0] if md else b"\x2a"))[0]; break
    if not target: print("BlueFrog not found — machine on + near laptop?"); return
    data=bytearray(18); data[1]=code; data[4]=water//5; data[7]=temp; data[0]=key; data[17]=key
    enc=encdec(data,key)
    print(f"key=0x{key:02X} code=0x{code:02X} water={water}ml temp=0x{temp:02X}")
    print(f"plaintext={data.hex()} encrypted={bytes(enc).hex()}")
    async with BleakClient(target, timeout=20.0) as c:
        try:
            await asyncio.wait_for(c.write_gatt_char(START_PRODUCT, bytes(enc), response=True), timeout=12.0)
            print(">>> WRITE ACCEPTED — machine dispensing.")
        except asyncio.TimeoutError:
            print(">>> WRITE TIMED OUT — machine did not ACK.")
        except Exception as e:
            print(">>> WRITE ERROR:", type(e).__name__, e)
asyncio.run(main())
