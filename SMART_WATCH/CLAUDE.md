# SMART_WATCH Agent

> **STATUS: PLANNED — scoped 2026-07-25, build starts 2026-07-26.**
> Hardware: **Samsung Galaxy Watch Ultra 2** (buying at Samsung Israel, ~₪2,300). Dashboard-only agent — no LXC service of its own; feeds the existing **Personal Health** (`ph_*`) tables via a phone gateway.

A wrist wearable that feeds health/fitness data into the project. After a full options review (2026-07-25), the chosen architecture is the **phone-gateway path**: the watch syncs to the Fold 5, and a custom Android app on the phone reads **Health Connect** and publishes to the project over **MQTT via NetBird**.

---

## The decision (and why)

**Chosen:** Galaxy Watch Ultra 2 → Samsung Health → **Health Connect** (on the Samsung Z Fold 5) → **custom Android app** → **NetBird** → **MQTT (LXC 107)** → ingest → **`ph_*`** Personal Health tables.

Why this over the alternatives:

| Option considered | Verdict | Reason |
|---|---|---|
| **Galaxy Watch Ultra 2 + phone-gateway app** | ✅ **CHOSEN** | Real sensors, polished daily wear, richest realistic data, modest (few-day) Android build, reuses NetBird + MQTT + OwnTracks pattern already running. |
| ESP32 DIY watch (LILYGO T-Watch Ultra) | ❌ rejected | Best *integration* (native MQTT, total data ownership, fits `esp_boards`) BUT **no cellular** (WiFi/LoRa only), **poor battery** (hours–1–2 days), **DIY hobby-grade HR** (MAX30102, no BP/ECG), bulky. Great home wearable, wrong for daily wear + outside-home. |
| Watch-standalone app (Wear OS Kotlin + on-watch WireGuard) | ❌ rejected | The "phone-free over cellular" dream, but **no NetBird Wear-OS app** (raw WireGuard workaround only), **HR/steps only** (BP/ECG/SpO₂ Samsung-locked), Wear-OS background + battery pain → multi-week build for a thin payload. |
| Generic AliExpress "smartwatch" (e.g. GUHUAVMI, MediaTek) | ❌ rejected | **Not flashable** (MediaTek closed SoC, no Arduino/SDK), **no WiFi**, data trapped in a proprietary app (RDFit). The classic "smartwatch ≠ programmable" trap. |
| Fitbit / Garmin / Withings / Oura / Xiaomi | ❌ rejected | Cloud-only (bends local-first) and/or Chinese brand (user excluded). |

**Full options thread lives in the conversation of 2026-07-25.** Key constraints that drove it: no Chinese brands, must reach the project from outside home, local-first architecture.

---

## ⚠️ Key facts settled during scoping (don't re-litigate)

1. **The watch's eSIM is NOT needed for this path.** The Fold 5 is the gateway — the watch syncs to the phone over Bluetooth, and the **phone** provides cellular/internet (reaching LXC 107 via NetBird, exactly like OwnTracks). "Outside home" works because you carry your phone. → **No watch companion line to activate or pay for.** (The eSIM would only matter for phone-free operation = the rejected watch-standalone path.)
2. **A cheaper Galaxy Watch 9 would deliver identical data** through Health Connect — the Ultra 2's eSIM/rugged/big-battery add nothing to *this* path. Ultra 2 was chosen as a *watch*, not for data reasons.
3. **Data is NOT real-time.** Health Connect syncs with minutes of lag (watch → Samsung Health → Health Connect). Fine for logging into `ph_*`; useless for live alerts.
4. **BP and ECG are unreachable.** Locked inside Samsung Health Monitor — no Health Connect / third-party API. If BP/ECG are ever needed → a **dedicated BLE device** (BLE Blood-Pressure Profile 0x1810 cuff → ESP32 bridge → `ph_bp`; KardiaMobile/Withings for ECG), NOT this watch.
5. **This is Android/Kotlin work** — a new stack vs the project's Python/JS. Built on the laptop with the Android SDK, deployed to the Fold 5 over USB (`adb`). Claude writes/builds/deploys; the user does on-device taps (USB-debug auth, Health Connect permission grants).

---

## Data we get vs don't

**✅ Available via Health Connect** (verify each once hardware is here — Samsung must write it):
- Steps
- Heart rate
- Sleep (incl. stages)
- SpO₂ / blood oxygen
- Calories (active + total)
- Distance
- Workouts / exercise sessions
- Floors climbed
- ⚠️ HRV, skin temperature, body composition — *sometimes*, Samsung-dependent

**❌ Not available:**
- Blood pressure (Samsung Health Monitor only)
- ECG (medical, not exposed)
- Stress (Samsung-proprietary metric, no Health Connect type)
- Anything real-time / live-streamed

---

## Architecture

```
Galaxy Watch Ultra 2
      │  (Bluetooth sync)
      ▼
Samsung Health  ──►  Health Connect        [on Samsung Z Fold 5]
                          │  (read API, WorkManager periodic pull)
                          ▼
              SMART_WATCH Android app       [custom, Kotlin]
                          │  (Paho MQTT publish)
                          ▼  over NetBird (phone is already a peer)
              MQTT broker  mur/home/wearable/#   [LXC 107, 192.168.1.189]
                          │
                          ▼
              wearable-ingest daemon         [LXC 104 — like owntracks_ingest.py]
                          │
                          ▼
              Postgres  ph_*  tables         [LXC 102]
                          │
                          ▼
              Personal Health cards          [medical.html → Personal Health tab]
```

