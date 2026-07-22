# Projector Agent

> **Status:** PLANNED / scoped 2026-06-10. Hardware not yet purchased. This doc is the design + integration contract for when the gear arrives. No DB rows, dashboard surface, or service exist yet.
>
> **Hard constraint (user):** controlled by **OUR OWN integration — NO Home Assistant.** Everything talks direct over the LAN from `device_agent` (LXC 103) → MQTT `mur/home/device/#` → `devices` table → dashboard (UI only). Matches the root HARD ARCHITECTURE RULE.

Balcony home-theater built from three boxes (a projector is not "smart" and an audio amp doesn't run video apps, so all three are required — no single box combines video-streaming + speaker-amp):

| Role | Hardware | Decision |
|------|----------|----------|
| **Display** | **Optoma projector** — candidates **Photon Beam PK52** (recommended) vs **UHD38x** | ⏳ pending — see comparison below |
| **Brain (video)** | **Xiaomi Android TV streamer** (Mi Box S / TV Stick 4K) | ✅ chosen |
| **Audio** | **WiiM Amp** (regular, *not* Pro) + passive speakers | ✅ chosen |

---

## Projector decision — PK52 vs UHD38x (at 3 m throw)

| | **Photon Beam PK52** | **UHD38x** |
|---|---|---|
| Screen @ 3 m | **~112″** (throw ratio 1.21–1.59:1) | ~82–90″ |
| Lens shift | ❌ **none** — digital keystone only (H/V 30°, auto-vertical) + fixed 105% offset | ❌ none (exact mount height) |
| Light source | 4K **DuraCore laser** — 30,000 h, no lamp swaps | 4K **lamp** (consumable) |
| Brightness | 3500 lm | 4000 lm |
| **RS-232 serial control** | ✅ | ✅ (DB-9) |
| **LAN / RJ45** | ❌ **no** | ❌ **no** |
| **HDMI-CEC** | ✅ | ✅ |
| **Digital audio out → WiiM** | ❌ **none — no ARC, no optical** (3.5 mm analog only) | ✅ **Optical S/PDIF** |
| 3.5 mm analog audio out | ✅ | ✅ |
| 12 V trigger (motorized screen) | ✅ | ✅ |
| Always-on rated | ✅ **24/7 + 360°** (good for a continuous aquarium) | not rated 24/7 |
| Built-in smart / Wi-Fi | ❌ (needs Xiaomi) | ❌ (needs Xiaomi) |

**Recommendation: still PK52** for a balcony — bigger image (~112″), **laser light source (30,000 h, no lamp swaps)**, and **24/7 + 360° rated** (ideal for an always-on aquarium). Honest trade-offs vs UHD38x: **no lens shift** (both rely on keystone anyway) and **no digital audio out** (3.5 mm analog only — or add an HDMI extractor; the UHD38x's optical out is the cleaner audio path). Pick UHD38x if clean optical audio to the WiiM + lower cost matter more than image size and laser longevity.

> **Corrections (2026-06-10, against the official PK52 spec sheet):** earlier notes claimed the PK52 had **lens shift** and **HDMI ARC** — both are WRONG. The PK52 has **digital keystone only** (H/V 30° + auto-vertical, fixed 105% offset) and **no ARC / no optical** (3.5 mm analog audio out only). Sources had conflicted; the official spec is authoritative.

**Placement note (no lens shift):** the PK52 aligns the image with **digital keystone** (H/V 30°, auto-vertical) on a **fixed 105% offset**, not optical shift. Keystone on a 4K projector slightly softens the picture, so mount it square to the screen at the right height and use keystone only for fine trim.

**Screen sizing reference (16:9):** width = diagonal × 0.872, height = diagonal × 0.490. So 82″ = 181 cm wide, 90″ = 199 cm wide, 100″ = 221 cm wide (≈ 125 cm tall). A **100″ image needs the PK52** (out of UHD38x's reach at 3 m).

**Brightness reality:** for **evening / after-dark** balcony use, 3500 lm is plenty; 3500 vs 4000 is only ~14% (below the just-noticeable threshold). Ambient light is the dominant factor — **no consumer projector looks good in daylight**. An ALR screen helps far more than 500 lm.

---

## Control — OUR integration, over LAN, no HA

| Device | Direct protocol | Method |
|--------|----------------|--------|
| **Projector** (PK52 / UHD38x) | RS-232 ASCII commands | ⚠️ **both are RS-232-only, no LAN** → add a **RS-232 → Ethernet adapter** (serial device server, ~$25, e.g. USR-TCP232). LXC sends Optoma ASCII over TCP → adapter → serial. **HDMI-CEC** is the free on/off fallback (Xiaomi wake powers the projector); IR via a dedicated IR blaster board (TBD) as last resort. |
| **Xiaomi streamer** | Android TV Remote v2 (TLS) + Cast | **`androidtvremote2`** (power / nav / app launch) + **`pychromecast`** (cast video/audio/stations). One-time 6-digit pairing; token stored locally. |
| **WiiM Amp** | **LinkPlay HTTP API** | plain HTTP GET — `http://<ip>/httpapi.asp?command=…` : `setPlayerCmd:vol:NN`, `:pause`, `:play:<url>`, `getPlayerStatus`. Trivial to wrap. |

All three run as `device_agent` adapters on LXC 103, publish to MQTT, write `devices.last_state` — same shape as the local Tuya devices. Dashboard stays UI-only. **No HA in the path.**

> Note: the original "Telnet :23" plan assumed a LAN port — neither home model has one. The RS-232→Ethernet adapter restores the exact same "control over TCP, no HA" behavior with one cheap box in between.

---

## Audio routing — depends on the model

How audio reaches the WiiM differs by projector (the PK52 has **no** ARC/optical — corrected 2026-06-10):

```
Xiaomi ──HDMI──► Projector ──(audio out)──► WiiM Amp ──speaker wire──► L + R speakers
                (video to screen)
```

- **UHD38x:** **Optical S/PDIF** out → WiiM Amp optical in (digital, **no extractor needed**).
- **PK52:** ⚠️ **no ARC, no optical — 3.5 mm analog out only.** Two choices: (a) **3.5 mm analog → WiiM line-in** (stereo, simplest, no extractor), or (b) an **HDMI audio extractor** between the Xiaomi and the projector → optical → WiiM (digital). *(The earlier "PK52 via ARC, no extractor" was wrong — corrected against the official spec.)*
- **Music / radio:** push straight to the WiiM (cast / HTTP API) — projector not involved.

**Two things to set/verify on hardware:**
1. Set the **Xiaomi audio output = Stereo / 2-ch PCM** (WiiM digital inputs accept 2-ch PCM; a Dolby bitstream may not decode).
2. **Lip-sync** — routing movie audio through the projector can add latency; verify by eye. If bad, an HDMI audio extractor tapped *before* the projector avoids it.

**WiiM Amp vs Amp Pro:** get the **regular Amp** ($299). Same power (60 W/8Ω, 120 W/4Ω), same HDMI ARC + optical, same LinkPlay HTTP API. The Pro's gains (ES9038Q2M DAC, PFFB, auto room correction, Wi-Fi 6E, Roon) target a treated *indoor* room and are inaudible/irrelevant on an open balcony — not worth the +$80 here.

**Alternative audio hub (if you ever want surround / HDMI switching):** a small **AV receiver** (Denon/Marantz expose a **Telnet :23** control API; Yamaha has the **MusicCast HTTP/YNC** API) consolidates HDMI switching + decode + amp and is also LAN-controllable with no HA — but it's bigger/pricier and **still needs the Xiaomi**. Stick with the WiiM Amp for balcony stereo.

---

## Shopping list (PK52 path)

1. **Optoma Photon Beam PK52**
2. **Xiaomi Android TV streamer** (Mi Box S / TV Stick 4K — genuine Google TV, has Chromecast built-in)
3. **WiiM Amp** (regular)
4. **Passive speakers** — weather-rated for the balcony
5. **RS-232 → Ethernet adapter** (serial device server)
6. HDMI cable + speaker wire (no audio extractor, no optical cable — audio rides ARC)

---

## Implementation checklist (pending hardware)

1. `devices` rows: projector (RS-232-over-TCP sender), Xiaomi (androidtvremote2 + pychromecast adapter), WiiM (LinkPlay HTTP adapter).
2. New `device_agent` adapters for each on LXC 103 → publish to `mur/home/device/#`.
3. Dashboard control surface (UI only) calling the LXC API.
4. Optional **"Movie / Projector On" scene** (Main Agent → Scenes): Xiaomi wake → CEC powers projector → WiiM on + source → input select.
5. Validate on hardware: Optoma RS-232 power/source over the adapter, HDMI-CEC behavior, audio lip-sync, Xiaomi PCM setting.

---

## Sources

- [Optoma Photon Beam PK52 — ProjectorCentral / specs](https://www.projectorcentral.com/pdf/projector_manual_10211.pdf)
- [Optoma UHD38x specs — ProjectorCentral](https://www.projectorcentral.com/Optoma-UHD38x.htm)
- [Optoma RS232 Protocol Function List](https://www.optomausa.com/ContentStorage/Documents/471bc1d6-63f6-4825-aeef-2414e9cc5f99.pdf)
- [WiiM Amp vs Amp Pro — Crutchfield](https://www.crutchfield.com/compare_399WAMPPRO_399WIMAMPG/WiiM-Amp-Pro-vs-WiiM-Amp.html)
