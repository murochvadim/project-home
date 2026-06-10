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

## TV Playback

### Devices controlled
| Device | Entity | Protocol |
|--------|--------|---------|
| Samsung 85" QLED | `tv` | Samsung UPnP SOAP + HA |
| Samsung Soundbar HW-Q990C | `soundbar` | HA |
| TV-60 Guy Room | `tv_guy` | HA |
| TV-49 Bedroom | `tv_bed` | HA |

### Power state + control source (updated 2026-06-10)
`tv_control.py` (`/opt/media-agent/tv_control.py`, **now also tracked at `scripts/tv_control.py`** — it was previously untracked) derives **power status from the HA `media_player.*` entity, NOT the SmartThings `switch.*`**. The SmartThings switches lag badly — they don't reflect a *remote-initiated* power-on, so they sat at stale `off` for hours while the TV + soundbar were physically on (the "shows off while on" bug). Helper `mp_power(player, fallback_switch, idle_is_on=True)` maps `on`/`idle`/`playing`/`paused`/`buffering` → on, `off`/`standby` → off, and falls back to the `switch` only when the media_player is `unavailable`/`unknown`. (The device-agent's `ha_api.py` already had `media_player.samsung_85_qled` as the fresh source, so the Devices/Power pages were already correct.) **Soundbar exception (fix 2026-06-10):** the soundbar calls `mp_power(pl, sw, idle_is_on=False)` because `media_player.samsung_soundbar_2` sits at `idle` as a Cast endpoint **even in standby** — counting `idle` as on made a powered-OFF soundbar show ON (regression from the same-day `f479ac9` that first introduced `mp_power`). With `idle` excluded for the soundbar, it falls through to `switch.samsung_soundbar`, which reports the real power state accurately. The TV keeps `idle_is_on=True` (its SmartThings switch genuinely lags on remote-on, so the media_player is the better signal there).

**Control is HA-only.** The SmartThings **Personal Access Token (`ST_TOKEN` in `/etc/environment`) is expired** — Samsung now expires PATs in 24 h, and `st_cmd()` was silently failing (401, return value discarded). Soundbar + TV-Bed power/volume/mute/source were migrated off `st_cmd` onto HA `media_player` services: soundbar = `media_player.samsung_soundbar_2` (features 318399 → turn_on/off, volume_set, mute, select_source), TV-Bed = `media_player.samsung_q49_ba_tv`. Soundbar volume_up/down uses `ha_sb_volume()` (read `volume_level` + `volume_set ±0.05`) because the soundbar has `VOLUME_SET` but **not** `VOLUME_STEP`. **Residual:** the soundbar **source/input list is empty** (it came from SmartThings via `st_get`; HA exposes no `source_list` for it) — power/volume/mute work, only the source picker is degraded until a fresh PAT is added. The `st_get()` state reads in `media_state()` still target SmartThings but 401 harmlessly → `None`, with HA covering power/volume. TV (`tv`) + TV-Guy (`tv_guy`) were already HA-only.

### Playback flow

> ⛔ **HARD RULE: Video ALWAYS uses MiniDLNA → TV. Audio ALWAYS uses Cast → Soundbar.**
> Samsung TV requires DLNA-specific response headers (`contentFeatures.dlna.org`, `transferMode.dlna.org`) that only MiniDLNA provides; bypassing MiniDLNA for video causes the TV to accept SetAVTransportURI but silently refuse to render the stream. The TV's UPnP music app is broken for mid-queue switching — many days of UPnP workarounds (KEY_RETURN, session reset, etc.) produced no reliable solution. **Audio routes through the Samsung 990C soundbar's built-in Chromecast** (port 8009), which has native gapless queue support and zero music-app weirdness.

