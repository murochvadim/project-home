# Media Agent — LXC 100

## Overview
The Media Agent runs on **LXC 100** (192.168.1.138). It handles:
- Media library ingestion and scanning (video, image, audio)
- Face detection, embedding, clustering, and recognition via InsightFace
- TV/soundbar playback via DLNA + Samsung UPnP
- Media browsing, search, upload, and metadata editing
- Dashboard UI: `BOILER/dashboard/public/media.html` + `js/media.js`

The Alexa Devices tab on the same Media Agents page is **NOT served by LXC 100** — it talks to Home Assistant (`192.168.1.110`) via the dashboard server's `/api/alexa/*` endpoints. See "Alexa Devices" section at the bottom of this file.

---

## LXC 100 Services

| Service | Script | Port | Role |
|---------|--------|------|------|
| `player.service` | `/opt/media-agent/player_service.py` | 8766 | Browse, search, playback, faces API, library read |
| `ingest.service` | `/opt/media-agent/ingest_service.py` | 8767 | Scan, upload, library CRUD, delete |
| `analyzer.service` | `/opt/media-agent/analyzer.py` | — | Face detection + embedding + clustering (background loop) |
| `tv_control.py` | `/opt/media-agent/tv_control.py` | 8765 | Samsung/HA TV control, proxied by player |
| `minidlna` | system service | 8200 | DLNA media server for TV playback |

## Local Scripts (source of truth → deployed to LXC 100)

| Local file | LXC 100 path |
|-----------|-------------|
| `scripts/player_service.py` | `/opt/media-agent/player_service.py` |
| `scripts/ingest_service.py` | `/opt/media-agent/ingest_service.py` |
| `scripts/embed_crop.py` | `/opt/media-agent/embed_crop.py` |
| `scripts/auto_scan.sh` | `/opt/media-agent/auto_scan.sh` |
| **`MEDIA/agent/analyzer.py`** (since 2026-05-26) | `/opt/media-agent/analyzer.py` |

**analyzer.py is now in repo (since 2026-05-26).** Previously it was patched directly on LXC 100 with no version-controlled source — that drift caused fixes to be lost across reinstalls and made bug triage harder. Pulled into repo + deployed during the 2026-05-26 NFS-permission-self-heal patch. After any patch: `scp MEDIA/agent/analyzer.py root@192.168.1.138:/opt/media-agent/analyzer.py && ssh root@192.168.1.138 'systemctl restart analyzer'`.

## Supporting Scripts on LXC 100 (not in local repo)

| Script | Role |
|--------|------|
| `/opt/media-agent/scan_library.py` | Called by ingest_service to walk MEDIA_MOUNT, hash files, return new-file list |
| `/opt/media-agent/gen_results.py` | Generates search result image (JPEG) for TV display via DLNA |
| `/opt/media-agent/face_register.py` | Extracts 512-dim ArcFace embedding from a photo; server.js spawns it and inserts result into `face_registry` |
| `/opt/media-agent/face_recognize.py` | Matches faces in image/video against `face_registry`; cosine similarity ≥ 0.5; 1 frame/120s for video |
| `/opt/media-agent/venv/` | Python venv: InsightFace, psycopg2, flask, numpy, cv2, flask-cors, **pychromecast** (audio playlist routing to soundbar) |

## Deploy Commands
```bash
scp scripts/player_service.py root@192.168.1.138:/opt/media-agent/player_service.py
scp scripts/ingest_service.py root@192.168.1.138:/opt/media-agent/ingest_service.py
scp scripts/embed_crop.py root@192.168.1.138:/opt/media-agent/embed_crop.py
scp scripts/auto_scan.sh root@192.168.1.138:/opt/media-agent/auto_scan.sh
ssh root@192.168.1.138 "systemctl restart player && systemctl is-active player"
ssh root@192.168.1.138 "systemctl restart ingest && systemctl is-active ingest"
# After patching analyzer.py on LXC 100:
ssh root@192.168.1.138 "systemctl restart analyzer && systemctl is-active analyzer"
```

---

## Database (LXC 102 — PostgreSQL `home_data`)

### Tables

| Table | Schema summary |
|-------|---------------|
| `media_library` | `path PK, title, type (video/image/audio), person TEXT[], event, year, location, search_text, status, file_hash, duration_sec, size_bytes, added_at, last_played` |
| `face_crops` | `id, file_path, frame_sec, bbox_x1/y1/x2/y2, crop_path, embedding FLOAT8[], det_score FLOAT, person_name, cluster_id` |
| `person_embeddings` | `name PK, embedding FLOAT8[], det_score FLOAT, added_at` |
| `analyzer_settings` | `key TEXT PK, value TEXT` — controls auto/manual mode behavior |
| `analyzer_log` | `ts, decision, error, next_ts` — analyzer run log; `cluster_requested` sentinel triggers clustering |
| `face_registry` | `id, name, embedding FLOAT8[], image_path, added_at` — simple face registry for the register-photo → recognize-in-file pipeline (separate from the analyzer pipeline). Keep forever. |

### Critical DB Rules
- `face_crops.embedding` must be `array_length(embedding,1) = 512` — empty `ARRAY[]::FLOAT8[]` embeddings (from manual crops before analyzer processes them) are **excluded from clustering**
- `det_score` = InsightFace detection confidence 0.0–1.0; **NULL for manual crops** (they bypass InsightFace)
- `person_embeddings` holds **one reference embedding per person** — the highest `det_score` crop embedding. This survives re-run so auto-matching works after re-detect.
- `media_library.person[]` = `'{not_recognized}'` when video has faces but none recognized; `'{}'` for audio; named person array otherwise
- `media_library.status`: `pending` → `processing` → `ready`/`searchable`/`error`

---

## Face Recognition Architecture

