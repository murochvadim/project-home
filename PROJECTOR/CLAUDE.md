# Projector Agent

> **Status:** PLANNED / scoped 2026-06-10. Hardware not yet purchased. This doc is the design + integration contract for when the gear arrives. No DB rows, dashboard surface, or service exist yet.

Home-theater playback surface built from two boxes:

| Role | Hardware | Job |
|------|----------|-----|
| **Display** | **Optoma HD30LV** (Full HD 1080p, 4500 lm DLP) | the "dumb" screen — power on/off, input select, status. No smart-TV apps, no WiFi. |
| **Brain** | **Chromecast with Google TV 4K** (Android TV / Google TV) | what actually *plays* — video, music, internet-radio stations; navigation; app launch; volume. |

Design decision (confirmed with user 2026-06-10): **projector controlled DIRECT over LAN; Chromecast controlled VIA HA.** Both *can* be done either way, but this split is the sweet spot — the projector is a trivial TCP socket (matches the local-Tuya pattern), while HA already wraps the Chromecast's two control protocols and handles their re-pairing/tokens/reconnects for free.

---

## Optoma HD30LV — control (DIRECT over LAN)

Confirmed connectors: **RJ-45 wired LAN**, 2× HDMI (1.4a + 2.0), USB, 3.5 mm audio-out, 3 W mono speaker. No WiFi. Supports Crestron RoomView.

| Function | Path | Notes |
|----------|------|-------|
| Power on/off | Telnet **port 23** → Optoma RS-232 ASCII commands over TCP, **OR** HDMI-CEC | CEC = lazy path: when the Chromecast wakes it powers the projector on automatically |
| Input/source select | same RS-232-over-TCP commands | HDMI1 / HDMI2 |
| Power/lamp status query | network query command | confirms real state vs. assumed |
| Web management | HTTP **port 80** | manual fallback |

**Integration plan:** add a `devices` row treated like a local-TCP device (handled by `device_agent` on LXC 103, or a thin direct-TCP sender). Power/source via the documented Optoma RS-232 strings sent over the Telnet socket. **Caveat to validate on real hardware once:** the projector's network power command + CEC behavior both vary unit-to-unit — confirm on the physical device before trusting in a scene.

RS-232 command reference: [Optoma RS232 Protocol Function List](https://www.optomausa.com/ContentStorage/Documents/471bc1d6-63f6-4825-aeef-2414e9cc5f99.pdf). HA-side telnet precedent: [HA Community — RS232 control of Optoma](https://community.home-assistant.io/t/using-rs232-to-control-an-optoma-projector/246045).

---

## Chromecast with Google TV 4K — control (VIA HA)

Two HA integrations together cover everything:

| Function | HA integration | Underlying lib |
|----------|----------------|----------------|
| Play video / station / music (cast) | **Google Cast** | `pychromecast` |
| Play / pause / next / volume | Google Cast (`media_player`) | `pychromecast` |
| Power on/off (wake / standby) | **Android TV Remote** (`androidtv_remote`) | `androidtvremote2` |
| Navigate (D-pad / home / back) + launch apps | Android TV Remote | `androidtvremote2` |

**Integration plan:** both surface as HA `media_player` entities → flow into the `devices` table via the existing **`HA_DIRECT_DEVICES`** WebSocket-adapter pattern ([DEVICE/CLAUDE.md](../DEVICE/CLAUDE.md)). **No new LXC, no new ingest service** — same as the TVs and Alexas.

Direct (no-HA) alternative exists — `pychromecast` (cast) + `androidtvremote2` (power/keys) over LAN — but rejected for the Chromecast because it means self-maintaining those two libs + their auth for little gain.

---

## Audio routing — decide before install

The projector's only audio out is a **3 W mono speaker** or the **3.5 mm jack**. Chromecast audio rides HDMI into the projector. For real sound, route audio out to a soundbar/Echo (the Media Agent already controls a Samsung soundbar). This is an installation choice, **not** a control limitation.

---

## What "we can control all" means (user's question, answered)

✅ on/off (both boxes) · ✅ play video · ✅ play audio/music · ✅ play internet-radio station · ✅ navigate / launch apps / volume / pause. All achievable. The only soft spot is the Optoma's community-grade control surface (validate once on hardware) and audio loudness (route to a soundbar).

---

## Implementation checklist (pending hardware)

1. `devices` row for the projector (local-TCP / Telnet sender) — power, source, status.
2. Add the Chromecast (Google Cast) + Android TV Remote integrations in HA; register in `HA_DIRECT_DEVICES`; `devices` rows auto-flow.
3. Optional **"Movie / Projector On" scene** (Main Agent → Scenes): Chromecast wake → CEC powers projector → soundbar on → input select. Run on demand or bind to a wallmote/panel button.
4. Decide audio path (HDMI extractor vs. 3.5 mm → soundbar) and wire it.
5. Validate Optoma network power + CEC on the physical unit before relying on it in automations.

---

## Sources

- [Optoma HD30LV specs — ProjectorCentral](https://www.projectorcentral.com/optoma-hd30lv.htm)
- [Optoma HD30LV product page](https://www.optomausa.com/product/hd30lv)
- [Optoma RS232 Protocol Function List](https://www.optomausa.com/ContentStorage/Documents/471bc1d6-63f6-4825-aeef-2414e9cc5f99.pdf)
- [HA Community — RS232 control of an Optoma projector](https://community.home-assistant.io/t/using-rs232-to-control-an-optoma-projector/246045)
