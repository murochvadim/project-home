# Media / Playlist Stack — Pre-commit Audit Punch List

Files audited: `scripts/player_service.py` (2140 lines), `scripts/ingest_service.py` (312 lines), `BOILER/dashboard/public/js/media.js` (3007 lines), `BOILER/dashboard/public/media.html` (698 lines).

## Definitely dead — safe to remove

| Symbol | File:lines | Notes |
|---|---|---|
| `_force_tv_stopped` | `scripts/player_service.py:2056-2083` | Zero callers in repo. Last reference path was the pre-Cast queue handlers. Removes the entire `KEY_RETURN` residue. |
| `_queue_watcher_loop` | `scripts/player_service.py:1790-1863` | Never started — `_ensure_queue_watcher` is no longer called. Cast `_CastStatusListener.new_media_status` is the sole advancer. |
| `_ensure_queue_watcher` | `scripts/player_service.py:1780-1787` | Only `_play_queue_item` (also dead) referenced it; no live caller after Cast pivot. |
| `_queue_watcher_thread`, `_queue_watcher_stop`, `_QUEUE_GRACE_SEC` | `scripts/player_service.py:1516-1518` | Only read by `_queue_watcher_loop`. |
| `_play_queue_item` (UPnP variant) | `scripts/player_service.py:1707-1777` | Replaced by `_play_queue_item_cast` everywhere — `/api/queue/next` (line 2100), `/api/queue/prev` (line 2112), `_cast_advance_queue` (line 1627), `playlist_play` (line 1912) all use the Cast version. |
| `_play_queue['saw_playing_at']`, `last_pos_seen`, `last_dur_seen` keys | `scripts/player_service.py:1727, 1817-1818, 1836-1837, 1844-1845` | Only written/read inside the dead watcher + dead `_play_queue_item`. Cast listener uses `self._saw_playing_for_idx` instead. |
| `EMBED_SCRIPT` constant | `scripts/player_service.py:58` | Defined, never referenced anywhere in repo. |
| `SOUNDBAR_UUID` constant | `scripts/player_service.py:43` | Set but never read — `pychromecast.get_listed_chromecasts` uses `friendly_names` + `known_hosts`, not UUID. |

## Probably dead — chain removal candidates

| Symbol | File:lines | Why suspect |
|---|---|---|
| `_get_transport_state` | `scripts/player_service.py:1692-1704` | After removing the dead watcher + dead `_play_queue_item`, the only remaining callers are inside `_wake_and_play` (lines 227, 266, 294). Still needed there for the video UPnP path — KEEP. |
| `_wait_for_tv_ready` | `scripts/player_service.py:177-190` | Only used by `_wake_and_play` (line 210). Live (video plays through `_wake_and_play`) — KEEP. |
| `/api/media/search`, `/api/media/search/session`, `/api/media/play-number`, `/api/media/show-results`, `/api/media/results-image` + `_search_session` state | `player_service.py:343-369, 1241-1280, 1283-1315, 1406-1412` | No callers in `BOILER/dashboard/public/**`. These are the legacy voice/search-results-via-TV pipeline. Verify with the voice agent owner before removal — they may still call these from LXC 106. |

## Keep — load-bearing

- `_wake_and_play` + UPnP DLNA stack + `_get_transport_state` + `_wait_for_tv_ready` + `_play_gen` machinery — single-track video play to TV still uses this (player_service.py:1237, 1277, and queue-video fallback at 1684, 1759/1767).
- `KEY_RETURN`/`KEY_EXIT`/`KEY_HOME` — none remain in `_wake_and_play` itself; only the legitimate `KEY_RETURN` was inside the dead `_force_tv_stopped`. After deleting that function, zero key-press residue remains.
- `_currentPath` + media-browser functions — used by single-play (`/api/media/play`) and Select Mode → playlist; keep.
- `renderQueueStrip`, `_tickCastProgress`, `_fmtMMSS`, `saveCastVolumePreset`, `queueNext/Prev/Stop`, `tvCommand`, `playPlaylistFromCard`, `togglePlaylistMode` — all referenced from inline `onclick` handlers in the strip's `innerHTML` (lines 925-944, 1098-1100) — keep.
- `playTrackFromModal` — never existed (verified). Nothing to remove.