```
File ingested → media_library (status=pending)
              ↓
analyzer.service loops: picks pending files
              ↓
InsightFace detects faces → face_crops row (embedding 512-dim, det_score)
              ↓
DBSCAN clustering → cluster_id assigned to crops
              ↓
Auto-match: cosine similarity vs person_embeddings → person_name assigned
If match: updates person_embeddings if new det_score is higher
              ↓
Dashboard: user labels clusters → person_embeddings updated
           user assigns unmatched faces → person_embeddings updated
           user draws manual crop → face_crops row (empty embedding) → analyzer embeds on next pass
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **det_score** | InsightFace face detection quality per crop (0.0–1.0). Green ≥0.85, amber 0.70–0.84, red <0.70. NULL for manual crops. |
| **Similarity** | Cosine similarity across all of a person's crop embeddings vs their centroid. Measures consistency of crops. Computed live — not stored. |
| **Clustering** | DBSCAN on `array_length(embedding,1)=512` crops only. Groups unknown faces across files. |
| **Auto-match** | After clustering: each cluster compared to `person_embeddings`. If cosine similarity ≥ threshold → auto-assigns person_name. |
| **Re-run** | Deletes ALL face_crops (images + DB). Resets all media_library rows to `pending`. `person_embeddings` preserved. Ghost entries cleaned (see cascade rules). |
| **Manual crop** | User draws box on video frame in lightbox → `face_crops` inserted with `ARRAY[]::FLOAT8[]` embedding. Analyzer computes real embedding on next pass. |

---

## player_service.py — Patches Applied on LXC 100

> `player_service.py` is patched directly on LXC 100 via Python patch scripts (scp + ssh). No local copy is source of truth.

| Patch | Reason |
|-------|--------|
| Wrap `dlna_soap()` calls in try/except + `log.error`; increase subprocess timeout 10→15s | Silent failures when Samsung TV unreachable or slow |
| Add response logging for SetAVTransportURI and Play | Visibility into TV SOAP responses |
| `_stream_tokens = {}` dict + `/api/media/token/<token>` route | Samsung TV rejects non-ASCII/space filenames in DLNA URLs even when percent-encoded |
| Recompute `stream_url_xml` after token replaces `stream_url` | Bug: old Cyrillic URL was still being sent in SOAP body |
| Add `protocolInfo="http-get:*:<mime>:*"` to DIDL-Lite `<res>` element | Samsung TV rejects SetAVTransportURI without it |
| `_current_duration` global — set from `media_library.duration_sec` on play | TV doesn't report duration via GetPositionInfo; needed for dashboard progress bar |
| `parse_secs`: `int(p[2])` → `int(float(p[2]))` | TV returns fractional seconds e.g. `05.449`, causing `ValueError` in `/api/media/position` |

---

## analyzer.py — Patches Applied on LXC 100

| Patch | Reason |
|-------|--------|
| Store `det_score = float(getattr(face, 'det_score', 0.0))` on INSERT to face_crops | Track face detection quality per crop |
| After auto-match: `UPDATE person_embeddings SET embedding=..., det_score=... WHERE det_score < new_score` | Ensure best-quality embedding survives re-run |
| Clustering SELECT: `array_length(embedding,1)=512` instead of `embedding IS NOT NULL` | Skip empty embeddings → fixes "inhomogeneous shape" numpy crash |

---

## Cascade Deletion Rules

### When a video is permanently deleted (`library_delete()` in ingest_service.py)
1. Query `face_crops` — collect distinct `person_name` values for this file
2. Delete crop image files from disk (`/mnt/media/.faces/*.jpg`)
3. `DELETE FROM face_crops WHERE file_path=...`
4. `DELETE FROM media_library WHERE path=...`
5. For each affected person: if no remaining crops anywhere → `DELETE FROM person_embeddings WHERE name=...`

### When re-run finds missing files (`analyzer_rerun()` in player_service.py)
1. Delete ALL face crop images from disk
2. `DELETE FROM face_crops` (all rows)
3. `DELETE FROM media_library WHERE path = ANY(missing_paths)`
4. `DELETE FROM person_embeddings WHERE name NOT IN (SELECT DISTINCT unnest(person) FROM media_library WHERE person IS NOT NULL AND person != '{not_recognized}')`
5. `UPDATE media_library SET status='pending'` for all remaining files

---

## File/Folder management — Player tab grid (added 2026-07-03)
The QNAP `Media` share is mounted **NFS on LXC 100 as root** but the Windows/SMB `claude` user can't create/move/delete on it (files land `root:root 644`). So all file ops go through **`player_service.py`**, which owns the files. Three endpoints (beside the existing `/api/media/delete`):
- **`POST /api/media/mkdir`** `{parent, name}` — `os.makedirs(safe_path(parent/name))`. Unicode names OK.
- **`POST /api/media/move`** `{paths[], dest}` — `os.makedirs(dest)` + `os.rename` each file (+ its `.description` sidecar), prunes the emptied source folder, then **syncs the DB**: `UPDATE media_library.path` old→new + rewrites matching **playlist** item paths, and a **background** `_minidlna_full_rescan()` (so the move returns instantly — a blocking rescan was the first-cut bug).
- **`POST /api/media/delete`** — now also **syncs the DB** via **`_db_forget_paths()`**: for a folder it `os.walk`s the inner files first, then `DELETE FROM media_library WHERE path = ANY(...)` + strips them from playlists + background rescan. So delete and move are finally consistent (no orphan rows / broken playlists). All paths `safe_path`-guarded.

**UI** (`media.html` + `media.js`, Player tab → QNAP Media grid): **☑ Select** files → the select bar shows **📁 Move to folder…** (opens a **navigable folder-picker modal** — breadcrumb + ⬆ Up + drill-into folders, "📁 Move here" targets the folder you're viewing, or type a new folder name; folders fetched fresh via `/api/media/browse`, not grid state) and **🗑 Delete** (bulk file delete, confirms). Each **folder tile** has a **🗑** (top-right, like the ✏️ on file tiles) → deletes the folder + contents (confirms). Every delete path confirms (incl. `deleteCrop`, fixed same day). NOTE: `MEDIA_API = http://192.168.1.138:8766` (player_service, sends `Access-Control-Allow-Origin: *`); the dashboard calls it cross-origin.

**Ingest download → existing folder (2026-07-03):** the "Download from YouTube" **Folder** field (`#yt-folder`) is a **type-or-pick** input (HTML `datalist#yt-folder-list`) — `ytPopulateFolders()` fills it with the existing sub-folders of the current mode's root (**Music** for 🎵 Audio / **Videos** for 🎬 Video, via `/api/media/browse`), refreshed on ingest-tab open (`loadIngest`) + on the Audio/Video toggle (`ytModeChanged`). So a download can target an existing folder (pick it) or a new one (type it) in the same field; the backend `os.makedirs(exist_ok=True)` handles both.

---

## TV Playback

### Devices controlled
| Device | Entity | Protocol |
|--------|--------|---------|
| Samsung 85" QLED | `tv` | Samsung UPnP SOAP + HA |
| Samsung Soundbar HW-Q990C | `soundbar` | HA |
| TV-60 Guy Room | `tv_guy` | HA |
| TV-49 Bedroom | `tv_bed` | HA |
| TV-55 Balcony Neo QLED (QE55QN85DBTXSQ) | `tv55` | SmartThings (power) + UPnP (volume + video) |

### TV 85 (Living Room, `tv`) vs TV 55 (Balcony, `tv55`) — control differences
Both are Samsung TVs driven by the media agent (LXC 100), but via DIFFERENT paths — **don't assume one behaves like the other** (this bit us on volume + off). Code: `tv_control.py` (`tv` branch) + `player_service.py` `media_command()` (`tv55` intercepts).

| Aspect | **TV 85 — Living Room** (`tv`) | **TV 55 — Balcony** (`tv55`) |
|---|---|---|
| Model | Samsung 85" QLED | Samsung 55" Neo QLED (2024) |
| **Power on/off** | HA `switch.samsung_85_qled` (+ Tizen WebSocket fallback for extra keys) | SmartThings **cloud** `media_player.balcony_55_neo_qled` (reliable, IP-independent) |
| **Volume** | HA `media_player/volume_up`·`volume_down` on `TV_PLAYER` — **works** | HA volume is **DEAD** (set/down ignored, `volume_level` frozen) → driven via the TV's **UPnP RenderingControl** (GetVolume → ±N 0–100 → SetVolume) in `player_service`. Panel sends `volume_step ±10`. |
| **Audio (music)** | → living-room **soundbar** via **Chromecast** (`audio_sink='cast'`) | → the **TV's own speakers** via **DLNA** (`audio_sink='dlna'` — no soundbar in that room) |
| **Playlists** | Chromecast queue | server-driven **DLNA watcher** (one fresh `SetAVTransportURI` per track) |
| **Track-change mid-queue** | Cast handles it | needs the **quick-play / teardown-settle** fix (the 2024 unit stalls in `TRANSITIONING`) |
| **Turn-off** | standard HA switch off | **stop playback first** — clear `_play_queue` (so the DLNA watcher exits, no skip-to-next) + UPnP Stop → wait 2 s → power off |
| Default playback target | yes (`_active_video_target='tv'`) | only when explicitly selected |
| Video | Samsung UPnP SOAP → its renderer | Samsung UPnP SOAP → its renderer (`.199:9197`) |

**Net:** the 85" is **HA + Cast + soundbar**-centric; the Balcony is **SmartThings-power + UPnP-everything-local** (its own speakers, its own volume, its own DLNA queue) — because it has no soundbar AND HA's volume path is dead for it.

**TV-55 Balcony Neo QLED (added 2026-06-17)** — Samsung 2024 Neo QLED at `192.168.1.194` (MAC `2c:99:75:44:20:fb`), DLNA renderer at `:9197/upnp/control/AVTransport1`. **Control = HA** via `media_player.balcony_55_neo_qled_qe55qn85dbtxsq` (exposes volume_level / is_volume_muted / source `['TV','HDMI']` / supported_features 24509 → turn on/off, volume set+step, mute, select_source). **TV PHYSICALLY REPLACED 2026-06-25** — a NEW unit (same model QE55QN85DBTXSQ but **new UUID `0798bd17-…`** — confirmed via the Samsung WS info API, so genuinely different hardware, not a reconnect) now at `.194` / MAC `2c:99:75:44:20:fb`; added to HA as entity `media_player.balcony_55_neo_qled_qe55qn85dbtxsq`. Updated `TV55_IP`/`TV55_MAC`/`TV55_ENTITY` (tv_control.py) + `tv55` `av_url` (player_service.py) → `.194`, deployed to LXC 100 + restarted. Verified live: agent reads `tv55 = on / 32% / unmuted / inputs [TV,HDMI]`, DLNA `:9197` up at `.194`. The old TV (`.217` / `e8:aa:cb:71:1f:b0` / entity `…qe55qn85dbtxsq_2`, UUID `918dbe62-…`) is gone — its `_2` entity is now an HA orphan stuck `off` (optional housekeeping to delete). net_devices: new MAC named "Balcony Tv 55", old renamed "Balcony Tv 55 (old - replaced 25.6.26)". **Earlier — TV swapped/reconnected 2026-06-18** (was `.194` / MAC `2c:99:75:44:20:fb` / entity `…qe55qn85dbtxsq`): same physical TV (model QE55QN85DBTXSQ, UUID `918dbe62-…`, confirmed via the Samsung WS info API at the new IP) on a different NIC → new MAC + DHCP IP `.217`; re-adding it to HA appended `_2` to the entity id (the old `…dbtxsq` entity is now an orphan stuck `off` — optional HA housekeeping to delete it). Updated `TV55_IP`/`TV55_MAC`/`TV55_ENTITY` in tv_control.py + the `tv55` DLNA `av_url` in player_service.py. Verified: agent reads tv55 live (`on / 39% / unmuted`), DLNA `:9197` up at `.217`. The `tv55` branch in `tv_control.py` mirrors `tv_guy` (HA `media_player.*` services); `media_state` gathers the entity into a `tv55` block (power/volume/muted/input/supportedInputs). **`volume_step` command (added 2026-06-21; REROUTED to UPnP 2026-06-30):** body `{entity:'tv55', command:'volume_step', value:±N}`. **⚠ HA/SmartThings volume is DEAD for this TV** — `media_player.volume_set` / `volume_down` are silently ignored AND `volume_level` reads frozen/wrong (verified live: set 0.50 → stayed 0.72). So `player_service.media_command()` now **intercepts `tv55` `volume_step` and drives the TV's OWN UPnP RenderingControl** (`_rc_soap`/`_tv55_get_volume`/`_tv55_set_volume` → GetVolume → ±N on 0..100 → SetVolume on the renderer's `…/RenderingControl1`, derived from the `tv55` `av_url`), bypassing the dead HA path. Verified live (user-confirmed 0→silent, 50, 100; panel ±10 accumulates 100→90→80→90). The tv_control.py HA `volume_step` branch is now dead code for tv55. **`tv55` turn_off pre-stop (added 2026-06-30):** the same handler intercepts `tv55` `turn_off` (only when `_active_video_target=='tv55'`) to stop playback cleanly BEFORE power-off — it **CLEARS `_play_queue` first** (so the DLNA queue-watcher EXITS instead of misreading the Stop as "track ended" and **advancing to the next song** — the bug a raw Stop alone caused), sends a UPnP Stop to tv55's AVTransport, waits 2 s, then proxies the power-off. The 85"/soundbar/queue are never touched. The **Balcony OpenHASP panel (pages 4/5) drives `tv55` through these media-agent endpoints** — `/api/media/command` (tv on/off + `volume_step` ±10), `/api/queue/{pause,stop,prev,next}`, `/api/playlists/<id>/play`, `/api/media/play` — via the rule engine's `_dispatch_media` (protocol `media`); see [BALCONY/CLAUDE.md](../BALCONY/CLAUDE.md) "Media Buttons". **`turn_on` sends a Wake-on-LAN magic packet FIRST (then HA `media_player.turn_on`)** so the TV powers on even from a fully-off state without depending on HA knowing the MAC — mirroring the 85"'s reliable power-on. Because `_wake_and_play` posts `turn_on` to the target's `wake_entity` before the UPnP sequence, every Balcony play (video or audio) wakes the TV first, exactly like the 85". **Build-history note:** it was first built as a **direct Tizen WebSocket + Wake-on-LAN** path (no HA) because the TV wasn't in HA yet; once the user added it to HA mid-build the control path was switched to HA media_player (richer state, exact volume %, source list, no Tizen Allow/Deny pairing popup). The Tizen helper was generalized to `get_ws(host, token_file, port)` during that work and now only the 85" uses it. **Playback** to TV-55 (video AND audio) uses the same UPnP/DLNA path as the 85" and is HA-independent — see "Multi-TV playback target" below. **UPDATE 2026-06-26 — power via SmartThings + DHCP reservation (two real failures fixed; SUPERSEDES the local-Tizen / WoL / `.194` details above):** (1) **ON didn't work** — the new TV was **not in SmartThings**, so `tv55` power fell back to **Wake-on-LAN**, which is flaky over WiFi (woke once in ~6 tries). Fix: added the TV to **SmartThings**, which gave HA a **cloud media_player `media_player.balcony_55_neo_qled`** (+ power/energy/channel sensors). `TV55_ENTITY` is now that SmartThings entity — power on/off + volume + source go via Samsung's **cloud (reliable, IP-independent)**, like the 85"'s `switch.samsung_85_qled`; the **WoL block was removed** from `tv55` turn_on (verified off→on and on→off both ~5 s). (2) **Video didn't cast** — the TV's WiFi **DHCP IP drifted `.194 → .199`**, but the DLNA `av_url` was hardcoded to `.194` (now a *different* device). Power still worked (cloud is IP-independent) while video silently failed (DLNA needs the **live local IP**). Fix: **DHCP-reserved the TV at `.199`** on the router + updated `TV55_IP` (tv_control.py) and the `tv55` `av_url` (player_service.py) to `.199`. **Lesson:** SmartThings/cloud power is IP-independent so it MASKS IP drift — but DLNA casting needs the TV's local IP; if "power works but video doesn't," suspect a DHCP IP change. Keep the `.199` reservation. (The local Tizen entity `…qe55qn85dbtxsq` still exists in HA but is no longer used by tv_control.py.)

### Multi-TV playback target (added 2026-06-17)
A **"📺 Play video on" selector** at the top of the Player tab (`media.html`, `#video-target-select`; JS global `_videoTarget` in `media.js`, persisted in `localStorage['media.videoTarget']`) chooses where **ALL** playback goes — video and audio, single files and playlists. The selection is passed as `target: 'tv'|'tv55'` on `POST /api/media/play`, `/api/media/play-number`, and `/api/playlists/<id>/play`.

**Audio routing is by target, NOT a fixed sink.** `TV_TARGETS[*]['audio_sink']`: `'cast'` for the 85" (audio → living-room **soundbar** via Chromecast) and `'dlna'` for the Balcony (audio → the **TV's own speakers** via UPnP — there is no soundbar in that room). Video audio always rides the video stream to whichever TV plays it. So:
- target `tv`: video → 85", audio (single + playlist) → soundbar (Cast, native gapless queue).
- target `tv55`: video → Balcony TV, audio (single + playlist) → Balcony TV speakers (DLNA).

**Balcony audio playlists — server-driven DLNA queue (the hard part).** The Balcony TV has no Chromecast, and Samsung's TV music app is broken for mid-queue switching. We sidestep that by NOT using the TV's playlist at all: each track is dispatched as a **fresh `_wake_and_play`** (full Stop → SetAVTransportURI → Play) — one independent session per track. To advance, `_start_dlna_queue_watcher()` (started in `playlist_play` when `audio_sink=='dlna'`) runs a polling thread (`_dlna_queue_watch_loop`) that watches the TV's UPnP transport state and calls `_cast_advance_queue()` when the current track ends — mirroring the Cast listener's "saw PLAYING for this idx → then STOPPED → advance" gate so track-load transitions don't false-advance. `_dlna_watch_gen` invalidates the old watcher when a new playlist starts. **Verified live 2026-06-17** on the real TV: track 1 played, `next` loaded track 2 (incl. a **Cyrillic** filename) via fresh SetAVTransportURI — the exact case that failed on the 85" music app works here on the 2024 model.

**Target-aware queue controls:** `/api/queue/pause` (UPnP Pause/Play vs Cast), `/api/queue/status` (position via `GetPositionInfo` + state via `_get_transport_state(tv_url=)` + volume via tv_control for DLNA queues; Cast otherwise — reuses the `cast_*` response keys so the Now-Playing strip is unchanged), and `/api/cast/volume` (sets the Balcony TV volume via tv_control `volume_set` → HA `volume_set`, vs Cast `set_volume`). `next`/`prev` re-dispatch through `_play_queue_item_cast`, which routes by target automatically. `stop` already sends both a Cast stop and a UPnP Stop and clears the queue (watcher exits).

**Video target plumbing:** `TV_TARGETS` maps each key → `{av_url, wake_entity, audio_sink}`; module-global `_active_video_target` (default `'tv'`) + `_av_url()`/`_audio_sink()` resolvers. `dlna_soap(action, body, tv_url=None)` and `_get_transport_state(tv_url=None)` resolve from `_active_video_target` unless given an explicit `tv_url`. `_wake_and_play(..., target='tv')` sets `_active_video_target` at entry and wakes that TV's `wake_entity`, so the bar controls follow whatever's playing. **Default-safe:** with no `target` (or any unknown value) everything resolves to `'tv'` → the 85" Cast-audio + UPnP-video paths are byte-identical to before, so the 85" cannot regress (verified: 85" untouched during balcony testing). The playlist queue stores `_play_queue['video_target']`.

### Power state + control source (updated 2026-06-10)
`tv_control.py` (`/opt/media-agent/tv_control.py`, **now also tracked at `scripts/tv_control.py`** — it was previously untracked) derives **power status from the HA `media_player.*` entity, NOT the SmartThings `switch.*`**. The SmartThings switches lag badly — they don't reflect a *remote-initiated* power-on, so they sat at stale `off` for hours while the TV + soundbar were physically on (the "shows off while on" bug). Helper `mp_power(player, fallback_switch, idle_is_on=True)` maps `on`/`idle`/`playing`/`paused`/`buffering` → on, `off`/`standby` → off, and falls back to the `switch` only when the media_player is `unavailable`/`unknown`. (The device-agent's `ha_api.py` already had `media_player.samsung_85_qled` as the fresh source, so the Devices/Power pages were already correct.) **Soundbar exception (fix 2026-06-16, supersedes the 2026-06-10 `idle_is_on=False` attempt):** soundbar power is now driven by **`switch.samsung_soundbar` ONLY** — `'on' if sw.state=='on' else 'off'`, the cast media_player is NOT used for power. Why the earlier fix failed: `media_player.samsung_soundbar_2` is a Cast endpoint that **freezes at its last playback state** (`idle` OR `paused`/`playing`) for *days* and never reflects power-off; it was stuck at `paused` for 36 h while the soundbar was off, and `mp_power` counts `paused` as on, so it still read ON. `idle_is_on=False` only excluded `idle`, not `paused`, so it never helped. Verified live 2026-06-16 that `switch.samsung_soundbar` flips on→off and off→on in real time, so it's the reliable signal (the SmartThings `media_player.samsung_soundbar`, no `_2`, is also fresh and agrees — a fallback if ever needed). The TV keeps `mp_power(... idle_is_on=True)` (its SmartThings switch genuinely lags on remote-on, so the media_player is the better signal there). **Lesson:** a frozen Cast media_player can sit at ANY playback value — none of `idle/paused/playing` are trustworthy power signals; use the switch for the soundbar.

**Control is HA-only.** The SmartThings **Personal Access Token (`ST_TOKEN` in `/etc/environment`) is expired** — Samsung now expires PATs in 24 h, and `st_cmd()` was silently failing (401, return value discarded). Soundbar + TV-Bed power/volume/mute/source were migrated off `st_cmd` onto HA `media_player` services: soundbar = `media_player.samsung_soundbar_2` (features 318399 → turn_on/off, volume_set, mute, select_source), TV-Bed = `media_player.samsung_q49_ba_tv`. Soundbar volume_up/down uses `ha_sb_volume()` (read `volume_level` + `volume_set ±0.05`) because the soundbar has `VOLUME_SET` but **not** `VOLUME_STEP`. **Residual:** the soundbar **source/input list is empty** (it came from SmartThings via `st_get`; HA exposes no `source_list` for it) — power/volume/mute work, only the source picker is degraded until a fresh PAT is added. The `st_get()` state reads in `media_state()` still target SmartThings but 401 harmlessly → `None`, with HA covering power/volume. TV (`tv`) + TV-Guy (`tv_guy`) were already HA-only.

### Playback flow

> ⛔ **HARD RULE: Video ALWAYS uses MiniDLNA → TV. Audio for the 85"/living room uses Cast → Soundbar.**
> Samsung TV requires DLNA-specific response headers (`contentFeatures.dlna.org`, `transferMode.dlna.org`) that only MiniDLNA provides; bypassing MiniDLNA for video causes the TV to accept SetAVTransportURI but silently refuse to render the stream. The 85" TV's UPnP music app is broken for mid-queue switching — many days of UPnP workarounds (KEY_RETURN, session reset, etc.) produced no reliable solution. **For the 85"/living room, audio routes through the Samsung 990C soundbar's built-in Chromecast** (port 8009), which has native gapless queue support and zero music-app weirdness.
> **Exception (2026-06-17) — Balcony 55" has no soundbar:** when the playback target is `tv55`, audio plays on the **Balcony TV's own speakers via UPnP**, and playlists advance through a **server-driven DLNA watcher** (one fresh `SetAVTransportURI` per track, not the TV's playlist). This 2024 model handles fresh-session mid-queue switching where the 85" music app did not — verified live. See "Multi-TV playback target". The "audio → Cast" rule is per-target (`TV_TARGETS[*]['audio_sink']`), not absolute.

- **Video** (`device_type=video`): `minidlna_id()` looks up file in MiniDLNA SQLite DB → stream URL is `http://192.168.1.138:8200/MediaItems/{id}.{ext}` → Samsung UPnP `SetAVTransportURI` + `Play` SOAP call to TV at `192.168.1.129:9197/upnp/control/AVTransport1`. This must never be changed to a direct Flask endpoint. The `_wake_and_play` helper handles the full sequence: TV-on (WoL via tv_control.py if needed) → wait for UPnP ready → Stop → wait STOPPED → SetAVTransportURI (with `protocolInfo="http-get:*:<mime>:*"` on `<res>`) → wait STOPPED → Play with 3-retry → verify PLAYING. Generation counter (`_play_gen` / `_is_play_gen_current`) ensures only the latest call's SOAP commands hit the TV when rapid Next clicks queue up. **tv55 track-change fix (added 2026-06-25, replaced the new TV unit):** the 2024 balcony unit (UUID `0798bd17`) — unlike the old one — **stalls in `TRANSITIONING` when loading a new track while one is already playing** (a mid-queue `next` or a playlist switch): the renderer accepts the new URI but never starts it (ends STOPPED), so the music dies on the switch. Track 1 from idle is fine; only the *transition* fails. **Proven NOT a code regression** — running byte-identical prev-TV code (only the IP changed) still failed; it's the new hardware. **Fix (in `_wake_and_play`, gated to `tv55` only via `fast_advance = prev_active and _active_video_target=='tv55'`, so the 85" stays byte-for-byte on its original path and cannot regress):** when switching from an active track, (a) give the DMR a **3 s teardown settle** before the new URI (vs 0.5 s for a fresh start), (b) use a **"quick play"** reload — pause ~0.8 s after SetAVTransportURI then Play, instead of waiting for the renderer to return to STOPPED (this unit STAYS in TRANSITIONING, so the wait-for-STOPPED path fired Play in a bad window — measured **0/4**; quick-play is **3/3**), and (c) if the first attempt still stalls, **one recovery reload**: Stop → wait STOPPED → 2.5 s settle → reload (quick-play) → verify. The DIDL `item id` is unique per attempt so a reload isn't deduped. Verified live: `next → next → next` + playlist-switch-while-playing all reach PLAYING (~6–8 s first-attempt, ~16 s on the rare recovery); real-usage logs show advances landing first-attempt with no `stalled`/`never observed PLAYING`. (An earlier `_PLAY_DEBOUNCE_SEC` rapid-press debounce was added then **reverted** — it wasn't the cause and isn't in the code.)
- **Audio** (`device_type=audio`): single `pychromecast` connection to the soundbar (cached module-level in `_cast_obj`, reconnects automatically). `_cast_play_url(url, title)` calls `mc.play_media(url, 'audio/mpeg', title=...)`. The default media receiver (`CC1AD845`) launches on the soundbar and plays the stream. Stream URL prefers MiniDLNA library path (`http://192.168.1.138:8200/MediaItems/{id}.{ext}`); falls back to Flask token endpoint when not indexed.
- **Search results image**: `gen_results.py` generates PNG → served by player_service via `/api/media/results-image`
- MiniDLNA SIGHUP: `os.kill(int(pid_file), signal.SIGHUP)` — no shell subprocess
- DIDL-Lite `<res>` element on video calls **must include** `protocolInfo="http-get:*:<mime>:*"` — Samsung TV rejects SetAVTransportURI without it
- `_current_duration` global: set from `media_library.duration_sec` when play starts; used by `/api/media/position` as fallback when TV returns duration=0 (enabling dashboard progress bar — video path only; audio uses Cast's native position reporting)

### MiniDLNA indexing of NEW files — "Not indexed" gotcha (root cause, 2026-06-13)

`minidlna_id(full_path)` does `SELECT id FROM details WHERE path=?` against `/var/cache/minidlna/files.db`; the ▶ TV path (`/api/media/play`) returns **`Not indexed by MiniDLNA: <name>`** (404) when that returns None. Two facts make new downloads fail to play *unless* you rescan AND wait:

1. **The NFS client mount does NOT propagate inotify.** Files the LXC writes to `/mnt/media` (yt-dlp downloads, etc.) are **never auto-indexed** by MiniDLNA — its inotify watch never fires. A rescan is the *only* way to index a new file. (This is NOT a filename/Unicode problem — a 2026-06-13 session chased a fullwidth-colon `：` + emoji red herring before proving the real cause. Special chars are fine.)
2. **The rescan now WAITS for completion (fixed 2026-06-13).** `POST /api/media/minidlna/rescan` (`minidlna_rescan` in `scripts/player_service.py`) does stop → wipe `files.db` → start (full scan). The scan writes `details` rows incrementally over **~1–3 min** (it thumbnails every file; ~74 s for ~1600 files measured). The OLD code returned as soon as `count > 0` (~1 s) with `note:"scan continues in background"`, so the dashboard showed "✓ complete" while `Videos/` was still unscanned → clicking ▶ Play raced the scan → spurious "Not indexed". **Now it polls until the row count is stable for `STABLE_FOR=12 s` (ceiling `MAX_WAIT=360 s`) and returns `{completed:true, elapsed_sec, counts}`** — so "✓ complete" is honest and Play always works after it. The dashboard 🔄 Rescan button (`rescanMiniDLNA` in `js/media.js`, `?v=114`) stays "⏳ Rescanning…" for the full duration. **After any manual video download, click 🔄 Rescan once and wait for the ✓.** Deploy: `scp scripts/player_service.py root@192.168.1.138:/opt/media-agent/player_service.py && ssh … systemctl restart player`.
   - Benign scan noise in the log: `Not a JPEG file: starts with 0x89 0x50` (PNG album-art) and `UNIQUE constraint failed: OBJECTS.OBJECT_ID` (duplicate browse-object ids) — neither blocks `details` indexing; ignore.

---

## Audio Playlists via Cast → Soundbar (since 2026-05-18)

This is the audio playback architecture that replaced ~3 days of failed UPnP workarounds. Single source of truth for audio playlist + queue management.

### Why Cast not UPnP

Samsung's TV music-app DLNA renderer:
- Accepts `SetAVTransportURI` for a 2nd audio track but **never issues a GET request** to fetch the new stream
- Stays in `TRANSITIONING` state forever or silently drops to `STOPPED`
- Does HEAD probes but no GET
- Works for the FIRST audio track only — mid-session swap is unrecoverable

We tried (and removed): unique DIDL item IDs, empty SetAVTransportURI to reset, `protocolInfo` profiles, custom `contentFeatures.dlna.org` headers, KEY_EXIT / KEY_RETURN / KEY_HOME to close the music overlay, `videoItem` class re-tagging, 60 s sustained-PLAYING gates on a polling watcher, position-near-end verification. None were reliable. The whole UPnP audio path is gone — see [`MEDIA/media_audit_punch_list.md`](media_audit_punch_list.md) for the audit trail.

The Samsung 990C soundbar at `192.168.1.149` runs **Google Cast** natively (Chromecast build `1.56.310669`, default media receiver app id `CC1AD845`). Discovery confirmed via SSDP + `http://192.168.1.149:8008/setup/eureka_info`. Cast handles audio queue and gapless playback at the protocol level — no application-level state machine needed.

### Components

| Piece | Location |
|---|---|
| `pychromecast 13.x` | installed in `/opt/media-agent/venv/` |
| Persistent Cast connection (`_cast_obj`) | `player_service.py` module-level, lazy via `_get_cast()` with auto-reconnect |
| `_CastStatusListener` | listens for `player_state` transitions; advances queue only on `PLAYING (for current idx) → IDLE (FINISHED)` |
| `_play_queue_item_cast(idx)` | dispatches one queue item — audio via `_cast_play_url`, video via `_wake_and_play` (kept for mixed playlists) |
| `_cast_advance_queue()` | handles end-of-track: advances `current_idx`, loops on `repeat=true`, clears queue otherwise |
| Preset volume | `dashboard_settings.media.cast_preset_volume` (float 0.0..1.0, default 0.3); applied at every `/api/playlists/<id>/play` start |
| File-missing auto-skip | inside `_play_queue_item_cast` — stale playlist refs skip to next instead of stalling the queue |

### Avoiding false-advance race

The listener uses `_saw_playing_for_idx` to gate advances:
- On status update with `player_state=PLAYING`: record current queue idx as "confirmed playing"
- On status update with `player_state=IDLE` + `idle_reason=FINISHED`: advance **only if** `_saw_playing_for_idx == current idx`, then disarm

This prevents the rapid spurious advances that plagued the earlier UPnP watcher (where transient PLAYING blips between track loads were misread as track-completes and burned through the queue in seconds).

### Volume — Cast-app level, not soundbar hardware

`cast.set_volume(0.0..1.0)` operates on the Cast media receiver's audio mix. **Adjusting physical soundbar volume buttons or remote kicks the soundbar off Cast input back to its primary source (HDMI/digital), ending the Cast session.** That's a one-way trip — the soundbar will not re-launch the Cast app on its own. So the dashboard's Now Playing strip slider drives `cast.set_volume()` exclusively; remote-pressed volume buttons should be considered a session-ender (informational, not a bug).

EQ / bass / treble are not reachable from any available API (SmartThings supported_features = 21901 has no `SELECT_SOUND_MODE` flag, soundbar's local HTTP on ports 8080/8443 returns 403). Use the physical remote or SmartThings phone app.

### Mid-queue mode toggles

The active queue's `shuffle` and `repeat` flags can be toggled mid-playback via `POST /api/queue/mode`. The dashboard's playlist-card toggle buttons call this endpoint with the card's playlist id; the server ignores the call if the active queue is for a different playlist. So toggling Repeat ON during track 3 means the queue will loop at end-of-last-track, instead of clearing.

### Endpoints

| Endpoint | Role |
|---|---|
| `POST /api/playlists/<int:pid>/play` body=`{shuffle?,repeat?,start_idx?}` | Apply preset volume on Cast, init `_play_queue` from `media_playlists.items`, dispatch first track |
| `GET  /api/queue/status` | Active queue state — playlist name, current idx, shuffle/repeat, Cast volume + position + duration + state |
| `POST /api/queue/next` | Manual next → `_play_queue_item_cast(cur+1)` (no Stop+wait needed; Cast handles transitions) |
| `POST /api/queue/prev` | Manual prev |
| `POST /api/queue/pause` | Toggle Cast pause/resume — reads `mc.status.player_state` and flips PLAYING ↔ PAUSED. No-op when idle. Drives the ⏸ Pause / ▶ Resume button in the Now Playing strip |
| `POST /api/queue/stop` | Clear `_play_queue`, `cast.media_controller.stop()`, UPnP Stop on TV (in case video was running). **Does NOT touch soundbar power** (the `_soundbar_off()` auto-off was removed 2026-06-10 — see below) |
| `POST /api/queue/mode` body=`{shuffle?,repeat?,playlist_id?}` | Toggle active queue's flags; `playlist_id` filter prevents Card A's toggle from clobbering Card B's running queue |
| `GET  /api/cast/volume` | `{level, preset}` — current + saved |
| `POST /api/cast/volume` body=`{level, save?}` | Set Cast app volume on soundbar; `save:true` persists as preset |
| `POST /api/playlists/reorder` body=`{order:[id1,id2,…]}` | Set `media_playlists.sort_order` to each id's array index; wipes all sort_order to NULL first so omitted ids fall back to updated_at ordering. Used by the Player tab's drag-reorder UI |
| `GET  /api/media/walk?path=<rel>` | Recursive flat listing of every regular file under `<MEDIA_MOUNT>/<rel>` (skips hidden entries, no symlink follow). Returns `{path, count, files: [{name, path, folder, ext}, …]}`. Used by the 🔍 Unassigned modal |
| `POST /api/media/delete` body=`{paths:[…]}` | Delete files (+ their yt-dlp `.description` sidecars) — or a whole folder — from the library. Each path validated via `safe_path()` (rejects anything outside `MEDIA_MOUNT` / symlink escape); empty parent folders are pruned. Returns `{deleted, total, results:[{path, ok, error?}]}`. Files were created by THIS service so it can remove them — sidesteps the QNAP SMB delete-permission wall that blocks Windows-side deletes. Added 2026-06-10 to back the Unassigned modal's 🗑 Delete button + per-folder 🗑 icon |
| `POST /api/media/yt-dlp/probe` body=`{url}` | Metadata-only fetch via `yt-dlp --flat-playlist --skip-download --print '%(playlist_title|webpage_url_basename)s\|%(title)s'`. Returns `{type, title, track_count, suggested_folder}`. 30 s timeout. Used by the dashboard's 🔍 Detect button to auto-fill the folder name field |
| `POST /api/media/yt-dlp/start` body=`{url, folder, mode?, create_playlist?, auto_split?}` | Spawn yt-dlp as a background subprocess. `mode` (default `audio`): **audio** → `-f bestaudio[ext=m4a]/bestaudio --extract-audio --audio-format m4a -o /mnt/media/Music/<folder>/…`; **video** → `-f 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/…' --merge-output-format mp4 --no-playlist -o /mnt/media/Videos/<folder>/%(title)s.%(ext)s` (audio's `create_playlist`/`auto_split` forced off; rejects `is_live` before spawning, 400). `auto_split` (audio) adds `--write-description`. Returns `{job_id, folder, target_dir}` |
| `GET  /api/media/yt-dlp/status/<job_id>` | Poll the in-memory job state. Returns `{state: running\|rescanning\|done\|error\|stopped, mode, tracks, elapsed_sec, error, folder, playlist_id, playlist_error, split_summary, rescan, rescan_error}`. Tracks update live from `[download] Destination:`/`100%` (+ `[Merger] Merging formats into` for video) parsed by `_yt_reader`. Video jobs pass through a `rescanning` state (calls `_minidlna_full_rescan()`) before `done` |
| `POST /api/media/yt-dlp/stop/<job_id>` | **Abort a running download (since 2026-06-10).** Sets `cancelled=True` and kills the yt-dlp **process group** (so any ffmpeg child dies too — `start_new_session=True` on the Popen makes the group killable). The reader then marks the job `stopped` (not `error`) and **skips** auto-split + playlist creation. Partial files are LEFT on disk (remove via 🔍 Unassigned 🗑). Backs the ⏹ Stop button — closes the runaway-download gap that previously needed an LXC shutdown to kill |

### Soundbar auto-off-on-stop — REMOVED 2026-06-10

The same-day commit `f479ac9` added `_soundbar_off()` to `/api/queue/stop` so "Stop = done listening" powered the soundbar down via HA's `switch.samsung_soundbar`. **This was a sound regression and was removed the same day:** the Player UI (and the user) issues `/api/queue/stop` during normal playlist operation, and nothing powered the soundbar back on when a new playlist started — so playlists played **silently** (audio cast to a powered-off soundbar). The `_soundbar_off()` function and its call were deleted from `player_service.py`; Stop now leaves soundbar power untouched (the pre-`f479ac9` behavior). If a deliberate "power off on stop" is ever wanted, pair it with a "power on at play" so the two are symmetric.

---

## API Endpoints (player_service.py — port 8766)

| Endpoint | Method | Role |
|----------|--------|------|
| `/health` | GET | DB + service status |
| `/api/media/state` | GET | TV/soundbar state (proxied to tv_control) |
| `/api/media/command` | POST | TV/soundbar command |
| `/api/media/search` | GET | Full-text search + person name search |
| `/api/media/library` | GET | Paginated library list (filter by type, unrecognized) |
| `/api/media/library/<path>` | GET | Single file record |
| `/api/media/browse` | GET | Directory browser |
| `/api/media/stream/<path>` | GET | Range-request audio streaming — Cast pulls audio from here (or from MiniDLNA port 8200 when indexed) |
| `/api/media/token/<token>` | GET | Range-request streaming via ASCII token (legacy — was needed for UPnP audio path before Cast pivot) |
| `/api/media/results-image` | GET | Serve `/mnt/media/tmp/search_results.png` to TV |
| `/api/media/thumb` | GET | Image thumbnail (LRU cache, 200 items) |
| `/api/media/play` | POST | Play file on TV (by relPath) |
| `/api/media/play-number` | POST | Play file by search result number |
| `/api/media/show-results` | POST | Show search results image on TV |
| `/api/media/position` | GET | Current TV playback position |
| `/api/media/pause` | POST | Pause TV |
| `/api/media/resume` | POST | Resume TV |
| `/api/media/seek` | POST | Seek to position (seconds) |
| `/api/media/stop` | POST | Stop TV |
| `/api/faces/clusters` | GET | Unlabeled face clusters with similarity score |
| `/api/faces/label` | POST | Label a cluster with a person name |
| `/api/faces/people` | GET | Known people with crop, similarity, det_score |
| `/api/faces/people/<name>/crops` | GET | All crop images for a person with similarity per crop |
| `/api/faces/people/<name>` | DELETE | Forget a person (clears labels, removes person_embeddings) |
| `/api/faces/rename` | POST | Rename a person |
| `/api/faces/crop/<filename>` | GET | Serve crop JPEG image |
| `/api/faces/crop/<id>` | DELETE | Delete a single crop |
| `/api/faces/frame/<id>` | GET | Extract full video frame at face's timestamp |
| `/api/faces/video-frame` | GET | Extract frame from any video at any second |
| `/api/faces/manual-crop` | POST | Save a manual crop drawn by user |
| `/api/faces/unmatched` | GET | Unmatched face crops (no cluster, no name) with det_score |
| `/api/faces/skip` | POST | Mark an unmatched face as `_skipped` |
| `/api/faces/assign` | POST | Assign an unmatched face to a person |
| `/api/analyzer/settings` | GET/POST | Read/write analyzer_settings |
| `/api/analyzer/status` | GET | media_library status counts + face counts |
| `/api/analyzer/rerun` | POST | Full re-run: delete crops, reset to pending, clean ghosts |
| `/api/analyzer/trigger-clustering` | POST | Write sentinel to analyzer_log to force clustering on next loop |

## API Endpoints (ingest_service.py — port 8767)

| Endpoint | Method | Role |
|----------|--------|------|
| `/health` | GET | DB + scan status |
| `/api/media/scan` | POST | Scan MEDIA_MOUNT, queue new files, start ingest worker |
| `/api/media/scan/progress` | GET | Current scan progress |
| `/api/media/upload` | POST | Upload file to MEDIA_MOUNT (multipart, max 20GB) |
| `/api/media/library` | PATCH | Edit metadata (person, event, year, location, search_text) |
| `/api/media/library` | DELETE | Delete file + cascade cleanup |

---

## Dashboard (media.html + js/media.js)

### API base URLs
- Player: `http://192.168.1.138:8766` (MEDIA_API)
- Ingest: `http://192.168.1.138:8767` (INGEST_API)

### Tabs

#### Control tab
- Samsung 85" QLED: power, volume, mute, source select
- Samsung Soundbar HW-Q990C: power, volume, mute, source select
- TV-60 Guy Room: power, volume, mute, source select
- TV-49 Bedroom: power, volume, mute, source select
- TV-55 Balcony Neo QLED: power, volume, mute, source select (HA-backed, `entity='tv55'`; added 2026-06-17, own row below Guy/Bedroom)
- All commands via `POST /api/media/command`
- **🖥 Connect Laptop to tv85** button (Samsung 85 card, since 2026-06-16) — opens the Windows **Cast** panel (Win+K) so the laptop can screen-mirror to the TV. This is a **Windows-HOST action** (cast the laptop's own screen), so it lives on the dashboard host, not an LXC: `POST /api/cast/connect-tv85` in **`routes-cast.js`** (own module, past the architecture-guard hook) spawns **`BOILER/dashboard/cast-to-tv85.ps1`**, which sends Win+K via `keybd_event`. Works because the pm2 dashboard process runs in the user's logon (interactive) session, so the keystroke reaches the desktop. **It only OPENS the picker — it does NOT auto-select the TV.** Auto-selecting was tried and dropped: Windows blocks a background process from silently choosing a mirror target (security), and UI-Automation name-matching grabbed unrelated on-screen text (e.g. the dashboard's own "Samsung 85 QLED" heading / chat text) and clicked the wrong element. So the user makes the final pick (click **Samsung 85** in the panel) + accepts on the TV ("Allow always" to skip future prompts). The `.ps1` must stay **ASCII-only** — PowerShell 5.1 reads `.ps1` as ANSI and an em-dash/smart-quote corrupts the parse (caused a fast 500 during build). Button JS: `connectLaptopTv85()` in `js/media.js` → local `/api/cast/connect-tv85` (not `MEDIA_API`).

#### Analyzer Agent tab
- **Auto Run Status** card: pending/processing/ready/error counts, progress bar, last run
- **Manual Run Status** card: face counts (unassigned/unlabeled/named), Re-run button, Run Clustering button
- **Unknown Faces** (clusters): grid of cluster cards — face image, face count, file count, Similarity %, name input, "Same as…" dropdown, Save/Skip buttons
- **Unmatched Faces**: cards with crop image, filename, timestamp, colored Det badge, assign input, existing-person dropdown, Skip button, 🎬 frame lightbox button
- **Known People**: rows with avatar, name + Similarity % + Det % inline, face count, files count, ✏️ rename, Forget, 🖼 Faces toggle panel with individual crops
- Analyzer status polled every 3 seconds; face sections only reload when counts change

#### Ingest Agent tab
- Upload drop zone: drag/drop files or folder, progress bar with per-file errors
- Calls `POST /api/media/upload` per file with `relativePath` and `targetPath`

#### Player Agent tab
- **📺 Play video on selector** (since 2026-06-17) — dropdown at the top of the tab choosing which TV gets video (`Samsung 85"` / `Balcony 55"`). Sets `_videoTarget` (persisted in localStorage), passed as `target` on play / play-number / playlist-play. Audio always → soundbar regardless. See "Multi-TV video target".
- Media feedback bar (animated, shows play status)
- Playback bar (legacy video controls): title, time, progress, ⏪30s / ⏸Pause / 30s⏩ / ⏹Stop, seek ±30s — auto-restores on page load via `GET /api/media/position`
- QNAP Media browser: grid of files/folders, breadcrumb navigation, play on click; multi-select mode for bulk add-to-playlist
- Edit metadata modal: event, year, location, people fields, Save + Delete buttons
- **Playlists card** (since 2026-05-18): grid of playlist cards; each card has 3 colored buttons in one row:
  - **▶ Play** (green) — starts the queue with current Shuffle/Repeat toggle state
  - **🔀 Shuffle** (blue) — toggle; ON state shown as "ON" label above the button, OFF as "OFF"
  - **🔁 Repeat** (purple) — toggle; same label pattern
  - Toggles also patch the active queue (via `POST /api/queue/mode`) so flipping mid-playback takes immediate effect
  - **Shuffle / Repeat persist per playlist** in browser `localStorage` (key `media.playlistModes` → `{<pid>:{shuffle:0|1, repeat:0|1}}`); restored on every render so the toggle state survives page navigation
  - **Currently-playing card** gets a yellow highlight (`#fff8b3` background + `#e6c200` outline + glow) — driven by `q.playlist_id` from `/api/queue/status`; repainted on every 5 s poll and after every `loadPlaylists()` re-render
  - **Drag-to-reorder** via small `⋮⋮` handle in the top-right of each card. Whole card is the drop target; purple outline marks where the dragged card will land. Persisted server-side via new column `media_playlists.sort_order INTEGER` + endpoint `POST /api/playlists/reorder` body `{order:[id1, id2, …]}` (wipes all sort_order to NULL first, then sets each id's index). `GET /api/playlists` now orders by `sort_order ASC NULLS LAST, updated_at DESC, id ASC` — manually-positioned cards stay put while never-dragged ones keep the old "newest first" fallback. The synthetic click that Chrome dispatches on dragend is suppressed via a `_plDragInProgress` flag so dropping doesn't accidentally open the detail modal
  - Click anywhere else on the card → opens detail modal (track list with drag-reorder, ✕ remove per track, rename, delete playlist)
- **🔍 Unassigned button** (since 2026-05-18) in QNAP Media header — find files in `/mnt/media/Music` that are not in any playlist, curate the selection, bulk-add. Backed by new endpoint `GET /api/media/walk?path=Music` (recursive flat listing under any path, skipping hidden entries / not following symlinks). Modal is folder-navigable: root view shows direct files in `Music/` + sub-folders as 📁 rows with recursive orphan counts; click a 📁 row to drill in; breadcrumb shows the current path with clickable parent segments; ↑ Up link goes back one level. Selections accumulate across folders so user can walk multiple folders before pressing Add. Check all / Uncheck all act on the **current view only**, not the whole library, so a stray click can't sweep up thousands of files. The Add button merges the picked set into the chosen playlist via the existing `/api/playlists` POST (new playlist) + PATCH (existing playlist) flow — same dedupe semantics as the Media browser's Select-mode Add path
- **Now Playing strip** (since 2026-05-18): appears above the QNAP Media card when a queue is active. 3 rows:
  - **Title row**: 🔊 playlist name · `N/total · via Soundbar` + track title + (📺 TV On · 📺 TV Off · `|` · ⏮ Prev · ⏭ Next · ⏸ Pause / ▶ Resume · ⏹ Stop) on the right. Pause button label flips with Cast `player_state` (`PLAYING` → ⏸ Pause, `PAUSED` → ▶ Resume). (⏹ Stop no longer powers the soundbar off — that auto-off was a sound regression, removed 2026-06-10; see "Soundbar auto-off-on-stop — REMOVED" below.)
  - **Progress row**: `M:SS / M:SS` with a green bar; server reports Cast position+duration on the 5 s poll, client interpolates between polls every 1 s; restart-aware (server position drop > 30 s = real new track, not stale reading)
  - **Volume row**: full-width 0..100 % slider + 💾 Save preset button; slider drives `cast.set_volume()` (Cast-app level, not soundbar hardware); ⚠ remote-pressed volume buttons kick soundbar off Cast — adjust via this slider only while audio is playing
- **Download from YouTube card** (since 2026-05-27; **moved from the Player tab to the Ingest Agent tab + gained an Audio/Video toggle 2026-06-18**) — paste a URL → 🔍 Detect (auto-fills the folder name) → ▶ Download. yt-dlp on LXC 100 (installed 2026-05-27 — `pip3 install --user yt-dlp 2026.03.17`; ffmpeg already system-installed). A radio toggle (`ytModeChanged()`) picks the mode and swaps the folder hint Music↔Videos + hides the audio-only checkboxes:
  - **🎵 Audio** (default) — pulls `bestaudio[ext=m4a]` into `/mnt/media/Music/<folder>` + the playlist/auto-split options below (canonical command in `youtube_playlist_integration.md`).
  - **🎬 Video** (since 2026-06-18) — pulls **1080p H.264 + AAC** (`-f 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/b[ext=mp4]' --merge-output-format mp4`) into `/mnt/media/Videos/<folder>`, **always `--no-playlist`** (kills the pseudo-playlist runaway), **rejects LIVE streams** (a pre-spawn `is_live` check in `yt_dlp_start`), and on clean completion runs a **MiniDLNA rescan** so the file shows on the TV. The rescan logic was refactored out of the 🔄 Rescan route into `_minidlna_full_rescan()` so BOTH the route and the `_yt_reader` (video path) call it — no self-HTTP. `mode` is sent to `/yt-dlp/start` (default `audio`); the server branches dest/format/post-step on it (stored as `_yt_jobs[].mode`). For video, `_YT_MERGER_RE` tracks the final merged filename from the `[Merger] Merging formats into "…"` line, because the per-stream `[download] Destination:` lines name the `.fNNN.*` parts that get deleted post-merge. The status pill shows a `rescanning…` phase before `done`. These are the same 3 hard rules as a manual video pull (below), now baked into the card.
  - Progress area below the form shows per-track status pills (`downloading` → `done`) as yt-dlp emits `[download] Destination:` and `[download] 100%` lines, parsed live by the `_yt_reader` background thread. The two checkboxes (audio mode only, both default ON) shape behavior:
  - **Create playlist after download** — auto-INSERTs a `media_playlists` row with all files in the target folder, so the new playlist appears as a ▶ Play card in the Playlists row immediately on completion (`loadPlaylists()` re-renders). Uncheck if you want to merge tracks into an existing playlist manually via 🔍 Unassigned.
  - **Auto-split compilations** — saves the YouTube description as a `.description` sidecar (via `--write-description`), then post-download `_yt_try_split` parses the description for `MM:SS` / `HH:MM:SS` timestamps. If 2+ found, ffmpeg (`-c copy`, lossless) splits the single .m4a into `NNN - Title.m4a` files; the original full file + description are deleted. Handles common compilation-video layouts (timestamps in parens like `Track Name — Artist (17:18)`, OR plain `17:18 - Track`, OR with track-number prefix `06. Track …`). No-op when no timestamps are detected. Caught a real-world case 2026-05-27: a 1h25min "ПЕСНИ НАШЕГО ДВОРА" compilation with 24 song timestamps in description, no embedded chapter metadata — split into 24 individual tracks in ~5 sec via ffmpeg copy-mode.
  - Title h2 carries a `title=` tooltip explaining both checkboxes in 3 lines.
  - **⏹ Stop button (since 2026-06-10)** — sits right of ▶ Download, hidden until a job starts. Click → confirm → `POST /api/media/yt-dlp/stop/<job_id>` kills the download (process-group kill, so ffmpeg child dies too); the job shows an orange `stopped` pill, no playlist is built, and partial files stay on disk (remove via 🔍 Unassigned 🗑). `ytStartDownload` reveals Stop + captures the job id; `ytPollStatus` hides Stop and re-enables Download on `done`/`error`/`stopped`. Added after the 2026-06-10 runaway where a playlist URL pulled 200+ tracks and the only way to stop it was shutting down LXC 100. (Stop applies to both modes.) **Video is now a first-class mode on this card (see the 🎬 Video bullet above, 2026-06-18) → `/mnt/media/Videos`, played via the ▶ TV button in the QNAP Media browser, NOT a playlist; playlists stay audio→soundbar only.**
- **VIDEO downloads → 1080p H.264, NOT 4K (lesson 2026-06-12).** The card's 🎬 Video mode bakes these in; the same rules apply to a manual `python3 -m yt_dlp` pull on LXC 100 into `/mnt/media/Videos/<subfolder>/`. Three hard-won rules for a file that actually **plays on the TV**:
  1. **Force H.264 + AAC, cap at 1080p.** YouTube serves **4K only as AV1/VP9** (itag `f401`=AV1 2160p), which most TVs/players **cannot decode → "not playable"** even when fully downloaded. H.264 tops out at 1080p (itag `f137`). Use `-f 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/b[ext=mp4]' --merge-output-format mp4`. Verify after with `ffprobe … codec_name` → want `h264` + `aac`. (Aquarium video played because it was H.264; 4K AV1 attempt did not.)
  2. **Always `--no-playlist`.** A `?list=PPSV` / `?list=PL…` param makes yt-dlp expand the pseudo-playlist (the 2026-06-10 "one item → 218 files" runaway). Pass just the `watch?v=<id>` URL + `--no-playlist`.
  3. **Reject live streams.** Probe first: `--skip-download --print '%(is_live)s %(live_status)s'`. A 24/7 LIVE stream (`source/yt_live_broadcast`, `live/1`) makes yt-dlp spawn **ffmpeg to record forever** — the file stays a growing `.part`, never finalizes. **Killing the yt-dlp PID does NOT stop it** — ffmpeg is a separate child that keeps writing (turns the deleted file into a `.nfs…` silly-rename on the NFS mount). Find + kill the ffmpeg by PID (`fuser -v <file>` → kill that PID) or use a process-group kill. Run long downloads **detached** (`nohup … &`) so a flaky-WiFi SSH drop to LXC 100 can't orphan/kill them.
- Cache-bust on `js/media.js` query string bumped at every meaningful UI change so browser cache doesn't serve a stale version

#### Settings tab
- **Auto Mode**: auto_enabled, auto_frame_interval (sec), auto_face_score_min (%), auto_cluster_every (N files)
- **Manual Mode**: manual_batch_size, manual_frame_interval, manual_face_score_min, manual_cluster_eps

### Face lightbox (manual crop tool)
- Opens on 🎬 button from unmatched faces or known people crops
- Loads video frame via `GET /api/faces/video-frame?path=...&sec=...`
- Navigation: ±1s, ±5s seek buttons; zoom: 50%/75%/100%/150%/200%/300%/400%
- Draw rectangle on canvas (orange dashed box) → `POST /api/faces/manual-crop`
- Pre-fills name from context (unmatched: empty; known people: person's name)

### Re-run modal
- Amber warning: "Known People are preserved — faces will be re-detected and auto-matched"
- Calls `POST /api/analyzer/rerun`

### Visual indicators
| Item | Green | Amber | Red |
|------|-------|-------|-----|
| Det badge (unmatched) | ≥85% | 70–84% | <70% |
| Det text (known people) | ≥85% | 70–84% | <70% |
| Similarity (known people) | ≥80% | 60–79% | <60% or "No similarity" |
| Cluster similarity | ≥80% | 60–79% | <60% |

---

## Media Mount
- All media files: `/mnt/media/` on LXC 100
- Face crop images: `/mnt/media/.faces/<uuid>.jpg`
- Excluded dirs: `.faces`, `tmp`
- Supported: video (`.mp4 .mkv .avi .mov .ts .wmv .m4v .flv`), image (`.jpg .jpeg .png .gif .bmp .webp`), audio (`.mp3 .wav .flac .ogg .aac .m4a .wma`)

---

## Security Fixes Applied

| Severity | Issue | Fix | Location |
|----------|-------|-----|----------|
| Critical | Path traversal in `faces_video_frame()` — no MEDIA_MOUNT validation | Added `os.path.realpath(file_path).startswith(os.path.realpath(MEDIA_MOUNT))` check | player_service.py |
| High | Shell subprocess `sh -c kill -HUP $(cat PID_FILE)` in `minidlna_id()` | Replaced with `os.kill(int(pid_file.read()), signal.SIGHUP)` | player_service.py |
| Medium | Silent `except: pass` on crop unlink, SIGHUP, last_played update | Added `log.warning()` / `log.debug()` | player_service.py |

`safe_path()` helper validates all other path inputs against MEDIA_MOUNT using `os.path.realpath().startswith()`.

---

## Orchestrator Integration (LXC 105)

All three media services are registered in the `agents` table and monitored by the orchestrator (main-agent on LXC 105):

| Agent name | Service | data_table | settings_table | deploy_path |
|-----------|---------|-----------|---------------|------------|
| `analyzer` | `analyzer.service` | `analyzer_log` | none | `/opt/media-agent` |
| `player` | `player.service` | none | none | `/opt/media-agent` |
| `ingest` | `ingest.service` | none | none | `/opt/media-agent` |

### What the orchestrator checks (every run)
- **Service health**: SSHes to LXC 100, runs `systemctl is-active analyzer/player/ingest`; if down → attempts `systemctl restart`; raises `service_down` alert if still failing
- **analyzer_log freshness**: `analyzer` has a `data_table` — orchestrator checks `next_ts` is not overdue (>5 min grace); raises `agent_overdue` alert if stale
- **Error check**: scans last 10 rows of `analyzer_log` for `ERR:` prefix; raises `agent_hard_errors` alert

### What the orchestrator does NOT check for media
- `player` and `ingest` have no `data_table` — no schedule or error-row check, only service liveness
- No `settings_table` for any media agent — orchestrator cannot adjust media settings

### Deploy via dashboard
- Dashboard Settings tab → Deploy card → dropdown populated from `agents` table
- `POST /api/deploy {agent: "player"|"ingest"|"analyzer"}` → SSH to LXC 100 → `git pull` in `/opt/media-agent` → `systemctl restart <service>`
- All three agents share the same `deploy_path` (`/opt/media-agent`) and `git_branch` (`main`)

### Alerts that media services can generate
| Alert type | Trigger | Affected agent |
|-----------|---------|---------------|
| `service_down` | `systemctl is-active` fails after restart attempt | analyzer / player / ingest |
| `service_ssh_failed` | SSH to LXC 100 fails | analyzer / player / ingest |
| `agent_overdue` | `analyzer_log.next_ts` > 5 min overdue | analyzer |
| `agent_hard_errors` | `ERR:` prefix in last 10 `analyzer_log` rows | analyzer |

---

## DB Consistency Rules
- Every `face_crops` row must reference a file that exists in `media_library`
- Every `person_embeddings` row must have at least one `face_crops` row with matching `person_name`
- No embedding in `face_crops` should be `array_length(embedding,1) != 512` (empty manual crops are transient — analyzer fills them)
- `media_library.person[]` must be kept in sync when face labels are added/removed


---

## Alexa Devices (since 2026-05-06)

Five Alexa-capable devices are integrated via the **Home Assistant `alexa_media_player`** community integration. They are **NOT** in LXC 100's scope — none have a local API; all are cloud-tied to Amazon. The dashboard tab wraps HA's existing service calls (Path A1 — chosen over direct AlexaPy or Smart Home Skill because HA already has the cookie auth working and adding a parallel Python service would just duplicate work).

### Device registry (`devices` table, protocol='alexa')

| HA entity (= devices.id) | name | room | hardware | notify_type |
|---|---|---|---|---|
| `media_player.10inch_echo_show`  | Alexa Balcony       | Balcony     | Amazon Echo Show 10″ | announce (default) |
| `media_player.alexa_my_bathroom` | Alexa My Bathroom   | My BathRoom | Amazon Echo Dot       | announce (default) |
| `media_player.alexa_maya_bedroom`| Alexa Maya Bedroom  | Bedroom     | Amazon Echo Dot       | announce (default) |
| `media_player.alexa_guy_room`    | Alexa Guy Room      | Guy Room    | Amazon Echo Dot       | announce (default) |
| `media_player.samsung_soundbar_2`| Alexa Living Room   | Living Room | **Samsung 990C Soundbar** (built-in Alexa) | — (uses global Speech Settings) |

Each row carries `dps_config = {power: {action_on:turn_on, action_off:turn_off}, volume: {type:range, min:0, max:100}}` so the Devices page renders the panel and rule chips can pick up actionable channels. Migration: [`MEDIA/migrations/alexa_devices.sql`](migrations/alexa_devices.sql).

### TTS-only (announce-chime dropped 2026-05-07)

Originally a per-device `dps_config.notify_type` flag picked between `'announce'` (Echo chime + broadcast voice) and `'tts'` (plain TTS) — needed because the Samsung soundbar silently drops `data.type='announce'` calls. That whole machinery was removed once the Speech Settings card landed: SSML markup (rate / voice / volume) is **only honored in TTS mode**, so any device that wanted speech control would have had to be on TTS anyway. Standardizing every device on plain TTS makes one notify path, one validation surface, and lets the global speech settings apply uniformly. The user reported they did not actually hear the Echo chime in testing — no UX loss.

### Global Speech Settings (since 2026-05-07)

One row in `dashboard_settings.media-agents.alexa_speech` holds three keys, applied to every Alexa device's notify call (Speak buttons + Saved Announcements + rule chips):

| Key | Range / values | Maps to |
|---|---|---|
| `rate_pct` | 50..100 (%) | `<prosody rate="N%">` — 100 omits the attribute (default) |
| `voice` | one of `Matthew/Joanna/Salli/Joey/Justin/Kendra/Kimberly/Ivy/Brian/Amy` or null | `<voice name="…">` — null omits the tag |
| `loudness_db` | -20..0 | `<prosody volume="-NdB">` — 0 / null omits the attribute |

**Why speed only goes 50..100 (not 50..200):** user only wanted finer control between Very slow and Normal. Fast / very-fast were dropped per request — a slider step of 1% gives smooth control on the slow side.

**Why loudness is attenuate-only (-20..0 dB):** Alexa's TTS reference level is the **ceiling** for this hardware. SSML `<prosody volume="x-loud">` and `+NdB` deltas are silently ignored by the Samsung soundbar (and likely by Alexa cloud's TTS pipeline more generally). `silent` does work — confirmed by direct test on the soundbar 2026-05-07. So the slider exposes only the working range. To make announcements feel **louder relative to TV audio**, the user lowers TV volume manually; we don't bump device hardware volume because that also raises TV audio mixed via HDMI ARC.

**Why we abandoned `volume_set` save→set→speak→restore:** Alexa's cloud takes ~800-1500 ms between the HTTP POST and the actual TTS audio reaching the device. If we set volume up before the notify, TV audio (mixed in via ARC) gets loud for that gap. Can't time the volume bump to land exactly on the TTS frame. SSML `<prosody volume>` doesn't have this problem because it shapes only the announcement audio inside Alexa's pipeline, not the soundbar's hardware level.

`server.js` and `rule_engine.py` both read settings at fire-time (no cache) so dashboard edits propagate to the next say without restart. Per-call override (`loudness_db` in the request body, `loudness_db` in a rule cmd dict) wins over the global value.

### Card visual semantic (since 2026-05-08)

| Element | State | Meaning |
|---|---|---|
| Status dot | green | Device is online (any reachable state — idle / paused / standby / on / playing) |
| Status dot | grey | Device is `unavailable` or `off` |
| Device name | red | Device is **actively playing** music (state==='playing') OR a dashboard-initiated TTS announcement is in flight |
| Device name | default | Anything else |

The dot color **does not** change when audio is active — that's the name's job. Reason: a brief red flash on the dot during a 3 s announcement was the original implementation but the dot color was already busy carrying the online/offline signal, so we split: dot = reachability, name = activity.

**Speaking-state tracking for announcements:** Alexa's `notify.alexa_media` does **not** transition the entity's `state` to `playing` for TTS — it overlays without flipping state. To still show the name red during an announcement, [`speakAlexa()` in server.js](../BOILER/dashboard/server.js) marks every target in `_alexaSpeakingUntil` for an estimated TTS duration (~12 chars/sec + 1.5 s pad). [`/api/alexa/devices`](../BOILER/dashboard/server.js) surfaces a `speaking` boolean per device that the card render OR-combines with `state === 'playing'`. Caveat: only **dashboard-initiated** announcements (Speech Settings test, per-card Speak button, Saved Announcements) flip the flag — rule-fired chips do not (the rule engine doesn't currently signal back to the dashboard's tracker). If we ever want red-name on rule-fired announcements too, the path would be an MQTT pub from `_dispatch_alexa.say` that the dashboard subscribes to.

### Dashboard tab — Media Agents → Alexa Devices

`BOILER/dashboard/public/media.html` adds a 4th tab. Layout, per Echo:
- **Status row** (status dot · room · state) + On/Off buttons
- **Volume slider** + mute (slider position locked for 3 s after user touches it, so the 5 s poll doesn't snap it back mid-drag)
- **Transport row** (⏮ ▶ ⏸ ⏹ ⏭) — these only resume / control already-loaded media, they don't START playback from idle
- **Saved-stations row** — clickable buttons of all saved stations (shared across cards), each with a × to delete. Click a station → plays on THIS Echo
- **Play input + ▶ Play + 💾 Save** — type any phrase, click ▶ for one-shot playback OR 💾 to save it as a station for reuse

**Two saved-station presets seeded on first load:**
- `ON 50s` → content_type=`TUNEIN`, content_id=`s307975` (1.FM oldies station — voice phrase "ON 50s" is NOT recognized by Alexa, only the direct TuneIn ID works)
- `Elvis Presley` → content_type=`DEFAULT`, content_id=`Elvis Presley` (Alexa interprets phrase like a voice command — picks an artist station automatically)

Storage: `dashboard_settings.media-agents.alexa_quick_music` (JSONB array of `{id, name, content_id, content_type}`). Key name kept after a UI rename so existing data survives.

**Saved Announcements card** below the device cards — TTS templates with target dropdown (single Echo or "All devices"), list of saved messages with Speak / Edit / Del. **Inline form** (Name + Message + 💾 Save) is used for both create + edit (since 2026-05-07 — replaced browser `prompt()` which silently failed in some tab states, sometimes returning null without surfacing an error). Volume override field on this card was removed 2026-05-07 — Speech Settings card (rate / voice / loudness) is the single source of truth for speech parameters; per-template loudness can still be carried in the template object's `loudness_db` key (the engine reads it as a per-call override at fire-time). Storage: `dashboard_settings.media-agents.alexa_announcements`.

### Server endpoints (all in `BOILER/dashboard/server.js`)

All call HA's REST API via the existing `callHA(domain, service, data)` helper at `server.js:2810`. None of these touch LXC 100.

| Endpoint | Calls | Purpose |
|---|---|---|
| `GET  /api/alexa/devices` | `GET /api/states/<entity_id>` per device | List 4 devices + live HA state |
| `POST /api/alexa/:entity/say` body=`{message,loudness_db?}` | `notify.alexa_media` (plain TTS, SSML wrap with global rate / voice / loudness) | Speak on one device |
| `POST /api/alexa/announce` body=`{message,targets[],loudness_db?}` | `notify.alexa_media` with array target | Multi-cast — same SSML applied to all targets |
| `POST /api/alexa/:entity/volume` body=`{level: 0..1}` | `media_player.volume_set` | |
| `POST /api/alexa/:entity/mute` body=`{mute: bool}` | `media_player.volume_mute` | |
| `POST /api/alexa/:entity/play_media` body=`{content_id, content_type?}` | `media_player.play_media` | Start new playback (radio / song / phrase) |
| `POST /api/alexa/:entity/{play\|pause\|stop\|next\|prev\|turn_on\|turn_off}` | `media_player.<corresponding>` | Whitelisted transport dispatch |

### Rule integration

Rule sentences can target Alexa devices via chips (parsed by [`RULES/_display_chips.py`](../RULES/_display_chips.py)):

| Token | Result |
|---|---|
| `@<EchoName> say "<message>"` | TTS announcement, free-form text (parser keeps recognizing this but the dashboard device picker no longer surfaces it — saved templates are the supported path; `say` stays for back-compat with existing rules) |
| `@<EchoName> play "<phrase>"` | Start playback (always content_type=DEFAULT — see limitation) |
| `@<EchoName> on` | turn_on |
| `@<EchoName> off` | turn_off |
| `@<EchoName> stop` | media_stop |
| `@<EchoName> pause` | media_pause |
| `@<EchoName> resume` | media_play (resume already-loaded media) |
| `@<EchoName> next` | media_next_track |
| `@<EchoName> prev` | media_previous_track |
| `@<EchoName> vol <N>` | volume_set (N=0..100, dispatch divides by 100) |
| `@<EchoName> speak <TemplateName>` | Look up template name in `dashboard_settings.media-agents.alexa_announcements`, apply optional `default_volume` / `loudness_db`, fire `notify.alexa_media` with the global SSML wrap (rate / voice / loudness). Template lookup at fire-time so user edits propagate without rule reload. **Renamed from `announce` 2026-05-07** per user request — `announce <TemplateName>` is still recognized by the parser as an alias so existing rules keep firing. |

### Bindings — Wallmote / Panel / Smart Switch (since 2026-05-07)

Alexa devices can be bound to button presses across **5 binding pages** (one shared rule pattern, one shared helper):

| Page | Storage | Rule handler |
|---|---|---|
| Living Room → Wallmote | `dashboard_settings.living-room.wallmote_bindings` | `RULES/rules/wallmote_handler.py` |
| Balcony Agent → Panel buttons | `hasp_buttons.bindings` (per-row JSONB, `panel_id` = balcony) | `RULES/rules/balcony_buttons.py` |
| Balcony Agent → Smart Switch | `dashboard_settings.balcony.smart_switch_bindings` | `RULES/rules/balcony_smart_switch_handler.py` |
| My BathRoom Agent → Panel buttons | `hasp_buttons.bindings` (panel_id = my-bathroom) | `RULES/rules/my_bathroom_buttons.py` |
| My BathRoom Agent → Smart Switch | `dashboard_settings.my-bathroom.smart_switch_bindings` | `RULES/rules/my_bathroom_smart_switch_handler.py` |

Each picker, when the user expands an Alexa device row, replaces the standard `turn_on/turn_off/toggle` dropdown with a grouped one:

```
── Speak ──         (one option per saved announcement template)
── Play music ──    (one option per saved station)
── Stop ──          stop
```

No transport (pause / resume / next / prev) and no power (turn_on / turn_off) — those were dropped at user request 2026-05-07 ("only play muzic or annonce saved thats all"). `stop` was added as the counterpart to `play` so a binding can both start and stop music.

Binding shape on disk extends with two optional fields:

```json
{ "device_id": "media_player.alexa_balcony", "channel": null,
  "name": "Alexa Balcony", "label": "",
  "action": "speak" | "play" | "stop",
  "template_name": "<saved announcement name>",   // when action='speak'
  "station_name":  "<saved station name>"         // when action='play'
}
```

Lookups happen at **fire time** in the rule handler (not bind time), so renaming a template or station doesn't break existing bindings — same pattern as `speak` chips in rules.

**Shared helper** [`RULES/_display_chips.py:build_alexa_cmd`](../RULES/_display_chips.py) — all 5 rule handlers import it and call it before falling through to their generic toggle/turn_on logic. Returns a fully-formed cmd dict with the right `protocol='alexa'`, `action='announce_template'|'play_station'|'media_stop'`, and the template/station name passed through. The rule engine's `_dispatch_alexa` resolves `play_station` against `dashboard_settings.media-agents.alexa_quick_music` to derive `content_id` + `content_type`, then routes to `play_media`.

**Bug worth knowing**: `living-room.js` originally channel-expanded any device whose `dps_config.<key>` had `action_on` — including Alexa devices' `dps_config.power` (used purely by the Devices page on/off chip). That surfaced "Alexa Balcony — Power" / `alexa · Ch.power` rows in the Wallmote bindings picker. Fixed by gating `actionChans` on `protocol ∈ {'esp','hasp','awtrix'}` so Alexa falls through to the single-row else branch (channel=null). `balcony.js` and `my-bathroom.js` were already gated to `'esp'` only — same effect.

`RULES/rule_engine.py` `_dispatch_alexa()` (called from the protocol='alexa' branch around line 1198) makes a direct `urllib.request.urlopen` POST to `/api/services/<domain>/<service>` with `HA_TOKEN` from environment. Same pattern `boiler_agent.py` already uses for valve control. No `requests` library dependency. Errors logged but never raise.

**Required env on LXC 105** (`/etc/rule-engine.env`):
```
HA_URL=http://192.168.1.110:8123
HA_TOKEN=<HA long-lived access token>
```

### Last-seen via ARP scan (no rule-engine polling)

Each `devices.mac` is populated with the Echo's LAN MAC; `GET /api/devices` LEFT JOINs `net_devices` on `lower(mac)` so `local_ip` and `last_seen` are filled in live from the ARP scanner (5-min cadence on LXC 104). Same pattern Pixoo / HASP / Awtrix already use. **No rule-engine heartbeat poll** for Alexa freshness — an earlier prototype existed but was removed 2026-05-07 once the MAC-link wiring made it redundant. The dashboard's Alexa Devices tab still gets live HA-side state (volume, media_title, etc.) on its own 5 s poll via `/api/alexa/devices`; that's separate from the LAN-presence indicator on the Devices page.

If HA goes down, the Echo is still on the LAN and ARP-scan still says "Online". The dashboard's Alexa Devices tab will show the device as `unavailable` (HA's view) at the same time. That's fine — these are two different indicators.

### Known limitations

- **`@<Echo> play "s307975"` rule chip currently uses content_type=DEFAULT.** The dashboard UI auto-detects `s\d+` patterns and switches to TUNEIN, but the chip parser doesn't. If a rule needs a TuneIn station, it has to use the dashboard's saved station instead, or the parser needs an extension.
- **No state polling for `media_player` entities into `device_events`.** The HA WebSocket adapter on LXC 103 restricts itself to external devices; Alexa entity state changes flow only when the dashboard polls `/api/alexa/devices`. Sufficient for the use cases above.
- **HA going down breaks Alexa control + announcements.** Direct AlexaPy would survive HA outages but would duplicate cookie auth — explicit trade-off accepted in the integration plan.
- **Voice control of OUR devices** ("Alexa, turn on the boiler") requires building an Amazon Smart Home Skill (different integration path entirely — not in scope).

## CD Player tab (Bedroom — IR via HA scenes, since 2026-06-13)

A **CD Player** tab on the Media Agents page (`media.html`, between Alexa Devices and Settings) controls the **Bedroom CD player**. The player is IR-only — it is **not** a `media_player` entity. HA exposes 5 scenes (fired through the Maya Bedroom IR remote hub) that emit the IR codes:

| Button | Action | HA scene |
|--------|--------|----------|
| ▶ Play | `play` | `scene.cd_bedroom_play` |
| ⏹ Stop | `stop` | `scene.cd_bedroom_stop` |
| 🔉 Vol − | `vol-down` | `scene.cd_vol` |
| 🔊 Vol + | `vol-up` | `scene.cd_vol_2` |
| ⏻ Power | `power` | `scene.cd_on_off` |

**Flow:** button → `POST /api/cd/:action` → **`routes-media-cd.js`** (own module, wired into server.js via one `require()` line + gets the hoisted `callHA`; architecture-guard reason) → `callHA('scene','turn_on',{entity_id})`. Front-end `cdSend(action, btn)` in `js/media.js` (cache-bust bumped to `?v=113`) flashes a "Sent ✓" confirmation.

**Limitation (hardware, not code):** IR is one-way → **no status feedback**. The tab is command-buttons only — no play/stop state, no track info, no volume level; **Power is a toggle** (sends the on/off IR pulse; can't know current power state). To add Pause / Next / Prev / Eject, first learn those IR codes into new HA scenes, then add buttons + entries to `CD_SCENES` in `routes-media-cd.js`.
