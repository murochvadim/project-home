# WhatsApp Media archive on QNAP — copied from the phone, dated, owner where knowable

## Context

WhatsApp media that arrived **before** the agent change has no stored key, so our agent can never
download it. The phone, however, keeps every WhatsApp file **unencrypted** on disk. So: copy the lot
off the phone over USB into one folder on QNAP, name each file by date (+ owner where we can know
it), and use that folder as the pool to pick from for Daily Journal / the media library.

**What is knowable, measured on the live DB (3,161 photos+videos, 96 days, since 2026-03):**

| | count | owner we can attach |
|---|---|---|
| In a **direct chat** | 550 | ✅ the person's name (the chat *is* the person) |
| In a **group** | 2,611 | ⚠ the **group** name only — the individual sender is known for just **64** |
| Sent by me | 148 | ✅ "me" |
| Chat name resolvable | 3,146 / 3,161 | |

The per-sender gap is not our bug: Baileys' bulk history sync omits `key.participant` (already
documented in `WHATSAPP/CLAUDE.md`), and the phone's files don't carry the sender either — that
mapping lives in WhatsApp's encrypted `msgstore.db`, which is unreadable without root.
**Exact** per-sender data for a specific chat is available only via WhatsApp's own *Export chat
(with media)*, whose `.txt` lists `[date, time] Sender: <attached: IMG-…>` — manual, per chat, and
worth doing later only for chats that matter.

**Date is exact**: WhatsApp names its files `IMG-20260901-WA0012.jpg` / `VID-…` / `PTT-…`, plus the
file's mtime.

QNAP has **3.1 TB free**; the archive is expected to be ~5–20 GB. `adb` is already installed
(`C:\android-dev\sdk\platform-tools\adb.exe`); no device is connected yet.

## ⚠ Prerequisite — checked 2026-09-01 with the phone plugged in: NOT reachable yet

- `adb devices` → empty list → **USB debugging is off**.
- Windows shows **no portable device** (`Get-PnpDevice -Class WPD` empty, This PC lists only `OS (C:)`)
  → the phone is in **charging-only** mode, or the cable is charge-only.

One of these must be done on the phone before step A:
- **USB debugging (recommended):** Settings → About phone → Software information → tap *Build number*
  7× → back → Developer options → **USB debugging** on → replug → accept the "Allow USB debugging?"
  prompt. Gives `adb pull`, which is what this plan is built on (reliable for ~10k files, exact counts).
- **File transfer only:** swipe down → tap the *Charging this device via USB* notification → choose
  **File transfer / MTP**. Copying then goes through Windows' portable-device layer, which is slower
  and flakier for thousands of files, and gives no clean count check.

## Plan

**A. Verify on the connected phone (nothing copied yet).** `adb devices`, then locate the media root
— newer Android uses `/sdcard/Android/media/com.whatsapp/WhatsApp/Media/`, older
`/sdcard/WhatsApp/Media/`. List the sub-folders (`WhatsApp Images`, `WhatsApp Video`, `…/Sent`, …),
sample filenames and mtimes, and count files per type. **Read-only** — nothing on the phone is
touched, ever.

**B. Pull to a staging area.** `adb pull` each media sub-folder to a staging dir on the laptop, then
move it onto QNAP. Compare counts before/after so nothing is silently dropped.

**C. Build the index (this is where owner comes from).** A script matches each file to a row in
`whatsapp_messages` by **date from the filename + file mtime + media type**, and writes a manifest
CSV: `file, date, chat, owner, matched|unmatched`. Owner = the DM contact, else the group name, else
`Unknown`. ⚠ Matching is a heuristic: 256 minutes hold more than one media of the same type (~8%),
so those get the chat/owner of the nearest row and are flagged in the manifest rather than pretended
to be exact. Files older than our history (pre-2026-03) simply come out date-only.

**D. Final layout on QNAP** — `/mnt/media/WhatsApp Media/<YYYY-MonthName>/` with names like
`2026-09-01_1319_Maya-Muroch_IMG-20260901-WA0012.jpg` (group example:
`2026-08-30_2114_Kazir-15_VID-20260830-WA0007.mp4`). Same month-folder convention as `Daily Journal`.
Then: add one `media_dir=PV,/mnt/media/WhatsApp Media` line to `/etc/minidlna.conf` on LXC 100 +
rebuild, or TV playback fails exactly as it did for Daily Journal (⚠ live config, not repo-tracked);
the 1-min `auto_scan` cron and the analyzer pick the folder up on their own.

**E. Going forward.** New media keeps its key already, so the agent can save each new photo/video
into the same monthly folder automatically — decided separately (photos+videos only is my
recommendation; stickers/voice/documents are the junk). Part 2 (📓 Save to Journal) then picks from
this same pool.

## Verification

1. File counts: phone → staging → QNAP identical at every hop; total size matches `du`.
2. Manifest sanity: how many files matched a DB row, how many are `Unknown`, how many flagged
   ambiguous — reported as numbers, not claims.
3. Spot-check 5 known photos (e.g. the ones Maya sent today) — the date in the name matches the
   message time and the owner is right.
4. `ls /mnt/media/WhatsApp Media/2026-September/` shows the renamed files; QNAP free space still
   healthy.
5. A file plays on the TV after the minidlna line is added (the Daily-Journal lesson).
6. Nothing on the phone changed: `adb` was used read-only, no deletes, no WhatsApp interaction, and
   **0 messages sent** by the agent.

## Docs

`WHATSAPP/CLAUDE.md`: the archive folder, the naming scheme, that owner is exact for DMs / group-only
for groups (with the 550 vs 2,611 vs 64 numbers and why), the minidlna requirement, and the
Export-chat route if exact per-sender data is ever needed.

---

## Where this stopped (2026-09-01)

Blocked at the prerequisite: the phone never reached the laptop.
- `adb devices` empty with BOTH adb builds, server restarted — and USB debugging WAS enabled and the
  "Allow USB debugging" prompt accepted.
- Windows sees **no** Android / Samsung / MTP / WPD device and no driver-error device, while 9 other
  USB devices enumerate fine → the USB stack works, the phone is not presenting itself.
- Setting the phone's **Default USB configuration → File transfer** did not change it.
→ Conclusion: charge-only cable (or that port). **Next time:** try the phone's own cable in a port on
the laptop itself, or skip the cable and use **Wireless debugging** (Developer options → Wireless
debugging → "Pair device with pairing code" → `adb pair <ip:port>` with the 6-digit code, then
`adb connect <ip:port>` using the port shown at the top of that screen).

Nothing was copied, and nothing on the phone was touched.
