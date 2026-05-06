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

`analyzer.py` is **patched directly on LXC 100** — no local copy is source of truth. After any patch: `systemctl restart analyzer` required (it's a persistent process).

## Supporting Scripts on LXC 100 (not in local repo)

| Script | Role |
|--------|------|
| `/opt/media-agent/scan_library.py` | Called by ingest_service to walk MEDIA_MOUNT, hash files, return new-file list |
| `/opt/media-agent/gen_results.py` | Generates search result image (JPEG) for TV display via DLNA |
| `/opt/media-agent/face_register.py` | Extracts 512-dim ArcFace embedding from a photo; server.js spawns it and inserts result into `face_registry` |
| `/opt/media-agent/face_recognize.py` | Matches faces in image/video against `face_registry`; cosine similarity ≥ 0.5; 1 frame/120s for video |
| `/opt/media-agent/venv/` | Python venv: InsightFace, psycopg2, flask, numpy, cv2, flask-cors |

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

### Playback flow

> ⛔ **HARD RULE: Video ALWAYS uses MiniDLNA. Never replace the MiniDLNA URL for video.**
> Samsung TV requires DLNA-specific response headers (`contentFeatures.dlna.org`, `transferMode.dlna.org`) that only MiniDLNA provides. Bypassing MiniDLNA for video causes the TV to accept the SOAP command but silently refuse to render the stream.

- **Video**: `minidlna_id()` looks up file in MiniDLNA SQLite DB → stream URL is `http://192.168.1.138:8200/MediaItems/{id}.{ext}` → Samsung UPnP `SetAVTransportURI` + `Play` SOAP call. This must never be changed to a direct Flask endpoint.
- **Audio**: token URL generated per play session — `_stream_tokens[hex_token] = full_path` → `http://192.168.1.138:8766/api/media/token/{token}` (pure ASCII). Required because Samsung TV rejects `SetAVTransportURI` if the URL contains non-ASCII or spaces, even when percent-encoded. Token route supports full Range requests.
- **Search results image**: `gen_results.py` generates PNG → served by player_service via `/api/media/results-image`
- MiniDLNA SIGHUP: `os.kill(int(pid_file), signal.SIGHUP)` — no shell subprocess
- Samsung TV: IP `192.168.1.129`, port 9197, path `/upnp/control/AVTransport1`
- TV control proxied through `tv_control.py` on port 8765 (LXC 100 local)
- DIDL-Lite `<res>` element **must include** `protocolInfo="http-get:*:<mime>:*"` — Samsung rejects SetAVTransportURI without it
- `_current_duration` global: set from `media_library.duration_sec` when play starts; used by `/api/media/position` as fallback when TV returns duration=0 (enabling dashboard progress bar)

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
| `/api/media/stream/<path>` | GET | Range-request audio streaming (direct path — use token for DLNA) |
| `/api/media/token/<token>` | GET | Range-request streaming via ASCII token (used for DLNA playback) |
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
- Playback bar: title, time, progress, ⏪30s / ⏸Pause / 30s⏩ / ⏹Stop, seek ±30s
- Playback bar **auto-restores on page load/navigation** — on init, `GET /api/media/position` is called; if duration>0 and position<duration, playback bar is shown immediately (fixes disappearing controls when navigating away and back)
- QNAP Media browser: grid of files/folders, breadcrumb navigation, play on click
- Edit metadata modal: event, year, location, people fields, Save + Delete buttons

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

Four Amazon Alexa devices are integrated via the **Home Assistant `alexa_media_player`** community integration. They are **NOT** in LXC 100's scope — Echo devices have no local API and are cloud-tied to Amazon. The dashboard tab wraps HA's existing service calls (Path A1 — chosen over direct AlexaPy or Smart Home Skill because HA already has the cookie auth working and adding a parallel Python service would just duplicate work).

### Device registry (`devices` table, protocol='alexa')

| HA entity (= devices.id) | name | room |
|---|---|---|
| `media_player.10inch_echo_show`  | Alexa Balcony       | Balcony     |
| `media_player.alexa_my_bathroom` | Alexa My Bathroom   | My BathRoom |
| `media_player.alexa_maya_bedroom`| Alexa Maya Bedroom  | Bedroom |
| `media_player.alexa_guy_room`    | Alexa Guy Room      | Guy Room |

Each row carries `dps_config = {power: {action_on:turn_on, action_off:turn_off}, volume: {type:range, min:0, max:100}}` so the Devices page renders the panel and rule chips can pick up actionable channels. Migration: [`MEDIA/migrations/alexa_devices.sql`](migrations/alexa_devices.sql).

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

**Saved Announcements card** below the device cards — TTS templates with target dropdown (single Echo or "All devices"), optional volume override, list of saved messages with Play/Edit/Delete. Storage: `dashboard_settings.media-agents.alexa_announcements`.

### Server endpoints (all in `BOILER/dashboard/server.js`)

All call HA's REST API via the existing `callHA(domain, service, data)` helper at `server.js:2810`. None of these touch LXC 100.

| Endpoint | Calls | Purpose |
|---|---|---|
| `GET  /api/alexa/devices` | `GET /api/states/<entity_id>` per device | List 4 devices + live HA state |
| `POST /api/alexa/:entity/say` body=`{message,volume?}` | `notify.alexa_media` (data.type=announce) + optional `media_player.volume_set` | Speak on one Echo |
| `POST /api/alexa/announce` body=`{message,targets[],volume?}` | `notify.alexa_media` with array target | Multi-cast announcement |
| `POST /api/alexa/:entity/volume` body=`{level: 0..1}` | `media_player.volume_set` | |
| `POST /api/alexa/:entity/mute` body=`{mute: bool}` | `media_player.volume_mute` | |
| `POST /api/alexa/:entity/play_media` body=`{content_id, content_type?}` | `media_player.play_media` | Start new playback (radio / song / phrase) |
| `POST /api/alexa/:entity/{play\|pause\|stop\|next\|prev\|turn_on\|turn_off}` | `media_player.<corresponding>` | Whitelisted transport dispatch |

### Rule integration

Rule sentences can target Alexa devices via chips (parsed by [`RULES/_display_chips.py`](../RULES/_display_chips.py)):

| Token | Result |
|---|---|
| `@<EchoName> say "<message>"` | TTS announcement (single or double quotes accepted) |
| `@<EchoName> play "<phrase>"` | Start playback (always content_type=DEFAULT — see limitation) |
| `@<EchoName> on` | turn_on |
| `@<EchoName> off` | turn_off |
| `@<EchoName> stop` | media_stop |
| `@<EchoName> pause` | media_pause |
| `@<EchoName> resume` | media_play (resume already-loaded media) |
| `@<EchoName> next` | media_next_track |
| `@<EchoName> prev` | media_previous_track |
| `@<EchoName> vol <N>` | volume_set (N=0..100, dispatch divides by 100) |
| `@<EchoName> announce <TemplateName>` | Look up template name in `dashboard_settings.media-agents.alexa_announcements`, apply optional `default_volume`, fire `notify.alexa_media`. Template lookup at fire-time so user edits propagate without rule reload. |

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