- **No new dashboard page.** Data surfaces on the existing **Medical → Personal Health** tab. New metrics (HR/SpO₂/sleep) may need new `ph_*` tables + cards — see Build Plan.
- **Ingest on LXC 104** (the timers/daemons LXC), mirroring `owntracks_ingest.py`: a long-running MQTT subscriber writing to `ph_*`.
- **Reuses:** NetBird (LXC 108) for the phone→broker path; `household_users` for member attribution (`ph_*.user_id` FK); the OwnTracks MQTT ingest pattern.

---

## MQTT topic scheme (proposed)

Broker LXC 107, under the existing `mur/home/` tree. Device id `watch01` (one per physical watch; ready for N).

```
mur/home/wearable/watch01/health   {ts, user, metric, value, unit, ...}   # batched samples
mur/home/wearable/watch01/status   {ts, battery, model, app_version}      # phone-app heartbeat
```

- App publishes **batched** samples (not per-reading) to save phone battery + reflect Health Connect's periodic sync.
- ACL: add a `wearable` (or reuse `dashboard_browser`/a new dedicated) MQTT user on LXC 107 with `write mur/home/wearable/+/#`; ingest user reads it. **Follow the MQTT-password-cascade rule** — update every consumer env if a new user is added.

---

## Personal Health mapping

- **Steps** → existing **`ph_steps`** (already fed by `steps_from_trips.py`; watch steps are a second source — dedupe/merge strategy TBD, likely `source='watch'`).
- **Heart rate / SpO₂ / sleep / HRV** → **new `ph_*` tables needed** (no HR/SpO₂/sleep table exists yet). Design:
  - `ph_heart_rate` (ts, profile_id, bpm, context)
  - `ph_spo2` (ts, profile_id, pct)
  - `ph_sleep` (date, profile_id, stages jsonb, total_min)
  - Each: retention **forever + 🔒 protected** (health data), add to **DB Volumes** group + `retention_policies` (per the new-DB-table hook).
- Member attribution via **`household_users`** (`user_id` FK) — the watch belongs to one member.
- **BP stays `ph_bp`** (existing) — but fed by a future BLE cuff, NOT this watch.

---

## Build plan (tomorrow onward)

**Phase 0 — Toolchain + device (laptop + Fold 5)**
- [ ] Check laptop for `adb`, `java`; install Android **command-line SDK + JDK** (or Android Studio) — multi-GB.
- [ ] User: enable **Developer Options + USB debugging** on the Fold 5; authorize the laptop (RSA prompt).
- [ ] Verify `adb devices` sees the Fold 5 over USB.
- [ ] Confirm **Samsung Health** installed + syncing on the Fold 5, and it writes to **Health Connect** (check per-metric).

**Phase 1 — Minimal app (steps + HR → MQTT)**
- [ ] Kotlin app skeleton: Health Connect read permissions (user grants on-device).
- [ ] Read steps + HR via Health Connect API.
- [ ] Paho MQTT client → publish to `mur/home/wearable/watch01/health` (broker over NetBird).
- [ ] `adb install`, grant permissions, verify a message lands on the broker.

**Phase 2 — Ingest + storage**
- [ ] `scripts/wearable_ingest.py` → deploy to LXC 104 as `wearable-ingest.service` (mirror `owntracks_ingest.py`).
- [ ] New `ph_*` tables (migration) + retention + DB-Volumes registration.
- [ ] Verify end-to-end: watch → phone → broker → LXC 104 → `ph_*`.

**Phase 3 — Full metric set + background**
- [ ] Add SpO₂, sleep, calories, distance, workouts.
- [ ] **WorkManager** periodic sync (e.g. every 15 min); tune battery.
- [ ] Personal Health cards for the new metrics.

**Phase 4 (optional, later)**
- [ ] Presence signal (watch-on-wrist / at-home) if useful.
- [ ] If BP/ECG ever needed → separate BLE-cuff / KardiaMobile subsystem (NOT this watch).

---

## Open questions (resolve during build)
- Exactly which metrics does *this* Samsung Health build write to Health Connect in 2026? (verify on hardware)
- Steps dedupe: watch vs `steps_from_trips.py` — which wins per day? (likely watch when present, GPS-derived as fallback)
- New MQTT user vs reuse an existing one on LXC 107.
- App distribution: personal debug-signed APK via `adb` (no Play Store) — fine for single-device.

## References
- Root `CLAUDE.md` — Personal Health tables, `household_users`, NetBird, MQTT broker ACLs, LXC 104 daemons.
- [PERSONAL_HEALTH/CLAUDE.md](../PERSONAL_HEALTH/CLAUDE.md) — `ph_*` tables + Personal Health tab.
- [GEOLOCATION/CLAUDE.md](../GEOLOCATION/CLAUDE.md) — the `owntracks_ingest.py` pattern this ingest copies.
- [NETBIRD/CLAUDE.md](../NETBIRD/CLAUDE.md) — the phone→broker VPN path.
