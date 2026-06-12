# CELLULAR_NETWORK — Israeli Cellular Antenna + Radiation Map

Dashboard-only module. Ingests the Ministry of Environmental Protection's published cellular antenna registry (location + measured radiation level per site) and visualizes the antennas near the apartment. Pairs with [WIFI_NETWORK](../WIFI_NETWORK/CLAUDE.md) for a complete RF-environment picture.

Surface: new sibling tab **"Cellular"** on existing Project Network page (`BOILER/dashboard/public/network.html`), alongside the planned WiFi tab and existing ARP / Ports tabs.

## Scope (LOCKED 2026-06-12) — supersedes the "ingest all 8,423" framing below
- **Your area only — 3 km radius around home** (`32.1676, 34.9001`, Hod HaSharon). **NOT the national 8,423.** The stored table holds only the ~30–60 nearby antennas. Home center is read from `dashboard_settings.geolocation.center` (same point the geolocation map uses).
- **Ingest = ITM bounding-box query, not a full national pull.** Convert home + 3 km → an EPSG:2039 box (home ≈ ITM X 190000 / Y 672500 → box X 187000–193000, Y 669500–675500) and hit the API's `datastore_search_sql` with `WHERE "X_ITM" BETWEEN … AND "Y_ITM" BETWEEN …`; then refine the square to the exact 3 km circle (pyproj distance). **Fallback:** pull-then-filter (the national set is small) if the SQL endpoint is ever down.
- **Surface = dedicated "Cellular" tab** that **reuses the same Leaflet + OpenStreetMap map as the Geolocation tab** (Project General): home pin + **3 km circle** + carrier-colored tower pins + hover/click tooltip (carrier · distance · tech · radiation % of threshold · permit PDFs) + a sortable closest-first list below the map. (User chose a standalone Cellular tab over a layer-toggle on the geolocation map.)
- **API re-verified live 2026-06-12:** total 8,423, schema unchanged; Hod HaSharon city-match = 69 (the 3 km radius subset is fewer). Carriers in-area: Cellcom, Pelephone, PHI (serves HOT + Partner).

The schema / coordinate-conversion / table / caveats sections below still apply — only the *scope* (area-only) and *surface* (geolocation-style map on a Cellular tab) changed.

## Why this is good news

Israeli law requires public disclosure of cellular antenna sites + measured radiation values. The Ministry of Environmental Protection (המשרד להגנת הסביבה) actually publishes this via `data.gov.il` as a queryable CKAN API. **No scraping, no captchas, no rate limits encountered, full schema available** — confirmed by direct API test on 2026-05-21.

Better still, each record includes:
- **Measured radiation** (`עוצמה מרבית תיאורטית בµW לסמר` = theoretical max in µW/cm²)
- **Percentage of health threshold** at the worst-case measurement point
- **Description** of the worst-case measurement location
- **PDF links** to the actual construction + operating permits

So this is not just "where are the towers" but "where are they and what radiation level was measured at each one and at what point" — way richer than typical OSM/CellMapper-style data.

## Data sources (verified live 2026-05-21)

| Dataset | Resource ID | Format | Records | Notes |
|---|---|---|---|---|
| **Active antennas** (`antennaactive`) | `8935c8e5-ec77-421f-af86-d970583195f8` | CKAN datastore (JSON) | **8,423 nationwide** | Primary source. Full schema, queryable. |
| **Under-construction antennas** (`antenna_hakama`) | `ff398c7e-c522-4ee8-a53a-312b188a573d` | XLSX | unknown | Updates daily — last modified `2026-05-21T19:01:26`. Future antennas you should know about. |

### API endpoint pattern (works as-is)

```
https://data.gov.il/api/3/action/datastore_search?resource_id=<id>&limit=1000&offset=<n>
```

Returns standard CKAN JSON. Supports `q=<freetext>` for full-text and `filters={"חברה":"פלאפון"}` for column-equality. The `datastore_search_sql` endpoint takes raw SQL for advanced queries.

Total pull is 8,423 records ÷ 1,000 per page = **9 paged requests** — trivial.

### Schema (Hebrew column names; translation table)