- **Video** (`device_type=video`): `minidlna_id()` looks up file in MiniDLNA SQLite DB → stream URL is `http://192.168.1.138:8200/MediaItems/{id}.{ext}` → Samsung UPnP `SetAVTransportURI` + `Play` SOAP call to TV at `192.168.1.129:9197/upnp/control/AVTransport1`. This must never be changed to a direct Flask endpoint. The `_wake_and_play` helper handles the full sequence: TV-on (WoL via tv_control.py if needed) → wait for UPnP ready → Stop → wait STOPPED → SetAVTransportURI (with `protocolInfo="http-get:*:<mime>:*"` on `<res>`) → wait STOPPED → Play with 3-retry → verify PLAYING. Generation counter (`_play_gen` / `_is_play_gen_current`) ensures only the latest call's SOAP commands hit the TV when rapid Next clicks queue up.
- **Audio** (`device_type=audio`): single `pychromecast` connection to the soundbar (cached module-level in `_cast_obj`, reconnects automatically). `_cast_play_url(url, title)` calls `mc.play_media(url, 'audio/mpeg', title=...)`. The default media receiver (`CC1AD845`) launches on the soundbar and plays the stream. Stream URL prefers MiniDLNA library path (`http://192.168.1.138:8200/MediaItems/{id}.{ext}`); falls back to Flask token endpoint when not indexed.
- **Search results image**: `gen_results.py` generates PNG → served by player_service via `/api/media/results-image`
- MiniDLNA SIGHUP: `os.kill(int(pid_file), signal.SIGHUP)` — no shell subprocess
- DIDL-Lite `<res>` element on video calls **must include** `protocolInfo="http-get:*:<mime>:*"` — Samsung TV rejects SetAVTransportURI without it
- `_current_duration` global: set from `media_library.duration_sec` when play starts; used by `/api/media/position` as fallback when TV returns duration=0 (enabling dashboard progress bar — video path only; audio uses Cast's native position reporting)

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
| `POST /api/media/yt-dlp/start` body=`{url, folder, create_playlist, auto_split}` | Spawn `yt-dlp -f bestaudio[ext=m4a]/bestaudio --extract-audio --audio-format m4a --newline -o /mnt/media/Music/<folder>/%(playlist_index)03d - %(title)s.%(ext)s URL` as a background subprocess. `auto_split` adds `--write-description` so the description text is saved alongside as a `.description` sidecar. Returns `{job_id, folder, target_dir}` |
| `GET  /api/media/yt-dlp/status/<job_id>` | Poll the in-memory job state. Returns `{state: running\|done\|error, tracks: [{name,status}], elapsed_sec, error, folder, playlist_id, playlist_error, split_summary}`. Tracks list updates in real time as yt-dlp emits `[download] Destination:` and `[download] 100%` lines (parsed by `_yt_reader` background thread) |

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
- All commands via `POST /api/media/command`

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
- **Download from YouTube card** (since 2026-05-27, Phase 1) — sits between QNAP Media and Playlists cards on the Player Agent tab. Paste a URL (single video OR `?list=PL...` playlist) → click 🔍 Detect to auto-fill the folder field with the sanitized playlist/video title → click ▶ Download. yt-dlp on LXC 100 (installed 2026-05-27 — `pip3 install --user yt-dlp 2026.03.17`; ffmpeg was already system-installed) pulls `bestaudio[ext=m4a]` via the canonical command line documented in `youtube_playlist_integration.md`. Progress area below the form shows per-track status pills (`downloading` → `done`) as yt-dlp emits `[download] Destination:` and `[download] 100%` lines, parsed live by the `_yt_reader` background thread on the server. Two checkboxes (both default ON) shape behavior:
  - **Create playlist after download** — auto-INSERTs a `media_playlists` row with all files in the target folder, so the new playlist appears as a ▶ Play card in the Playlists row immediately on completion (`loadPlaylists()` re-renders). Uncheck if you want to merge tracks into an existing playlist manually via 🔍 Unassigned.
  - **Auto-split compilations** — saves the YouTube description as a `.description` sidecar (via `--write-description`), then post-download `_yt_try_split` parses the description for `MM:SS` / `HH:MM:SS` timestamps. If 2+ found, ffmpeg (`-c copy`, lossless) splits the single .m4a into `NNN - Title.m4a` files; the original full file + description are deleted. Handles common compilation-video layouts (timestamps in parens like `Track Name — Artist (17:18)`, OR plain `17:18 - Track`, OR with track-number prefix `06. Track …`). No-op when no timestamps are detected. Caught a real-world case 2026-05-27: a 1h25min "ПЕСНИ НАШЕГО ДВОРА" compilation with 24 song timestamps in description, no embedded chapter metadata — split into 24 individual tracks in ~5 sec via ffmpeg copy-mode.
  - Title h2 carries a `title=` tooltip explaining both checkboxes in 3 lines.
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
