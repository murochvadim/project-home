# TRAFFIC_NETWORK — Road Traffic + Public Transit Visualization

Dashboard-only module. Two complementary data sources stitched into one tab:

1. **Road traffic** (cars) — real-time speed + incidents on roads around the apartment, via **TomTom Traffic API** (commercial, free tier).
2. **Public transit** (buses + trains) — real-time arrival predictions and vehicle positions, via **Open Bus Stride API** (community-run wrapper on Israel's Ministry of Transport GTFS + SIRI feed, no auth, no rate limit).

Sister of [WIFI_NETWORK](../WIFI_NETWORK/CLAUDE.md) and [CELLULAR_NETWORK](../CELLULAR_NETWORK/CLAUDE.md). Surface: new tab **"Traffic"** on the existing Project Network page (`BOILER/dashboard/public/network.html`).

## Waze — confirmed NOT accessible

Investigated 2026-05-21. Waze (Google subsidiary) only provides data to:
- Cities / transport authorities via **Waze for Cities Program** (free, but partnership-only)
- Transportation companies via **Waze Transport SDK** (contract required)

There is **no individual API access**. Third-party "Waze scrapers" (Apify, OpenWebNinja) violate Waze ToS and break frequently. Do not use.

## Road traffic — TomTom Traffic API

### Free tier

- **2,500 non-tile requests/day** shared across all TomTom APIs
- Pay-as-you-grow above that — predictable pricing per request
- Requires a free API key from https://developer.tomtom.com (one-time signup, no card)
- Israel is covered (TomTom states 80+ countries; verified by community reports)

For "monitor traffic within 3 km of apartment", a query every 10 min × ~5-10 corridors = well under 2,500/day.

### Endpoints to use

| Endpoint | What it returns | Use case |
|---|---|---|
| `GET /traffic/services/4/flowSegmentData/{style}/{zoom}/{format}` | Real-time speed + travel time for the road segment at a coordinate | "Is the main road into the apartment area slow right now?" |
| `GET /traffic/services/5/incidentDetails` | Incidents (jams, accidents, closures) inside a bbox | "Is there an accident on the route I usually take?" |

Style options: `absolute` (km/h), `relative0` (% of free-flow), `relative-delay` (delay vs free-flow). For dashboard purposes `relative0` is the easiest to colour-code.

### Schema and storage on LXC 102

```sql
CREATE TABLE traffic_flow_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  segment_label TEXT NOT NULL,        -- friendly name we pick: "M5 north of apartment"
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  current_speed_kmh REAL,
  free_flow_speed_kmh REAL,
  current_travel_time_sec INT,
  free_flow_travel_time_sec INT,
  confidence REAL,
  road_closure BOOLEAN
);
CREATE INDEX traffic_flow_log_ts ON traffic_flow_log (ts);
CREATE INDEX traffic_flow_log_segment ON traffic_flow_log (segment_label, ts DESC);

CREATE TABLE traffic_incidents_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  incident_id TEXT,                   -- TomTom's id
  category TEXT,                      -- jam, accident, road_closure, road_works, etc.
  magnitude INT,                      -- 0..4 severity
  start_lat DOUBLE PRECISION,
  start_lon DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lon DOUBLE PRECISION,
  description TEXT,
  delay_sec INT,
  length_m INT
);
CREATE INDEX traffic_incidents_log_ts ON traffic_incidents_log (ts);
```

Retention: `traffic_flow_log` 30 days, `traffic_incidents_log` 30 days. Add to `retention_policies` seed.

### Configured corridors

Stored in `dashboard_settings.traffic.corridors` as JSON:

```json
[
  {
    "label": "Sokolov toward Tel Aviv",
    "lat": 32.1500,
    "lon": 34.8900,
    "alert_threshold_slowdown_pct": 50
  },
  ...
]
```

User defines ~5-10 corridors (key intersections / routes they care about). The ingest service polls each one every 10 min.

## Public transit — Open Bus Stride API

### What it is

Community-run (Hasadna / Public Knowledge Workshop, https://www.hasadna.org.il/) JSON wrapper on top of Israel's Ministry of Transport official feeds:
- **GTFS** (static schedule)
- **SIRI SM** (real-time vehicle positions + arrivals)

**Verified live 2026-05-21**: API responds without auth, returns clean JSON, OpenAPI spec at `/openapi.json`, 27 endpoints. Sample query returned bus stops in Petah Tikva (next to Hod Hasharon — coverage is local).

### Base URL

```
https://open-bus-stride-api.hasadna.org.il/
Docs: https://open-bus-stride-api.hasadna.org.il/docs
```

### Endpoints we'd use

| Endpoint | Purpose |
|---|---|
| `GET /gtfs_stops/list?limit=N` | List bus/train stops. Filterable by lat/lon bounding box and city name. |
| `GET /siri_vehicle_locations/list` | Real-time vehicle positions (where every bus is on the map right now) |
| `GET /siri_ride_stops/list` | Per-stop predicted arrival times |
| `GET /stop_arrivals/list` | Aggregated arrival predictions per stop |
| `GET /route_timetable/list` | Schedule per route |

Each response is a JSON array of objects. Pagination via `limit` + `offset`.

### Schema (we cache locally)

```sql
CREATE TABLE transit_stops (
  id BIGINT PRIMARY KEY,
  code INT,                          -- the stop code printed on physical signs
  name TEXT,
  city TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  last_seen DATE                     -- date of the GTFS snapshot the stop was in
);
CREATE INDEX transit_stops_geo ON transit_stops (lat, lon);

CREATE TABLE transit_arrivals_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stop_id BIGINT REFERENCES transit_stops(id),
  route_short_name TEXT,             -- "28"
  route_long_name TEXT,
  predicted_arrival TIMESTAMPTZ,
  delay_sec INT
);
```

Retention: stops table forever (slow-moving reference data, weekly refresh). Arrivals log 7 days (real-time, only needed for "next bus" rendering — no historical value).

## Architecture

```
TomTom Traffic API ─┐
                    │       /opt/traffic-agent/poll.py  (LXC 104, every 10 min)
Open Bus Stride API ┘             │
                                  │  INSERT
                                  ▼
                  LXC 102 / traffic_flow_log + traffic_incidents_log + transit_*
                                  │
                                  │  SELECT
                                  ▼
                LXC 103 / dashboard endpoints + Traffic tab on network.html
```

## Phase plan

| Phase | What ships | Effort |
|---|---|---|
| **Phase 1** | TomTom signup, API key in `/etc/traffic-agent.env`, corridors config, poll script + cron + table. Verified one corridor returns sensible data. | 1-2 h |
| **Phase 2** | `/api/traffic/flow` endpoint, Traffic tab on dashboard, simple list view "Corridor X: 32 km/h (free-flow 60, 47% slower)" with color coding. | 1 h |
| **Phase 3** | Incidents endpoint + table + render as alert chips ("Accident on Sokolov 1.2 km away"). | 1 h |
| **Phase 4** | Add Stride/SIRI for public transit. Walk through `gtfs_stops/list?lat=...&lon=...&radius_m=500` (or filter client-side), let user pick stops they care about, store in `dashboard_settings.traffic.watched_stops`. | 2 h |
| **Phase 5** | "Next bus" panel showing real-time predicted arrivals at watched stops. Refresh every 60 s. | 1 h |
| **Phase 6** | Travel-time-to-work via Google Distance Matrix (free 25k/day) — "Leave by 8:45 to be at work by 9:00". Single corridor, single destination per row. | 2 h |
| **Phase 7 (alerts)** | `traffic:jam_on_corridor` and `traffic:incident_near_home` rows in `system_alerts` when configured thresholds are crossed. Same alert pattern used by group_health_watchdog. | 1 h |

## Why not Waze even via "free" tools

Recap from investigation:
- Waze for Cities: city/government only, requires formal partnership
- Waze Transport SDK: contract + commercial use
- "Waze scrapers" on Apify / OpenWebNinja: ToS violation, fragile (break when Waze changes endpoints)
- Waze livemap (waze.com/livemap): browser-only, no API, scraping is gray-area

If you ever want Waze data legitimately, you'd need to be a city traffic operator. Not the right path here.

## Caveats

- **TomTom data quality** in Israel is reasonable but not as dense as Google/Waze for cars. Major arteries are well-covered; tiny side streets may have stale data.
- **TomTom incidents** are not as comprehensive as Waze user reports — Waze gets fresh accident reports from millions of drivers; TomTom has its own probe network. Expect ~10-30 min lag on minor incidents.
- **Stride API is community-run**, not the government feed directly. It's been stable for years but isn't an SLA-backed service. If it goes down, the fallback is hitting MoT's SIRI SM XML endpoint directly (more complex; documented at gov.il).
- **GTFS data refreshes every 60 days** per MoT policy. We can refresh `transit_stops` weekly — cheap and avoids ever-stale data.

## Out of scope

- Drone / scooter / e-bike traffic (not in any public dataset for Israel)
- Pedestrian counts / footfall (no public source)
- Train operations beyond GTFS+SIRI (Israel Railways has their own ops API, requires partnership)
- Air traffic / flights (different domain — use `flightradar24` or `opensky-network.org` if ever needed)

## Status

Documentation only — no code written yet. Stride API verified live. TomTom API requires a free signup not yet performed. Build starts whenever; nothing in this module needs to be on the home network (both APIs are public internet). Tab UI implementation in the dashboard does need to be done at the home network.

## References

- [TomTom Traffic API docs](https://developer.tomtom.com/traffic-api/documentation/tomtom-maps/product-information/introduction)
- [TomTom pricing](https://developer.tomtom.com/pricing)
- [Open Bus Stride API docs (verified live 2026-05-21)](https://open-bus-stride-api.hasadna.org.il/docs)
- [Hasadna / Public Knowledge Workshop](https://www.hasadna.org.il/)
- [Israel MoT GTFS Developer Information PDF](https://www.gov.il/BlobFolder/generalpage/gtfs_general_transit_feed_specifications/he/GTFS%20-%20Developer%20Information.pdf)
- [Govmap (browser-only Ayalon Highways layer)](https://www.govmap.gov.il/?lay=200708)
- [Israeli Smart Transportation Research Center open data](https://istrc.net.technion.ac.il/open-data/)