## Cleanup wins

1. **Comment drift** at `player_service.py:1508-1512` ("watcher thread polls TV transport state every 3s") describes the deleted watcher — rewrite to reflect Cast listener model.
2. **Comment drift** at `player_service.py:560-562` in `startProgressPoll` JS — comment says "TV needs ~3s to wake" but this poll is used for video AND audio progress; the 4s interval is fine but the comment is misleading.
3. **Duplicate `AUDIO_EXTS` def** inside `_wake_and_play` (line 233) shadows the module-level constant (line 49) — drop the local, use the global.
4. **Two `from urllib.parse import quote as _q` imports** in `play()` (1227), `play_number()` (1269), `_play_queue_item_cast` (1635), `_play_queue_item` (1714) — hoist once at module top.
5. **`_play_queue` mutated via `globals()['_play_queue'] = ...`** in 6 places. Cleaner pattern: a small `_clear_queue()` helper. Behaviour identical.
6. `MEDIA_API` / `INGEST_API` in `media.js:1-2` are hardcoded `192.168.1.138`. Acceptable for now but consider env-driven; matches the architecture rule (dashboard talks to LXC directly).
7. The whole `# ── TAB: Pixoo64 ──` HTML comment in `media.html:505` is orphan — Pixoo lives on `corridor.html` now.

## Wiring sanity checks

- **Cache-bust versions**: `media.html:696 → media.js?v=97`. No conflicting older references for media.js found. `alerts-monitor.js?v=9` is shared with other pages (matches their versions).
- **Server endpoints called by JS** — all map to live `@app.route`s in `player_service.py` or `ingest_service.py`. Cross-checked the full grep list of fetches against route table — every `${MEDIA_API}/api/...` and `${INGEST_API}/api/...` resolves. No 404 risk from JS side.
- **DOM handlers** — `onclick` strings in `renderQueueStrip` (lines 925-944), the playlist card template (1098-1100), and the Alexa card template (2401-2454) all resolve to global functions defined in `media.js`.
- **Inline onclicks in `media.html`** — `refreshState`, `cmd`, `toggleMute`, `handleDrop/Input`, `loadAnalyzer`, `loadIngest`, `loadPlayer`, `loadAlexa`, `loadMediaSettings`, `rerunAnalyzer`, `runClustering`, `loadFaceClusters`, `loadUnmatchedFaces`, `loadFacePeople`, `createPlaylist`, `toggleSelectMode`, `clearSelection`, `addSelectedToPlaylist`, `loadMediaBrowser`, `closeEditModal`, `deleteLibraryItem`, `saveMetadata`, `closePlaylistDetail`, `deletePlaylistFromModal`, `savePlaylistDetail`, `alexaSpeak`, `alexaTplFormShow/Cancel/Save` — all defined.
- **Deploy paths**: `player_service.py` → `/opt/media-agent/player_service.py` on LXC 100 (per docstring line 6 + CLAUDE.md). `ingest_service.py` → `/opt/media-agent/ingest_service.py` (line 6). Both correct. `media.js` + `media.html` served from `BOILER/dashboard/public/` on the Windows host (pm2 boiler-dashboard). Architecture rule respected — `media.js` calls `192.168.1.138:8766/8767` directly, no business logic on dashboard server.
- **`MEDIA_LXC_IP = '192.168.1.138'`** matches the registered IP for LXC 100. Used for the MiniDLNA stream URLs delivered to Cast — Cast must reach the LXC by that IP. Correct.

## Bottom line

Removing the 8 items in "Definitely dead" trims ~250 lines from `player_service.py` with zero behaviour change. The "Probably dead" voice/search endpoints (~80 lines) are independent and can ship as a second pass after confirming with the voice integration owner.
