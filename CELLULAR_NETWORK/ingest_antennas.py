#!/usr/bin/env python3
"""Cellular antenna ingest — populate `cellular_antennas` (LXC 102) with the
antennas within RADIUS_M of home, from the Israeli Ministry of Environmental
Protection registry (data.gov.il CKAN).

Pull-then-filter: data.gov.il's `datastore_search_sql` (server-side bounding
box) returns HTTP 403 (disabled), so we pull the full national set via the basic
`datastore_search` (small — ~8.4k rows, ~4 s) and filter to the home radius
locally with pyproj (ITM→WGS84) + haversine. The STORED table holds only the
~hundred antennas near home, never the national set.

Home center is read from `dashboard_settings.geolocation.center` (same point the
geolocation map uses). Atomic replace: fetch+filter into memory, then
DELETE-all + INSERT in ONE transaction — handles antennas added/removed cleanly,
and never touches the table if the fetch fails.

Deploy: /opt/cellular-network-agent/ingest_antennas.py on LXC 104 (the
commands/timers LXC). Runs weekly via `cellular-antennas-ingest.timer`.
Venv: /opt/cellular-network-agent/venv (pyproj + psycopg2-binary).
"""
import json
import sys
import urllib.request
from datetime import datetime
from math import asin, cos, radians, sin, sqrt

import psycopg2
from psycopg2.extras import execute_values
from pyproj import Transformer

DB = dict(host="192.168.1.219", dbname="home_data", user="postgres")
RES = "8935c8e5-ec77-421f-af86-d970583195f8"   # antennaactive resource id
RADIUS_M = 2000
PAGE = 1000
UA = {"User-Agent": "Mozilla/5.0"}

_to_wgs = Transformer.from_crs("EPSG:2039", "EPSG:4326", always_xy=True)  # ITM → lat/lon

# Hebrew source column → table column
COLS = {
    "ID": "id", "מס' אתר": "site_no", "חברה": "carrier", "עיר": "city",
    "כתובת האתר": "address", "רשות מקומית": "local_authority", "תחום שיפוט": "jurisdiction",
    "סוג אתר": "site_type", "תאריך היתר הקמה": "construction_permit_date",
    "תאריך היתר הפעלה": "operating_permit_date", "בדיקה תקופתית אחרונה": "last_inspection_date",
    "היתר קרינה": "radiation_permit", "עוצמה מרבית תיאורטית בµW לסמר": "max_theoretical_uw_per_cm2",
    "תוצאה מירבית ב% ביחס לסף הבריאות": "max_measured_pct_of_threshold",
    "תאור נקודה בה התקבלה תוצאה מירבית": "worst_point_description",
    "קובץ הקמה": "construction_pdf_url", "קובץ הפעלה": "operating_pdf_url",
    "טכנולוגיית שידור": "technology",
}
# Insert order (lat/lon/x_itm/y_itm are computed/copied, not from COLS rename)
INSERT_COLS = [
    "id", "site_no", "carrier", "city", "address", "local_authority", "jurisdiction",
    "x_itm", "y_itm", "lat", "lon", "site_type", "construction_permit_date",
    "operating_permit_date", "last_inspection_date", "radiation_permit",
    "max_theoretical_uw_per_cm2", "max_measured_pct_of_threshold",
    "worst_point_description", "construction_pdf_url", "operating_pdf_url", "technology",
]


def _haversine(la1, lo1, la2, lo2):
    R = 6371000
    d1, d2 = radians(la2 - la1), radians(lo2 - lo1)
    a = sin(d1 / 2) ** 2 + cos(radians(la1)) * cos(radians(la2)) * sin(d2 / 2) ** 2
    return 2 * R * asin(sqrt(a))


def _date(v):
    if v in (None, ""):
        return None
    s = str(v).strip().split("T")[0]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _num(v):
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def _home_center(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM dashboard_settings WHERE key = 'geolocation'")
        row = cur.fetchone()
    c = ((row[0] if row else {}) or {}).get("center", {})
    return float(c["lat"]), float(c["lon"])


def fetch_all():
    off = 0
    while True:
        u = f"https://data.gov.il/api/3/action/datastore_search?resource_id={RES}&limit={PAGE}&offset={off}"
        recs = json.load(urllib.request.urlopen(
            urllib.request.Request(u, headers=UA), timeout=60))["result"]["records"]
        if not recs:
            return
        yield from recs
        off += PAGE


def main():
    conn = psycopg2.connect(**DB)
    conn.autocommit = False
    try:
        home_lat, home_lon = _home_center(conn)
        near, scanned = [], 0
        for r in fetch_all():
            scanned += 1
            x, y = r.get("X_ITM"), r.get("Y_ITM")
            if x in (None, "") or y in (None, ""):
                continue
            try:
                lon, lat = _to_wgs.transform(float(x), float(y))
            except (ValueError, TypeError):
                continue
            if _haversine(home_lat, home_lon, lat, lon) > RADIUS_M:
                continue
            rec = {"x_itm": float(x), "y_itm": float(y),
                   "lat": round(lat, 7), "lon": round(lon, 7)}
            for heb, col in COLS.items():
                v = r.get(heb)
                if col == "id":
                    rec[col] = int(v)
                elif col.endswith("_date"):
                    rec[col] = _date(v)
                elif col.startswith("max_"):
                    rec[col] = _num(v)
                else:
                    rec[col] = (str(v).strip() if v not in (None, "") else None)
            near.append(rec)

        if not near:
            print(f"WARN scanned {scanned}, 0 within {RADIUS_M} m — table left unchanged",
                  file=sys.stderr)
            return

        with conn.cursor() as cur:
            cur.execute("DELETE FROM cellular_antennas")
            execute_values(
                cur,
                f"INSERT INTO cellular_antennas ({','.join(INSERT_COLS)}) VALUES %s",
                [[rec.get(c) for c in INSERT_COLS] for rec in near],
            )
        conn.commit()
        print(f"OK scanned {scanned} national -> stored {len(near)} antennas "
              f"within {RADIUS_M} m of ({home_lat}, {home_lon})")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
