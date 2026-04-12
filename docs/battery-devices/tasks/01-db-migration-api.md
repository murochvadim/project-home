# Task 1: DB Migration + API Endpoints

**Feature:** battery-devices
**Tech Design:** [../tech-design.md](../tech-design.md)
**Discovery:** [../discovery.md](../discovery.md)

## What to do

1. Add `dashboard_settings` table to `ensureSchema()` in `server.js`:
```sql
CREATE TABLE IF NOT EXISTS dashboard_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

2. Seed default battery thresholds if table is empty:
```sql
INSERT INTO dashboard_settings (key, value)
VALUES ('battery_thresholds', '{"good": 60, "low": 20}'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

3. Add `dashboard_settings` to retention_policies seed (keep_days: null, auto_clean: false).

4. Add two API endpoints:
```
GET  /api/dashboard-settings/:key
POST /api/dashboard-settings/:key  body: { value: {...} }
```

GET returns `{ value, updated_at }` or `{ value: null }` if not found.
POST upserts with `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`.

## Files
- `BOILER/dashboard/server.js`

## Acceptance
- `curl /api/dashboard-settings/battery_thresholds` returns `{ value: { good: 60, low: 20 }, updated_at: "..." }`
- POST with new values → GET returns updated values
- Table exists in DB after dashboard restart
