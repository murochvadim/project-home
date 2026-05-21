# Air Pollution Integration (Israel — AQICN / WAQI)

**Status as of 2026-05-21:** API key obtained + tested live, integration NOT YET BUILT. Pick up when ready.

## Goal

Bring Israeli real-time air quality data into the project so:
- Pollution shows up as a live tile in the cockpit + dashboard card
- High-AQI events trigger rules ("close windows" via Pixoo / Alexa)
- Pollution history accumulates for trends + correlation (dust storm prediction, HVAC tuning, ventilation timing)

Same pattern as the existing weather ingest (`collect_weather.py` on LXC 103) — just a different data source.

## Data source — AQICN.org (World Air Quality Index)

- **Provider**: AQICN.org (operated by the World Air Quality Index Project, non-profit)
- **API base**: `https://api.waqi.info/`
- **Documentation**: https://aqicn.org/json-api/doc/
- **Free tier**: 1,000 requests/day per token, no expiration
- **Coverage in Israel**: **21 stations** verified (2026-05-21) — Tel Aviv, Haifa, Jerusalem, Ashdod, Pardes Hanna, Gush Dan train stations (Yoseftal/Komemiyut/Peace/Haganah/Levinsky), Antokolski, Bnei Atarot, Cedar (southern coast), Wipe Eastern, Yad Binyamin, "One of the Nation" Gush Dan, Jerusalem Central Bus Station, Ashkelon, Rishon Lezion, Kfar Masaryk, plus mobile railway stations

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

The geo query `geo:32.156;34.892` (Hod Hasharon center) auto-resolves to the closest active station — currently **Ra'anana** (uid 2955, ~2.5 km north, AQI 41 right now). When **Kfar Saba** (uid 9986, ~1 km east, currently offline) is back online, geo lookup will switch to it automatically without config change. **Hod Hasharon's own station "Hint"** (uid 2964) sits within the city — also a candidate; currently reporting AQI 40. Geo lookup beats hardcoding a UID because station availability shifts over time.

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
    "aqi": 52,
    "idx": 5783,
    "city": {"name": "Tel Aviv", "geo": [32.08386, 34.78191]},
    "dominentpol": "pm25",
    "iaqi": {
      "pm25":{"v":52}, "pm10":{"v":17},
      "no2":{"v":2.9}, "o3":{"v":38.8}, "so2":{"v":1.3},
      "t":{"v":21}, "h":{"v":60}, "w":{"v":7.2}, "p":{"v":1012}
    },
    "time": {"iso":"2026-05-21T08:00:00+03:00"}
  }
}
```

### AQI bands

| AQI | Level | Health implication | Suggested rule action |
|---|---|---|---|
| 0–50 | Good | Normal | none |
| 51–100 | Moderate | Sensitive groups notice | Awtrix tile only |
| 101–150 | Unhealthy (sensitive) | Limit prolonged outdoor exertion | Pixoo banner |
| 151–200 | Unhealthy | Everyone affected | Pixoo + Alexa "close windows" |
| 201–300 | Very Unhealthy | Reduce all outdoor activity | Pixoo critical + Alexa all rooms |
| 301+ | Hazardous | Health warning | Pixoo flash + Alexa + push to phone |

## Architecture

```
                  ┌────────────────────────────────┐
                  │  AQICN cloud API               │
                  │  api.waqi.info                 │
                  └─────────────┬──────────────────┘
                                │ HTTPS, every 30 min
                                ▼
┌────────────────────────────────────────────────────────────┐
│  LXC 103 — collect_pollution.py (cron */30 * * * *)        │
│  ▸ Reads AQICN_TOKEN from /etc/environment                 │
│  ▸ GET /feed/geo:<lat>;<lon>/?token=...                    │
│  ▸ Parses iaqi + dominant + station                        │
│  ▸ INSERT INTO raw_pollution                               │
│  ▸ If aqi > 100 AND last_aqi <= 100 → publish MQTT alert   │
└────────────────────────────────┬───────────────────────────┘
                                 │
                                 ▼ INSERT
┌────────────────────────────────────────────────────────────┐
│  LXC 102 — PostgreSQL                                      │
│  raw_pollution table (one row per 30-min poll)             │
│  retention_policies row: 60 days, auto_clean=true          │
└────────────────────────────────┬───────────────────────────┘
                                 │
              ┌──────────────────┴───────────────────┐
              │                                      │
              ▼                                      ▼
