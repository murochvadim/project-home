# YouTube Playlist → Media Player Integration

**Status as of 2026-05-27:** ✅ Phase 0 complete — yt-dlp installed on LXC 100, test public video downloaded as `.m4a`, verified end-to-end through 🔍 Unassigned → playlist → Cast → soundbar. Phase 1 (dashboard URL→download form) is the next milestone. Cookie path for private playlists still pending (Phase 1.5).

---

## Goal

Curate music on YouTube (easy interface: phone, search, drag-add). Push button on dashboard → all tracks land in `/mnt/media/Music/<folder>/` on QNAP → play through existing Cast → Soundbar pipeline.

## Architecture sketch

```
┌──────────────────────────────────────────────────────────────────┐
│  YouTube (curation surface — easy on phone)                      │
│  ▸ Build playlist by tapping ⨁ on videos                         │
│  ▸ Share → Copy link → https://...playlist?list=PL...            │
└──────────────────────────────┬───────────────────────────────────┘
                               │ paste URL into dashboard
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Media tab — "Download from YouTube" card                        │
│  ▸ URL: [https://...playlist?list=PL...                        ] │
│  ▸ Target folder: [Road Trip 2026                              ] │
│  ▸ Audio quality: [● bestaudio (m4a)  ○ MP3 (needs ffmpeg)     ] │
│  ▸ Create project playlist when done: [✓]                        │
│  ▸ [▶ Download]                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ POST /api/media/yt-dlp/start
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  LXC 100 — yt-dlp subprocess                                     │
│  Writes to /mnt/media/Music/<folder>/01..N.m4a                   │
│  Streams progress lines back to dashboard via SSE                │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  On completion (optional auto-add)                               │
│  POST /api/playlists with {name, items: [...]}                   │
│  Project playlist appears in Playlists card                      │
│  ▸ Click ▶ Play → Cast → Soundbar                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Why LXC 100, not laptop

| | Laptop | LXC 100 |
|---|---|---|
| Where files end up | Windows → manual SMB copy to QNAP → only then 🔍 Unassigned sees them | Direct write to `/mnt/media/Music/` → instant Unassigned visibility |
| Trigger from phone / tablet | No (laptop has to be on AND used) | Yes (dashboard UI works from any device on LAN) |
| Self-update when YouTube breaks | Easy (you're already on the laptop) | One-liner cron `pip install -U yt-dlp` weekly |
| Bundled with media stack | Awkward — different host | Sits next to player/analyzer/ingest — same host that serves files |

LXC 100 already owns the audio pipeline (player_service.py, Cast, the soundbar). yt-dlp fits there cleanly.

---

## Two input modes (both supported by yt-dlp)

### A. URL → expand playlist → download each track
Input: `https://www.youtube.com/playlist?list=PLxxx`
yt-dlp behavior: reads playlist track list → downloads each video one-by-one as `01 - Title.m4a`, `02 - Title.m4a`, …
Quality: perfect — you picked the videos yourself.

### B. Text list → search-then-download
Input:
```
Bohemian Rhapsody — Queen
Wonderwall — Oasis
Snowflake — Несчастный случай
```
yt-dlp behavior: for each line, runs `ytsearch1:"<line>"` → grabs the top YouTube hit → downloads.
Quality risk: top hit isn't always the right version (could be cover, karaoke, lyric video). For curated music libraries, prefer mode A.

**Recommended Phase 1 UI**: support both input modes in the same form. Backend routes to the right yt-dlp invocation.

---

## What's installed today (2026-05-18)

| Component | Where | Status |
|---|---|---|
| yt-dlp 2026.03.17 | Laptop (Windows), `pip install --user` | ✓ installed, works |
| **yt-dlp 2026.03.17** | **LXC 100, `pip3 install --user`** | ✅ **installed 2026-05-27 — Phase 0 verified** |
| **ffmpeg** | **LXC 100, already system-installed** | ✅ **present out of the box on LXC 100 — Phase 2 MP3 conversion + m4a FixupM4a both unlocked** |
| Cookie file | nowhere | ✗ blocker for private playlists — see below |

## What was actually installed on LXC 100 (2026-05-27)

```bash
ssh root@192.168.1.138 'pip3 install --user --upgrade yt-dlp'
ssh root@192.168.1.138 'mkdir -p /mnt/media/Music/_yt_test'
```

Versions confirmed:
- Python 3.10.12 + pip 22.0.2 (system)
- yt-dlp 2026.03.17 (in `/root/.local/bin/yt-dlp` — but always invoke via `python3 -m yt_dlp` to dodge the PATH-warning)
- ffmpeg (system-installed, found at `/usr/bin/ffmpeg`)

