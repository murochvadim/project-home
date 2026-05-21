# Air Pollution Integration (Israel — AQICN / WAQI)

**Status as of 2026-05-21:** API key obtained + tested live (Hod Hasharon → Ra'anana station resolves cleanly). Integration NOT YET BUILT but **merged-table architecture finalized**: pollution data extends `raw_weather` rather than living in its own table.

## Goal

Bring Israeli real-time air quality data into the project so:
- Pollution shows up as a live tile in the cockpit + dashboard card
- High-AQI events trigger rules ("close windows" via Pixoo / Alexa)
- Pollution history accumulates for trends + correlation (dust storm prediction, HVAC tuning, ventilation timing)

**Architecture decision (2026-05-21):** Pollution is added as new columns on the existing `raw_weather` table, NOT a separate `raw_pollution` table. Same row holds temp/humidity/UV/wind/AQI/PM2.5/etc — one timestamp, one source of truth for "outdoor environment". `collect_weather.py` is extended to pull both HA + AQICN per cycle.

## Data source — AQICN.org (World Air Quality Index)

- **Provider**: AQICN.org (operated by the World Air Quality Index Project, non-profit)
- **API base**: `https://api.waqi.info/`
- **Documentation**: https://aqicn.org/json-api/doc/
- **Free tier**: 1,000 requests/day per token, no expiration
- **Coverage in Israel**: **21 stations** verified (2026-05-21) — Tel Aviv, Haifa, Jerusalem, Ashdod, Pardes Hanna, Gush Dan train stations (Yoseftal/Komemiyut/Peace/Haganah/Levinsky), Antokolski, Bnei Atarot, Cedar (southern coast), Wipe Eastern, Yad Binyamin, "One of the Nation" Gush Dan, Jerusalem Central Bus Station, Ashkelon, Rishon Lezion, Kfar Masaryk, Ra'anana, Hint (Hod Hasharon), plus mobile railway stations.

The geo query `geo:32.156;34.892` (Hod Hasharon center) auto-resolves to the closest active station — currently **Ra'anana** (uid 2955, ~2.5 km north, AQI 41 right now). When **Kfar Saba** (uid 9986, ~1 km east, currently offline) is back online, geo lookup will switch to it automatically without config change. **Hod Hasharon's own station "Hint"** (uid 2964) sits within the city — also a candidate; currently reporting AQI 40. Geo lookup beats hardcoding a UID because station availability shifts over time.

## Live data verified (2026-05-21 local)

Smoke test pulled successfully.

**For Hod Hasharon — geo:32.156;34.892 → resolved to Ra'anana** (closest active, ~2.5 km away):

```
Ra'anana (uid 2955) — 09:00 reading
  AQI: 41  (Good)
  Dominant pollutant: PM2.5

  PM2.5:    41
  NO2:      6.3
  Temp:     21.3°C
  Humidity: 64.4%
  Wind:     9.5 m/s
  Pressure: 1008 hPa
```

**Stations available for Hod Hasharon area:**

| Station | UID | Distance from HH center | Status |
|---|---|---|---|
| Kfar Saba | 9986 | ~1 km east — IDEAL | ✗ no current data (sensor offline) |
| "Hint" (in Hod Hasharon) | 2964 | within city | ✓ active, AQI 40 |
| Ra'anana | 2955 | ~2.5 km north | ✓ active, AQI 41 (geo lookup picks this) |
| Pardes Hanna | 5782 | ~25 km north | ✓ active, AQI 36 |

Geo lookup automatically chooses the closest with valid data — no need to hardcode. If Kfar Saba comes back online, it'll be picked next poll.

**For Tel Aviv reference** (also tested 08:00):

```
Tel Aviv (uid 5783) — AQI 52 (Moderate), PM2.5 dominant
```

## API access

### Two query modes

**By city slug:**
```
https://api.waqi.info/feed/<city>/?token=<token>
```
- `<city>` = lowercase station name with hyphens (e.g. `tel-aviv`, `haifa`, `jerusalem`)

**By coordinates (recommended):**
```
https://api.waqi.info/feed/geo:<lat>;<lon>/?token=<token>
```
- Returns the closest station's data to those coords
- Survives station-name changes / closures

### Response shape

```json
{
  "status": "ok",
  "data": {
    "aqi": 41,
    "idx": 2955,
    "city": {"name": "Ra'anana", "geo": [32.1787, 34.88111]},
    "dominentpol": "pm25",
    "iaqi": {
      "pm25":{"v":41}, "no2":{"v":6.3},
      "t":{"v":21.3}, "h":{"v":64.4}, "w":{"v":9.5}, "p":{"v":1008.1}
    },
    "time": {"iso":"2026-05-21T09:00:00+03:00"}
  }
}
```

Note: not every station emits every pollutant. Per-station: PM2.5 is near-universal, PM10/NO2/O3/SO2/CO are common but not guaranteed. Handle missing keys gracefully (NULL in DB).

### AQI bands

| AQI | Level | Health implication | Suggested rule action |
|---|---|---|---|
| 0–50 | Good | Normal | none |
| 51–100 | Moderate | Sensitive groups notice | Awtrix tile only |
| 101–150 | Unhealthy (sensitive) | Limit prolonged outdoor exertion | Pixoo banner |
| 151–200 | Unhealthy | Everyone affected | Pixoo + Alexa "close windows" |
| 201–300 | Very Unhealthy | Reduce all outdoor activity | Pixoo critical + Alexa all rooms |
| 301+ | Hazardous | Health warning | Pixoo flash + Alexa + push to phone |

## How AQICN fields relate to existing weather data

Deep comparison done 2026-05-21 — AQICN provides several fields that overlap with the existing `raw_weather` ingest. Tradeoffs:

| Parameter | IMS (current) | Balcony Aeotec (current) | **AQICN (new)** | Verdict |
|---|---|---|---|---|
| Temperature | ✓ regional | ✓ hyper-local | ✓ regional duplicate | Balcony wins; AQICN stored as `aqicn_temp_c` for cross-check |
| Humidity | ✓ regional | ✓ hyper-local | ✓ regional duplicate | Balcony wins; AQICN stored as `aqicn_humidity_pct` for cross-check |
| Wind speed | ✓ | ✗ (no wind on Aeotec) | ✓ duplicate | IMS wins; AQICN stored as `aqicn_wind_mps` for cross-check |
| Wind bearing | ✓ (in IMS, not currently captured) | ✗ | ✗ | NEW from IMS if you ever want to capture it |
| **Pressure (hPa)** | ✗ NOT collected | ✗ | ✓ **1008 hPa** | **AQICN adds this — entirely new for your project** |
| UV index | ✓ | ✓ | ✗ | AQICN doesn't carry UV |
| Illuminance | ✗ | ✓ | ✗ | Balcony sole source |
| Condition text | ✓ | ✗ | ✗ | IMS sole source |
| Precipitation forecast | ✓ in `raw_weather_daily` | ✗ | ✗ | IMS sole source |
| **PM2.5 / PM10 / NO2 / O3 / SO2 / CO** | ✗ | ✗ | ✓ | **AQICN exclusive — primary purpose** |
| **AQI (composite)** | ✗ | ✗ | ✓ | **AQICN exclusive (calculated)** |

**Approach taken:** keep all 3 temperature sources (IMS, balcony, AQICN) in the row for sensor cross-check; pollution + pressure are the genuine new fields. ~80 bytes extra per row × 48 rows/day × 60 days = ~230 KB total. Negligible.

## Architecture (merged-table)

```
                  ┌─────────────────────────────────┐
                  │  HA on LXC 101                  │
                  │  weather.ims_weather +          │
                  │  sensor.balcony_motion_*        │
                  └──────────────┬──────────────────┘
                                 │ HA REST
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  LXC 103 — collect_weather.py (cron 0 * * * *, hourly)       │
│                                                              │
│  Existing logic:                                             │
│   ▸ Reads HA_TOKEN from /etc/environment                     │
│   ▸ GETs weather.ims_weather + balcony sensors               │
│                                                              │
│  NEW logic:                                                  │
│   ▸ Reads AQICN_TOKEN from /etc/environment                  │
│   ▸ GETs https://api.waqi.info/feed/geo:32.156;34.892/...    │
│   ▸ Parses iaqi + dominant + station                         │
│                                                              │
│  Combines into ONE row → INSERT INTO raw_weather             │
│  Partial-failure: if AQICN down → write row with             │
│   pollution NULL (don't lose weather); same in reverse.      │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼ INSERT
┌──────────────────────────────────────────────────────────────┐
│  LXC 102 — PostgreSQL                                        │
│  raw_weather table (existing) + new columns:                 │
│   pressure_hpa, aqi, dominent_pol, pm25, pm10, no2, o3,      │
│   so2, co, pollution_station, aqicn_temp_c,                  │
│   aqicn_humidity_pct, aqicn_wind_mps                         │
│  Retention: 60d, auto_clean=true (unchanged)                 │
└──────────────────────────────┬───────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
              ▼                                 ▼
┌─────────────────────────┐         ┌──────────────────────────────┐
│ Dashboard "Air Quality" │         │ Rule engine on LXC 105       │
│ card on Weather page    │         │ Reads aqi from state.shared  │
│ ▸ Current AQI badge     │         │ ▸ If aqi > threshold → Pixoo │
│ ▸ 24h chart (Chart.js)  │         │   + Alexa "close windows"    │
│ ▸ Per-pollutant tiles   │         │ ▸ Sentence-driven, editable  │
│ ▸ Pressure trend tile   │         └──────────────────────────────┘
└─────────────────────────┘
```

## DB schema migration

Single ALTER on the existing `raw_weather` table — no new table, no new retention policy:

```sql
ALTER TABLE raw_weather
  ADD COLUMN pressure_hpa        NUMERIC(7,2),   -- barometric, NEW signal
  ADD COLUMN aqi                 SMALLINT,       -- overall index 0–500
  ADD COLUMN dominent_pol        TEXT,           -- 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co'
  ADD COLUMN pm25                NUMERIC(6,2),
  ADD COLUMN pm10                NUMERIC(6,2),
  ADD COLUMN no2                 NUMERIC(6,2),
  ADD COLUMN o3                  NUMERIC(6,2),
  ADD COLUMN so2                 NUMERIC(6,2),
  ADD COLUMN co                  NUMERIC(6,2),
  ADD COLUMN pollution_station   TEXT,           -- e.g. "Ra'anana (uid 2955)"
  ADD COLUMN aqicn_temp_c        NUMERIC(5,2),   -- 3rd temperature source
  ADD COLUMN aqicn_humidity_pct  SMALLINT,       -- 3rd humidity source
  ADD COLUMN aqicn_wind_mps      NUMERIC(5,2);   -- 2nd wind source
```

All nullable so pre-2026-05-21 historical rows stay valid. No retention change.

**Required follow-up:** update `BOILER/CLAUDE.md` Tables section to list the new columns in `raw_weather` (currently only documents the original 10 columns). Same edit type as adding any new column documentation.

## Phase rollout

| Phase | Effort | Deliverable |
|---|---|---|
| **1 — ALTER raw_weather** | 5 min | Apply the ALTER above on LXC 102. Zero downtime. Existing rows continue to read fine. |
| **2 — Token in /etc/environment** | 2 min | One line `AQICN_TOKEN=<token>` on LXC 103. cron picks up next run, no restart needed. |
| **3 — Update collect_weather.py** | 30–45 min | Extend script to also fetch AQICN per cycle + write the new columns. Partial-failure handling (pollution-or-weather can fail independently — row still gets written with NULLs in the failing side). |
| **4 — Health page row** | 10 min | `/api/health/status` already monitors raw_weather freshness — add a "pollution_fresh" sub-check that verifies `aqi IS NOT NULL` in the most recent row. |
| **5 — Dashboard "Air Quality" card on Weather page** | 30–45 min | Add card to `general.html` (Weather page) with current AQI badge + per-pollutant mini-tiles + 24h Chart.js sparkline. Pressure tile too. |
| **6 — Sentence-driven rule** | 5 min | In Main Agent → Base Rule Settings, container "Air Quality Alerts": rules per AQI band → Pixoo + Alexa. |
| **7 — Update BOILER/CLAUDE.md** | 5 min | Doc the new `raw_weather` columns + briefly note the AQICN source. |
| **8 — Update root CLAUDE.md → "DB Tables" section** | 2 min | Note: `raw_weather` now also carries pollution + pressure. |

Total: **~1.5 hours**.

## Sentence-driven rule examples

In **Main Agent → Base Rule Settings**, new container "Air Quality Alerts":

| Sentence | What it does |
|---|---|
| `air quality station is geo:32.156;34.892` | Picks the station (lat/lon-based, auto-resolves to closest active) |
| `air quality poll interval is 60 minutes` | Matches the existing weather cron — surfaces the knob |
| `when air_quality.aqi > 100 push @Pixoo Air_Warning` | Pixoo banner on rising-edge |
| `when air_quality.aqi > 150 say "Air quality unhealthy, close windows" on Alexa @active_rooms` | Alexa announcement in occupied rooms |
| `when air_quality.aqi > 200 push @Awtrix critical_air_alert` | Critical-level Awtrix notification |
| `when air_quality.pressure_drop_6h > 5 say "Storm approaching" on Alexa @active_rooms` | Pressure drop → storm warning |

The `air_quality.aqi` and `air_quality.pressure_hpa` keys are published by collect_weather after each successful poll, so rules can read them. Same pattern as `weather.uv_index_ims` etc.

## Bonus extensions (defer until basics work)

| Idea | Combines |
|---|---|
| **Dust storm (חמסין) detection** | PM10 spike + low wind + dry air = approaching dust storm. Trigger pre-emptive close-windows + AC recirculation. |
| **Sub-hour smart polling** | When AQI > 80, poll every 10 min; otherwise hourly. Saves API calls while catching events fast. Requires a separate cron pattern. |
| **Multi-station comparison** | Pull 3 nearby stations, surface delta ("station A=50, station B=90 — local hotspot"); useful for catching close-by construction / traffic source. |
| **Boiler / HVAC interaction** | "If AQI > 100 AND boiler valve OFF → don't open balcony door for ventilation". |
| **Outdoor activity recommendation** | Morning glance on Awtrix: "Good air outside, AQI 32" or "Stay in, AQI 142". |
| **Long-term trends** | After 60 days of rows with AQI columns populated, surface weekly/monthly average on Health page; spot seasonal patterns. |
| **Pressure-trend storm warning** | Pressure dropping fast (>5 hPa in 6h) → "storm approaching" Alexa announce. |
| **Sensor cross-check audit** | Compare temp_ims vs temp_balcony vs aqicn_temp_c monthly; alert if any single source drifts > 2°C from the median. |

## Token storage (security)

- **Token: lives on LXC 103 only** in `/etc/environment` (`AQICN_TOKEN=...`) — same pattern as HA_TOKEN
- **NOT** committed to git
- **NOT** in dashboard `.env` (laptop) — only LXC 103 needs it
- If leaked: regenerate at https://aqicn.org/data-platform/token/ → update `/etc/environment` → next 60-min cron picks up new value (no service restart needed since cron starts fresh process each run)

## When you're back at the system

1. Read this doc — note the merged-table design
2. Confirm the geo coordinates of your apartment (current example `32.156;34.892`)
3. Tell me **"start pollution phase 1"** — I'll apply the ALTER on LXC 102 first
4. Then phases 2–8 in order
5. After phase 7 + 8, `BOILER/CLAUDE.md` and root `CLAUDE.md` reflect the new schema fields too

## Related project memory

- The existing `raw_weather` ingest at `BOILER/agent/collect_weather.py` is the foundation — same cron pattern, same INSERT (just more columns)
- See `BOILER/CLAUDE.md` "Data Flow" section for the established weather pattern — it'll be updated in phase 7
- AQICN station UID 2955 (Ra'anana) confirmed live for Hod Hasharon as of 2026-05-21; UID 9986 (Kfar Saba) is geographically ideal but currently offline