┌─────────────────────────┐         ┌────────────────────────────────┐
│ Dashboard "Air Quality" │         │ Rule engine on LXC 105         │
│ card on Weather page    │         │ Reads aqi from state.shared    │
│ ▸ Current AQI badge     │         │ ▸ If aqi > threshold → Pixoo + │
│ ▸ 24h chart (Chart.js)  │         │   Alexa "close windows" action │
│ ▸ Per-pollutant tiles   │         │ ▸ Sentence-driven, editable    │
└─────────────────────────┘         └────────────────────────────────┘
```

## DB schema

```sql
CREATE TABLE raw_pollution (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  station_uid    INTEGER,                   -- AQICN station ID (e.g. 5783)
  station_name    TEXT NOT NULL,             -- "Tel Aviv" / "Antokolski Gush Dan"
  station_lat     NUMERIC(10,7),
  station_lon     NUMERIC(10,7),
  aqi             SMALLINT NOT NULL,         -- overall AQI 0–500
  dominent_pol    TEXT,                      -- 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co'
  pm25            NUMERIC(6,2),
  pm10            NUMERIC(6,2),
  no2             NUMERIC(6,2),
  o3              NUMERIC(6,2),
  so2             NUMERIC(6,2),
  co              NUMERIC(6,2),
  temp_c          NUMERIC(5,2),              -- station also reports weather
  humidity_pct    SMALLINT,
  wind_mps        NUMERIC(5,2),
  pressure_hpa    NUMERIC(7,2),
  raw             JSONB                      -- full payload for debug / future field extraction
);
CREATE INDEX raw_pollution_ts ON raw_pollution (ts DESC);
```

Retention: 60 days, `auto_clean=true`, `clean_interval_hours=24` — matches `raw_weather` pattern. ~30 KB/day.

## Phase rollout

| Phase | Effort | Deliverable |
|---|---|---|
| **1 — schema + retention row** | 5 min | `CREATE TABLE raw_pollution` + INSERT into retention_policies on LXC 102 |
| **2 — collect_pollution.py + cron** | 30 min | Script on LXC 103 (`BOILER/agent/collect_pollution.py`), cron entry `*/30 * * * *` |
| **3 — token in /etc/environment** | 2 min | One line `AQICN_TOKEN=639b...` added on LXC 103 |
| **4 — Health page row** | 10 min | "collect_pollution" added to /api/health/status freshness checks (raw_pollution age ≤ 65 min) |
| **5 — Dashboard Weather page card** | 30 min | "Air Quality" card with current AQI + 24h chart |
| **6 — Sentence-driven rule** | 5 min | In Main Agent → Base Rule Settings, e.g. "If air_quality.aqi > 100 push @Pixoo Close_Windows" |
| **7 — db-volumes entry** | 2 min | Add raw_pollution to dashboard `db-volumes` handler's `tables` array + `tsCol` map |

Total: ~1.5 hours.

## Sentence-driven rule examples

In **Main Agent → Base Rule Settings**, new container "Air Quality Alerts":

| Sentence | What it does |
|---|---|
| `air quality station is geo:32.156;34.892` | Picks the station (lat/lon-based, auto-resolves to closest) |
| `air quality poll interval is 30 minutes` | Matches the cron — surfaces the knob if user wants to change |
| `when air_quality.aqi > 100 push @Pixoo Air_Warning` | Pixoo banner on rising-edge |
| `when air_quality.aqi > 150 say "Air quality unhealthy, close windows" on Alexa @active_rooms` | Alexa announcement in occupied rooms |
| `when air_quality.aqi > 200 push @Awtrix critical_air_alert` | Critical-level Awtrix notification |

The `air_quality.aqi` state.shared key is published by collect_pollution after each successful poll, so rules can read it. Same pattern as `weather.uv_index_ims` etc.

## Bonus extensions (defer until basics work)

| Idea | Combines |
|---|---|
| **Dust storm (חמסין) detection** | PM10 spike + low wind + dry air = approaching dust storm. Trigger pre-emptive close-windows + AC recirculation. |
| **Sub-hour smart polling** | When AQI > 80, poll every 10 min; otherwise every 30 min. Saves API calls. |
| **Multi-station comparison** | Pull 3 nearby stations, surface delta ("station A=50, station B=90 — local hotspot"); useful for catching close-by construction / traffic source. |
| **Boiler / HVAC interaction** | "If AQI > 100 AND boiler valve OFF → don't open balcony door for ventilation". |
| **Outdoor activity recommendation** | Morning glance on Awtrix: "Good air outside, AQI 32" or "Stay in, AQI 142". |
| **Long-term trends** | After 60 days of `raw_pollution`, surface weekly/monthly average on Health page; spot seasonal patterns. |

## Token storage (security)

- **Token: lives on LXC 103 only** in `/etc/environment` (`AQICN_TOKEN=...`) — same pattern as HA_TOKEN
- **NOT** committed to git
- **NOT** in dashboard `.env` (laptop) — only LXC 103 needs it
- If leaked: regenerate at https://aqicn.org/data-platform/token/ → update `/etc/environment` → next 30-min cron picks up new value (no service restart needed since cron starts fresh process each run)

## When you're back at the system

1. Read this doc
2. Read the live readings above to recall what's available
3. Confirm the geo coordinates of your apartment (current placeholder `32.085;34.781` — pick yours exactly)
4. Tell me **"start pollution phase 1"** — I'll create the DB schema + retention row first
5. Then phases 2–7 in order

## Related project memory

- The existing `raw_weather` ingest at `BOILER/agent/collect_weather.py` is the template — same cron pattern, same DB INSERT shape, same Health page freshness check
- See `BOILER/CLAUDE.md` "Data Flow" section for the established weather pattern
- AQICN station UID 5783 (Tel Aviv) confirmed live as of 2026-05-21
