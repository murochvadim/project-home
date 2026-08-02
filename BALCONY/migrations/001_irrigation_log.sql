-- Watering history: one row per valve open -> close session.
-- Written by the Irrigation Log rule (LXC 105); read by the Balcony Irrigation
-- tab's Watering history card. Retention: forever + protected.

CREATE TABLE IF NOT EXISTS irrigation_log (
  id           BIGSERIAL PRIMARY KEY,
  valve_id     TEXT NOT NULL,
  valve_name   TEXT,
  opened_at    TIMESTAMPTZ NOT NULL,
  closed_at    TIMESTAMPTZ NOT NULL,
  duration_sec INTEGER NOT NULL,
  source       TEXT,                       -- 'schedule' | 'manual' | 'unknown'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_log_valve_ts ON irrigation_log (valve_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_irrigation_log_opened   ON irrigation_log (opened_at DESC);

-- Retention: forever (keep_days NULL, auto_clean false) + protected (never auto-deleted).
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description, protected)
VALUES ('irrigation_log', NULL, false, 24, 'Watering history — one row per valve open/close session', true)
ON CONFLICT (table_name) DO UPDATE SET protected = true;
