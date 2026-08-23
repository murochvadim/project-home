# SPARE_SMARTPHONE — Pixel 2 XL → de-Googled LineageOS (spare node)

A **Google Pixel 2 XL** flashed to de-Googled **LineageOS** as a general-purpose spare — a clean
Android device to repurpose for any project use later (wall panel, second camera/IP-cam node,
sensor→MQTT bridge, kiosk, test device). Sibling of [FR_SMARTPHONE](../FR_SMARTPHONE/CLAUDE.md) (the
A71 entrance-FR phone), but this one is a **spare with no assigned role yet**.

**Status: ✅ LineageOS 22.2 (20260806 = Android 15) INSTALLED + set up (2026-08-23).** De-Googled
(Google sign-in skipped in setup). Ready to assign a purpose.

## The device (verified from its own bootloader/fastboot)
- **Model: Pixel 2 XL**, codename **`taimen`**.
- **Variant SKU `G011C`** = the **unlocked / international** model (carrier `unknown`) — *not* a Verizon
  unit, so the bootloader is fully unlockable. (Verizon `G011B` units are permanently locked → impossible.)
- Serial **`712KPED1259460`**. UFS Samsung 64 GB, DDR Hynix, HW rev_10.
- Shipped on **Android 8.1** (`OPM2.171026.006.H1`, bootloader `TMZ12g`) — the oldest firmware; needed a
  firmware bump before LineageOS (below).

## Why a Pixel is EASY vs the Samsung A71 ([[project-fr-smartphone-flash]])
No Odin, no Thor, no Knox/RMM timer, no misc/vbmeta fighting. Standard **`fastboot` + `adb`** the whole
way. LineageOS still supports `taimen` — latest **22.2** (Android 15), pulled live from the API
(`https://download.lineageos.org/api/v2/devices/taimen/builds`), so it's a current OS on a 2017 phone.

## How it was flashed (the working method — reuse this for any Pixel)
Driven from the **Proxmox host / mini-PC `192.168.1.101`** over SSH (Linux `fastboot` = no Windows
driver hassle — see the driver note below). Files staged in `/root/pixel-flash/`.

1. **On the phone (only the phone-side steps a human must do):** enable Developer options → **OEM
   unlocking** + **USB debugging**. (`sys.oem_unlock_allowed` must read `1`.)
2. **Unlock bootloader** — `fastboot flashing unlock` **AND** `fastboot flashing unlock_critical`
   (the second is REQUIRED — the bootloader partition is a "critical partition"; without `unlock_critical`
   the firmware flash fails `Writing 'bootloader_b' FAILED: Flashing is not allowed for Critical Partitions`).
   Each needs an on-device confirm: **Volume-Up to "Unlock the bootloader" → Power** (pressing Power on the
   default "Do not unlock" = `canceled`). ⚠ **`fastboot getvar unlocked` misreports `no` on taimen even when
   unlocked** — trust the phone's own **`DEVICE STATE - unlocked`** on the bootloader screen, or the fact
   that flashing succeeds (buggy bootloader-mode USB, per the LineageOS wiki).
3. **Firmware update 8.1 → Android 11** (LineageOS 22 requires **Android 11 firmware**): flash Google's
   latest `taimen` stock **factory image** (`taimen-rp1a.201005.004.a1-factory-2f5c4987.zip`) via its
   `flash-all.sh` → updates **bootloader (→`TMZ30m`) + radio + boot + dtbo + vbmeta + system**.
   ⚠ `flash-all` **failed near the end** on `system_a` = *"Requested download size is more than max allowed"*
   (device `max-download-size` = **512 MB**, the 2.5 GB chunk wasn't split) and stopped **before flashing
   `vendor`**. Fix = flash the remaining critical partition directly: extract `image-taimen-*.zip`, then
   `fastboot flash vendor vendor.img` (326 MB, fits the buffer) to the active slot. (`system_other`/inactive
   slot is optional — skipped.) Slot **b** then had a complete Android 11.
4. **Install LineageOS.** `fastboot flash boot boot.img` (LineageOS recovery) → boot recovery
   (**Volume-Down to "Recovery mode" → Power** in the bootloader menu; `fastboot reboot recovery` does NOT
   work on taimen — it bounces back to the bootloader) → in recovery: **Factory reset → Format data**, then
   **Apply update → Apply from ADB** → `adb -d sideload lineage-22.2-…-taimen.zip` → **"install additional
   packages?" = No** (keeps it de-Googled) → **Reboot system now**.
   - ⚠ **If the recovery touch menu is uncooperative:** the fallback that works is `adb -d sideload` once
     "Apply from ADB" is selected. A fully menu-free alternative was prepped and is worth knowing: extract
     the ROM's partition images with **`payload-dumper-go`** (the zip is `payload.bin`-based → yields
     `boot/dtbo/vbmeta/system/vendor`) and `fastboot flash` each to the active slot — bypasses recovery
     entirely. (Not needed in the end — the sideload went through.)
5. **First boot** 2–5 min → LineageOS Welcome → **skip Google** in setup.

### Windows driver note (why the mini-PC, not the laptop)
The laptop's `adb` saw the phone, but in **bootloader/fastboot mode** Windows showed it as
`VID_18D1&PID_4EE0` **Status = Error** (missing "Android Bootloader Interface" driver) → `fastboot devices`
empty. Linux (the mini-PC) has no such gap, so all fastboot ran there. For any future Pixel flash, use the
mini-PC for the fastboot parts.

## Staged files (mini-PC `/root/pixel-flash/`) — cleanup
`taimen-…-factory-*.zip` (1.7 GB) + `lineage-22.2-…zip` (928 MB) + extracted `img/` + `los_imgs/` +
`payload-dumper-go`. Safe to delete now that the phone boots — ~3–4 GB. (Separately, the A71's ~20 GB
firmware in `/root/firmware/` is also stale — see [[project-fr-smartphone-flash]].)

## Next (when a purpose is chosen)
Same options as any de-Googled node: F-Droid apps / `adb install`, Termux (Python/MQTT on-device),
kiosk browser, IP-cam, sensor→MQTT. Static IP + note it here when assigned. Phone serial `712KPED1259460`.