**Test artifact**: one file in `C:\Users\muroc\Downloads\Несчастный случай： Снежинка (Квартирник у Маргулиса).webm` from the test command. Plays in VLC / Chrome / Edge (Opus codec, .webm container). Not in Windows Media Player.

---

## Cookie blocker (private playlists)

### What happened in concept session

Test URL: `https://www.youtube.com/playlist?list=PLB38FEB8BC8C1E8CE` (user's private playlist)

- Anonymous yt-dlp request → YouTube returns "**The playlist does not exist**" (standard reply when a stranger asks for a private list)
- Tried `--cookies-from-browser chrome` → **failed**: Chrome's cookie DB locked because Chrome was running
- Tried `--cookies-from-browser edge` → **failed**: Edge's cookie DB locked because `msedgewebview2.exe` (Outlook / Teams / VS Code / Claude Code use it) holds it

### When you're back at the laptop — verify the cookie path

1. Quit Chrome **completely** (taskbar tray icon too)
2. Run:
   ```
   python -m yt_dlp --cookies-from-browser chrome --flat-playlist --skip-download \
     --print-to-file "%(playlist_index)s|%(id)s|%(title)s|%(duration_string)s" \
     C:/tmp_playlist.txt \
     "https://www.youtube.com/playlist?list=PLB38FEB8BC8C1E8CE"
   ```
3. `head C:/tmp_playlist.txt` — should list every track in your playlist.

### For LXC 100 (no browser there)

The LXC has no browser → must use a **file-based cookie**:

1. Install browser extension **"Get cookies.txt LOCALLY"** (Chrome/Edge/Firefox — open-source, doesn't phone home)
2. Log into youtube.com
3. Click the extension → save `cookies.txt`
4. Upload to LXC 100 (dashboard form, or `scp` once)
5. yt-dlp uses it via `--cookies /path/to/cookies.txt`
6. **Maintenance**: cookies rotate every 6–12 months. When private playlists start returning "does not exist" again, repeat steps 1-4.

---

## Deployment roadmap

| Phase | Effort | What it gives you |
|---|---|---|
| **0 — proof on LXC** | ✅ done 2026-05-27 | `pip3 install --user yt-dlp` on LXC 100; manual download of test video to `/mnt/media/Music/_yt_test/`; verified 🔍 Unassigned shows it, Cast → soundbar plays it. End-to-end chain confirmed. |
| **1 — dashboard button** | ~1-2 h | New endpoint `POST /api/media/yt-dlp` on player_service.py; new card on Media tab with URL input + Download button + simple progress display |
| **1.5 — cookie upload** | ~30 min | Form to upload `cookies.txt` once; server stores in `/etc/yt-dlp/cookies.txt`; every download uses it. Re-upload when expired. |
| **2 — niceties** | later | Weekly cron `pip install -U yt-dlp`; text-list input mode (mode B); auto-add to project playlist on completion; re-run-to-sync mode (downloads only new tracks via `--download-archive`). Note: ffmpeg requirement for MP3 conversion already satisfied — was system-installed on LXC 100. |

## ⭐ Canonical yt-dlp invocation (m4a, no re-encoding)

Phase 0 confirmed the right format-selector combo. `bestaudio` defaults to format 251 (Opus / WebM) which the MEDIA library doesn't recognize (`.webm` is NOT in its supported audio list). To get a clean `.m4a` AAC file with no re-encoding, use this command shape for every download:

```bash
python3 -m yt_dlp \
  --no-playlist \
  -f "bestaudio[ext=m4a]/bestaudio" \
  --extract-audio --audio-format m4a \
  -o "/mnt/media/Music/<folder>/%(playlist_index)03d - %(title)s.%(ext)s" \
  "<URL>"
```

- `bestaudio[ext=m4a]/bestaudio` — first try the m4a-container stream (format 140, AAC), fall back to anything if YouTube didn't publish one.
- `--extract-audio --audio-format m4a` — even when the source is m4a-native (format 140), yt-dlp runs ffmpeg's **FixupM4a** to clean up the container metadata before writing. Output: "Not converting audio; file is already in target format m4a" — fast, lossless.
- For single videos (ambient / one-off tracks): use `--no-playlist`. For playlists: drop that flag and `%(playlist_index)03d - %(title)s.%(ext)s` produces `001 - Title.m4a`, `002 - Title.m4a`, etc.

This is the format the Phase 1 endpoint will use by default.

---

## Phase 0 — exact commands

Once back at the system, on LXC 100:

```bash
ssh root@192.168.1.138 'pip install --user yt-dlp'
ssh root@192.168.1.138 'mkdir -p /mnt/media/Music/_yt_test'
ssh root@192.168.1.138 \
  'python3 -m yt_dlp --no-playlist -f bestaudio \
    -o "/mnt/media/Music/_yt_test/%(title)s.%(ext)s" \
    "https://www.youtube.com/watch?v=3IA78WmILoA"'
```

Then on the dashboard Media tab → 🔍 Unassigned → drill into `Music/_yt_test/` → confirm the file is there → check it plays via Cast.

If that works, move to Phase 1.

---

## Phase 1 — dashboard endpoint sketch

### `POST /api/media/yt-dlp/start` (on player_service.py)

Request body:
```json
{
  "url": "https://www.youtube.com/playlist?list=PL...",
  "folder": "Road Trip 2026",
  "audio_only": true,
  "create_playlist": true
}
```

Behavior:
1. Validate `folder` (no `..`, no special chars — same allowlist pattern as `safe_path`)
2. Spawn `yt-dlp` subprocess with output template `/mnt/media/Music/<folder>/%(playlist_index)03d - %(title)s.%(ext)s`
3. Stream stdout to a session-id-keyed queue
4. Return `{job_id: "..."}`

### `GET /api/media/yt-dlp/progress/:job_id` (SSE)
- Stream `[download] xx.x% of N MiB at S KiB/s ETA HH:MM:SS` lines
- On `[download] 100%` for each track, emit one "track-complete" event with the filename
- On overall completion, emit "done" with count + total size

### On dashboard side
- Card with URL textarea + folder name input + ▶ Download button
- Progress list: pending / downloading (with bar) / done per track
- On completion: toast → optionally call `POST /api/playlists` to create the project playlist with all tracks

### Cookie support (Phase 1.5)
- `POST /api/media/yt-dlp/cookies` — accepts a file upload, writes to `/etc/yt-dlp/cookies.txt` on LXC 100 (mode 0600)
- Every download call adds `--cookies /etc/yt-dlp/cookies.txt` when the file exists

---

## Open decisions for when you return

| Question | Default suggested |
|---|---|
| Filename format | `01 - Title.m4a` (playlist index + title) |
| What if a track is region-blocked / age-restricted? | Skip with warning, continue with the rest |
| Re-run same URL → behavior? | Skip already-downloaded (yt-dlp `--download-archive` writes IDs to `/etc/yt-dlp/archive.txt`) |
| File format | `.m4a` (bestaudio, no ffmpeg). Visit ffmpeg install in Phase 2 if MP3 needed. |
| Auto-create project playlist? | Yes, with the YouTube playlist's title as the playlist name |
| Auto-update yt-dlp | Weekly cron on LXC 100: `0 4 * * 0 pip install --user --upgrade yt-dlp` |

---

## Caveats (so future-you remembers)

- **yt-dlp breaks every few months** when YouTube changes their extraction format. Fix: `pip install -U yt-dlp`. Auto-update cron makes this self-healing.
- **JS runtime warning** (`No supported JavaScript runtime`): yt-dlp wants Node/Deno for some new extraction paths. Without it, format choices reduced but downloads still work. Install Deno on LXC 100 in Phase 2 if needed.
- **YouTube's ToS** technically prohibits downloading content the platform doesn't expose a download button for. Personal-use / your-own-content downloads are a legal gray area in most jurisdictions; not a code concern, just an awareness point.
- **Filename unicode**: Windows console mangled Russian/Hebrew titles in our test, but the files themselves are fine on disk (NTFS supports unicode). When yt-dlp runs on LXC 100 (Linux ext4) there's no encoding issue at all — full unicode all the way through.

---

## Use case 2 — Ambient / nature sounds (rain, birds, forest)

Same pipeline, different content type. YouTube is the natural fit for ambient because the **8-12 hour continuous track format** is essentially a YouTube native — dedicated channels publish single videos that long specifically for sleep / focus / background use. One download = one file = one playlist entry that plays for a whole night.

### Why YouTube over royalty-free libraries for this

| | YouTube ambient | Pixabay / BBC sound archives |
|---|---|---|
| Typical length | 8-12 hour continuous tracks | 3-10 min loops |
| Bedtime workflow | Hit Play once → runs all night | Need Repeat ON + audible loop seam |
| Library size | Massive ("rain on tent" / "rain on roof" / "rain in forest" / …) | Curated, smaller |
| Quality | Best channels (Relaxing White Noise, Calmed by Nature, Sleep Tube) are pro | Pro by default |
| Library shape | One big file per mood | Many small files to assemble + loop |

Pixabay / BBC remain useful for **short stings** (single bird chirp, single thunderclap) when authoring something compositionally, but not for "leave it running while I sleep."

### Recommended ambient channels (single videos, 8h+, no copyright issues)

| Channel | Vibe | Search terms |
|---|---|---|
| **Relaxing White Noise** | Rain / thunderstorm / fan / brown noise | `10 hours heavy rain thunder` |
| **Calmed by Nature** | Forest / birds / streams / wind | `8 hour forest birds dawn` |
| **Sleep Tube** | Ocean / rain / fireplace | `10 hours ocean waves` |
| **Nature Sounds for Sleeping** | Mixed nature | `12 hour gentle rain forest` |

These channels publish under "no copyright" / royalty-free terms; their videos have no music, no voice intros, no watermarks.

### Phase A — manual one-shot per track (once LXC 100 has yt-dlp)

Pick a video from any of those channels. On LXC 100:

```bash
mkdir -p /mnt/media/Music/Ambient
python3 -m yt_dlp --no-playlist -f bestaudio \
  -o '/mnt/media/Music/Ambient/%(title)s.%(ext)s' \
  '<YouTube video URL>'
```

Output: one `.m4a` file (typically 80-200 MB for a 10-hour track) in `Music/Ambient/`. Open Media tab → 🔍 Unassigned → drill into `Ambient/` → tick → ✓ Add to playlist.

### Phase B — bundled "Ambient" playlist

End state to aim for:

1. **`/mnt/media/Music/Ambient/`** folder with ~5-10 long ambient files (rain, forest, ocean, thunderstorm, fireplace, brown noise, …)
2. **Project playlist "Ambient"** containing all of them
3. **🔁 Repeat ON** (state persists in localStorage per the 2026-05-18 work)
4. **Optional: 🔀 Shuffle ON** so consecutive nights aren't always rain-then-forest in the same order

Single click on the project Playlist card's ▶ Play → soundbar runs all night. Stop button + auto-off-on-stop powers down the soundbar cleanly when you're done in the morning.

### Phase C — dashboard form should expose this naturally

When the Phase 1 dashboard form lands (URL input → ▶ Download), no separate UI needed for ambient — same form handles single videos OR playlists. Workflow becomes:

1. Find an 8-hour rain video on YouTube
2. Paste its URL into the Media tab's "Download from YouTube" form
3. Folder name: `Ambient`
4. ▶ Download → file lands in `Music/Ambient/`
5. Project playlist auto-updated (if "Create project playlist when done" was checked, OR add manually via 🔍 Unassigned)

### Tradeoffs to remember

- **File sizes**: 10-hour `.m4a` is ~150 MB. 10 of them = 1.5 GB on the QNAP. Not a concern (Music share has TB of space) but worth knowing.
- **Cookies not needed**: ambient channels are all public — no `cookies.txt` required for this use case.
- **Same yt-dlp install** as the music-playlist use case: one Phase 0 install on LXC 100 unlocks both flows.
- **Loop seam**: yt-dlp gets a perfect cut from the video; Repeat-mode loop is silent when the source file is clean. Choose channels that don't fade in/out.

---

## Where to pick up

1. ✅ ~~Read this file~~ (done)
2. ✅ ~~Phase 0 — install yt-dlp on LXC 100 + verify single-video end-to-end through Cast~~ (done 2026-05-27)
3. **Phase 1 — design + implement dashboard URL→download form.** Open questions for that pass:
   - URL input only, or also a multi-line "search list" textarea (mode B)?
   - Per-download folder name field, or always `Music/<YouTube-playlist-title>/`?
   - Progress display: full SSE stream (yt-dlp's `[download] xx%` lines) or just a coarse `pending → downloading → done` summary per track?
   - Auto-create project playlist on completion: default ON, or always ask?
4. **Cookie path** (Phase 1.5) — separate test session. Quit Chrome / Edge cleanly, run the laptop test against `PLB38FEB8BC8C1E8CE`; OR install **"Get cookies.txt LOCALLY"** extension, export, upload to LXC 100 via the Phase 1.5 upload form.
5. **Phase 2 niceties** — text-list input mode B, weekly auto-update cron, `--download-archive` for incremental sync.
