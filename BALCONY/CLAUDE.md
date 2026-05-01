# Balcony Agent

OpenHASP touch panel mounted on the balcony. Manages physical controls (gates, barrier, lights) and surfaces live values.

This agent is **dashboard-only** — same pattern as Living Room and Corridor agents. No dedicated LXC service. Logic lives in the rule engine on LXC 105 (when added in later phases).

## Hardware

| Field | Value |
|---|---|
| **Model** | Sunton ESP32-S3 4848S040 |
| **MCU** | ESP32-S3-N16R8 (16 MB Flash, 8 MB PSRAM, dual-core 240 MHz) |
| **Display** | 4.0" IPS RGB LCD, 480 × 480, ST7701 driver via parallel RGB |
| **Touch** | GT911 capacitive multi-touch |
| **Audio** | Speaker amplifier present on board, but NOT compiled into the OpenHASP firmware on this device — no click sounds available |
| **Storage** | LittleFS in flash (~24 KB used of much larger partition) |
| **Power** | USB-C 5 V |

## Network + identity

| Field | Value |
|---|---|
| Plate name (mqtt) | `balcony` (renamed from default `plate01` on 2026-04-30) |
| IP | `192.168.1.141` |
| MAC | `8c:bf:ea:0d:c3:24` |
| Hostname | `balcony` |
| Web UI | http://192.168.1.141 |
| Telnet console | port 23 (debug + manual HASP commands) |

## Firmware

| Field | Value |
|---|---|
| **Stack** | OpenHASP 0.7.0-rc12 (build 2024-05-23, env `esp32-s3-4848s040_16MB`) |
| LVGL theme | 2 (Material) — drives `@checked` accent via `color2` |
| `color1` | `#00b6ff` (cyan, used by nav row + accents) |
| `color2` | `#ff9962` (orange, the theme's `@checked` accent — appears on every toggled-on button) |
| GIF support | NOT compiled in (`obj":"gif"` returns `Failed to create object`) |
| Image rendering | Static images only via `obj":"img"`, requires LVGL native binary RGB565 — standard PNG/JPG/GIF do not render |

## MQTT topology

Broker: `192.168.1.189:1883` (LXC 107 mosquitto). Authenticated as user `hasp` (password in `BOILER/dashboard/.env` → `MQTT_HASP_PASS`).

Topic prefix: `hasp/balcony/`

| Direction | Topic pattern | Purpose |
|---|---|---|
| ← from panel | `hasp/balcony/LWT` | online/offline last will |
| ← from panel | `hasp/balcony/state/statusupdate` | full device info (every ~10 s) |
| ← from panel | `hasp/balcony/state/sensors` | uptime, internal sensors |
| ← from panel | `hasp/balcony/state/p<page>b<id>` | button events `{"event":"down"}`/`up`/`{"val":1}` |
| ← from panel | `hasp/discovery/<mac>` | auto-discovery payload (one-shot on connect) |
| → to panel | `hasp/balcony/command/<HASP cmd>` | run any HASP cmd (e.g. `page 12`, `clearpage 1`, `restart`) |
| → to panel | `hasp/balcony/command/jsonl` | runtime add/replace an object on a page |
| → to panel | `hasp/balcony/command/p<page>b<id>.<prop>` | mutate a single property (e.g. `p1b110.val=1` toggles button) |

The `hasp` MQTT user has `readwrite` on `hasp/#`, so the rule engine on LXC 105 (subscribed as `rule_engine`) and any future per-room agent can both observe events and command the panel.

## Current page layout (post 2026-05-01 redesign)

12 pages total. Pages 0 and 1 are the only ones we re-skinned; pages 2-9 are the user's original design (lights, watering, temperatures, music, parking, glide, clock).

| Page | Content |
|---|---|
| 0 (global) | Background `#111` + nav row at the bottom — appears on every page. The nav has `<` / 🏠 / `>` icons — the design's only constants. |
| **1 (re-skinned 2026-05-01)** | **4 toggle buttons** in 2 × 2 grid: **GATES** (id 110, dim navy), **BARRIER** (id 120, dim purple), **LIGHT 1** (id 130, dim green), **LIGHT 2** (id 140, dim amber). Each button is a `btn` with overlaid `label` for the icon (font 48) and another `label` for the name (font 24). Both labels carry `click:false` so taps fall through to the underlying button — without that, clicks were being intercepted and toggling required several taps. The `@checked` bg flashes orange uniformly (theme `color2` driven; per-button `bg_color@checked` is overridden by the theme). |
| 2 | Saloon Area / Balcony Area lights (original design) |
| 3 | Watering 1 / Watering 2 / … (original) |
| 4 | Temperatures: out / in / humidity (original) |
| 5 | Music: slider + rec/play (original) |
| 6 | Parking distance: Cal / Dist / Pos / Close (original) |
| 7 | Glide ticker (original) |
| 8 | Clock placeholder (`--:--`) (original — empty target for future content) |
| 9 | Almost-empty (original — empty target for future content) |
| 10, 11, 12 | Completely empty (free for future use) |

### Page 1 vertical layout (current 4 buttons)

```
y=0   ── (top of screen)
                     ↕ 50 px margin
y=50  ┌─ GATES ──────┐ ┌─ BARRIER ────┐
       │   icon       │ │   icon       │   each h=140
       │   GATES      │ │   BARRIER    │
y=190 └──────────────┘ └──────────────┘
                     ↕ 30 px gap
y=220 ┌─ LIGHT 1 ────┐ ┌─ LIGHT 2 ────┐
       │   icon       │ │   icon       │   each h=140
       │   LIGHT 1    │ │   LIGHT 2    │
y=360 └──────────────┘ └──────────────┘
                     ↕ 50 px margin
y=410 ── (top of nav row from page 0)
```

Per cell (top-left as the example, x=10..235):

| Object | id | x | y | w | h | font | role |
|---|---|---|---|---|---|---|---|
| `btn` | 110 | 10 | 50 | 225 | 140 | — | toggle, owns bg color |
| `label` (icon) | 111 | 10 | 65 | 225 | 60 | 48 | car glyph U+E10B (white, click:false) |
| `label` (name) | 112 | 10 | 135 | 225 | 40 | 24 | "GATES" (white, click:false) |

Same shape for `120/121/122 BARRIER`, `130/131/132 LIGHT 1`, `140/141/142 LIGHT 2`.

## Files in this folder

| File | Role |
|---|---|
| `pages.jsonl` | Mirror of `/pages.jsonl` on the device (downloaded from `http://192.168.1.141/pages.jsonl`). Source of truth for the panel's current design — version-controlled here. |
| `pages_backup.jsonl` | The original 8-button page-1 design + all of pages 2-9, captured 2026-05-01 before we re-skinned page 1. Use to revert if needed. |
| `build_pages.py` | Regenerates `pages_new.jsonl` from `pages_backup.jsonl` with the current 4-button design on page 1. Used when re-deploying the panel; uploads via `POST /edit` then `POST /reboot`. |

## DB rows for this panel

| Table | Row(s) |
|---|---|
| `hasp_panels` | 1 row, `name='balcony'`, IP `192.168.1.141`, mac `8c:bf:ea:0d:c3:24` (seeded by `server.js ensureSchema()` 2026-05-01) |
| `hasp_buttons` | 4 rows for page 1: GATES (110), BARRIER (120), LIGHT 1 (130), LIGHT 2 (140). `action_type` and `action_target` are NULL — wired in a later phase. |
| `hasp_displays` | 0 rows yet — value displays will be added when we drive live data onto the panel. |