| Hebrew | English / what it is |
|---|---|
| `ID` | Antenna ID |
| `חברה` | Carrier (Cellcom, Pelephone, PHI, HOT Mobile, Golan Telecom) |
| `מס' אתר` | Site number |
| `עיר` | City |
| `כתובת האתר` | Site address |
| `רשות מקומית` | Local authority |
| `תחום שיפוט` | Jurisdiction |
| `X_ITM`, `Y_ITM` | **Israel Transverse Mercator (EPSG:2039)** — NOT lat/lon |
| `סוג אתר` | Site type (e.g. `תורן קרקעי` = ground mast, `אתר על גג` = rooftop) |
| `תאריך היתר הקמה` | Construction permit date |
| `תאריך היתר הפעלה` | Operating permit date |
| `בדיקה תקופתית אחרונה` | Last periodic inspection |
| `היתר קרינה` | Radiation permit status |
| `עוצמה מרבית תיאורטית בµW לסמר` | **Theoretical max power, µW/cm²** ← the radiation number |
| `תוצאה מירבית ב% ביחס לסף הבריאות` | Max measured result as % of health threshold ← the actually-measured exposure |
| `תאור נקודה בה התקבלה תוצאה מירבית` | Description of the point where the max was measured |
| `קובץ הקמה` | Construction permit PDF URL (`http://documents.sviva.gov.il/B001_*.pdf`) |
| `קובץ הפעלה` | Operating permit PDF URL (`http://documents.sviva.gov.il/B002_*.pdf`) |
| `טכנולוגיית שידור` | Broadcast technology (`דור 2 3 4 5`) |

## Coordinate system note — ITM vs WGS84

The `X_ITM` / `Y_ITM` columns use Israel Transverse Mercator (**EPSG:2039**), NOT lat/lon. For dashboard rendering, distance calculations, and `govmap.gov.il` URL building, we need WGS84 (`EPSG:4326`).

Two options for the conversion:

1. **PostGIS on LXC 102**: install `postgis` extension, use `ST_Transform(ST_SetSRID(ST_MakePoint(x, y), 2039), 4326)` directly in queries. Clean, fast, lazy.
2. **Python `pyproj`** at ingest time: convert once, store both `(x_itm, y_itm)` and `(lat, lon)`. No PostGIS dependency.

Recommend Option 2 — pyproj is in stdlib-adjacent territory and avoids adding PostGIS to LXC 102 just for this. Two extra columns is cheap.

The Rehovot data city portal mirror (`rehovot.datacity.org.il/...`) already has `lon`/`lat` columns added, but the file is stale (2024-08-07) and may be Rehovot-area filtered (only 22 KB). Don't use as primary source — go straight to `data.gov.il`.

## Architecture

```
data.gov.il CKAN API
       │
       │ (Python ingest, weekly cron)
       ▼
LXC 104 / cron pull script
       │
       │ INSERT/UPDATE
       ▼
LXC 102 / cellular_antennas table
       │
       │ SELECT WHERE ST_Distance(...) < radius
       ▼
LXC 103 / dashboard /api/cellular/nearby endpoint
       │
       │ JSON
       ▼
BOILER/dashboard/public/network.html — Cellular tab
       │
       │ Leaflet/OpenLayers map + list
       ▼
User sees: nearby antennas with carrier, distance, radiation level, last inspection
```

## Tables on LXC 102

```sql
CREATE TABLE cellular_antennas (
  id INTEGER PRIMARY KEY,                  -- the dataset's ID column
  site_no TEXT,                            -- מס' אתר
  carrier TEXT,                            -- חברה
  city TEXT,                               -- עיר
  address TEXT,                            -- כתובת האתר
  local_authority TEXT,                    -- רשות מקומית
  jurisdiction TEXT,                       -- תחום שיפוט
  x_itm DOUBLE PRECISION,
  y_itm DOUBLE PRECISION,
  lat DOUBLE PRECISION,                    -- pyproj-converted
  lon DOUBLE PRECISION,
  site_type TEXT,                          -- סוג אתר
  construction_permit_date DATE,
  operating_permit_date DATE,
  last_inspection_date DATE,
  radiation_permit TEXT,                   -- היתר קרינה
  max_theoretical_uw_per_cm2 NUMERIC,      -- ← radiation
  max_measured_pct_of_threshold NUMERIC,   -- ← actual exposure %
  worst_point_description TEXT,
  construction_pdf_url TEXT,
  operating_pdf_url TEXT,
  technology TEXT,                         -- דור 2/3/4/5
  last_ingest TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX cellular_antennas_geo ON cellular_antennas (lat, lon);
CREATE INDEX cellular_antennas_carrier ON cellular_antennas (carrier);
```

Add a retention policy row: `keep_days = NULL (forever)`, `auto_clean = false`. This is reference data, not events.

A second table for under-construction antennas (`cellular_antennas_planned`) with the same shape. Maybe one more column `expected_active_date`.

## Ingest script (LXC 104)

Path: `/opt/cellular-network-agent/ingest_antennas.py`. Companion service: `cellular-antennas-ingest.timer` (weekly, e.g. Sundays at 04:00).

```python
import requests, psycopg2, pyproj
from datetime import datetime

ACTIVE_RES = "8935c8e5-ec77-421f-af86-d970583195f8"
PAGE_SIZE = 1000

itm_to_wgs = pyproj.Transformer.from_crs("EPSG:2039", "EPSG:4326", always_xy=True)

def fetch_all(resource_id):
    offset = 0
    while True:
        url = f"https://data.gov.il/api/3/action/datastore_search?resource_id={resource_id}&limit={PAGE_SIZE}&offset={offset}"
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
        records = r.json()["result"]["records"]
        if not records: return
        for rec in records: yield rec
        offset += PAGE_SIZE

def upsert(conn, rec):
    lon, lat = itm_to_wgs.transform(rec["X_ITM"], rec["Y_ITM"])
    # ... INSERT ... ON CONFLICT (id) DO UPDATE SET ...
    pass

# Main: loop fetch_all → upsert; write last_ingest timestamp
```

Runtime estimate: 9 paged requests at ~2 s each + 8,423 upserts = under 1 minute total. Run weekly, no rush.

## Dashboard endpoint + page

```
GET /api/cellular/nearby?lat=32.15&lon=34.89&radius_km=3
```

Returns array of antennas within `radius_km` of the given coordinates, sorted by distance ascending. Includes a `distance_m` computed field.

For "near my apartment" the apartment center coordinates come from `dashboard_settings.apartment.location` (already populated for the home_time_periods sun-event calculations — same lat/lon).

Dashboard tab content:

| Section | What |
|---|---|
| **Apartment context card** | "Within 3 km of your apartment: 47 active antennas. Closest: Cellcom at 412 m (last measured 18% of threshold)." |
| **Antenna list** | Sortable table: carrier · distance · address · technology · last inspection · radiation % · permits |
| **Map** | Leaflet with apartment as a center pin + concentric radius circles (500m / 1km / 3km), antennas as carrier-colored pins, hover for tooltip |
| **Filters** | by carrier, by technology, by radiation level (low / medium / high) |
| **PDF links** | "Construction permit" and "Operating permit" buttons open the gov.il PDFs in a new tab |

## Phase plan

| Phase | Effort | What ships |
|---|---|---|
| **Phase 1** | 1-2 h | Ingest script + table + cron + manual run to populate ~8,500 rows. Verify a known antenna near home. |
| **Phase 2** | 2-3 h | `/api/cellular/nearby` endpoint + Cellular tab on network.html with the apartment context card + sortable list. |
| **Phase 3** | 1-2 h | Map view (Leaflet). |
| **Phase 4** | 1 h | Add the planned/under-construction antennas (`antenna_hakama`) as a separate overlay or tab — useful early warning for new antennas coming up nearby. |
| **Phase 5** | optional | Alerting: if a new antenna appears within 500 m of home, surface as a `cellular:new_antenna_nearby` alert in the existing `system_alerts` table. |

## Caveats

- **Israeli law restricts the dataset to LICENSED antennas only**. Unlicensed or illegal sites (rare but exist) won't show. Use OpenCelliD + CellMapper as second sources for cross-checking actual radio reception.
- **Antenna location ≠ exposure level at your apartment**. The `worst_point_description` and `max_measured_pct_of_threshold` fields are for the WORST point near the antenna, not for any specific home. To know exposure at your windows you still need an RF meter (Cornet ED88TPlus / GQ EMF-390 / Trifield TF2 — none of which integrate with this project today; would be a separate module if ever added).
- **`X_ITM` / `Y_ITM` are NOT lat/lon**. Don't paste into Google Maps — it'll point you at Antarctica. Use pyproj or PostGIS.
- **Data freshness**: active-antennas dataset updates monthly-ish; under-construction updates daily. Weekly cron is plenty.

## Out of scope

- Bluetooth, WiFi (see [WIFI_NETWORK](../WIFI_NETWORK/CLAUDE.md))
- Smart meter RF, microwave leakage, neighbour-router RF — these are not in the dataset
- TV/radio broadcast transmitters — different dataset, not yet checked
- Live RF measurement — hardware-only

## Status

Documentation only — no code written yet. **API re-verified live 2026-06-12** (8,423 total, schema unchanged from the 2026-05-21 first test). **Scope locked 2026-06-12** (see Scope section): your-area-only (3 km radius around home via ITM bounding-box), dedicated **Cellular tab reusing the geolocation Leaflet+OSM map**. Build starts on the user's go; nothing requires being on the home network (the data.gov.il API is public, ingest can run from any LXC). Tab UI needs implementing in the dashboard.

## References

- [data.gov.il — antennaactive dataset](https://data.gov.il/dataset/antennaactive)
- [data.gov.il — antenna_hakama (under construction)](https://data.gov.il/dataset/antenna_hakama)
- [Govmap CELL_ACTIVE layer (browser-only viewer)](https://www.govmap.gov.il/sviva?c=204000,595000&z=8&b=0&lay=CELL_ACTIVE)
- [Ministry of Environmental Protection — radio frequency radiation page](https://www.gov.il/he/departments/guides/radio_frequency_radiation)
- [pyproj coordinate transform library](https://pyproj4.github.io/pyproj/)
- EPSG codes: `2039` = ITM (Israel Transverse Mercator), `4326` = WGS84 (standard lat/lon)
