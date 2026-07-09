-- 001_notifications.sql — Notifications subsystem (Phase 1).
-- A reusable, user-authored notification system. Each notification you create
-- has a TRIGGER (what makes it fire), optional CONDITIONS (gates that must all
-- be true), and a WHEN/WHERE (delivery mode + surfaces). The rule engine on
-- LXC 105 (RULES/rules/notifications.py, group `notify`) watches triggers and
-- inserts a notification_events row when one fires; the dashboard renders those
-- as centered popups (notify-toast.js) and, later, pushes them to the phone.
--
-- Dashboard tab: Main Agent → Notifications (UI only — authoring + rendering).
-- Producers live on the LXC (honors the hard architecture rule).

BEGIN;

-- ── The notifications you author (config; forever + protected) ──
CREATE TABLE IF NOT EXISTS notification_defs (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  -- trigger: what makes it fire. v1: main_door_closed | home_mode_changed |
  --          people_count_changed | scheduled_time
  trigger        TEXT NOT NULL,
  trigger_param  TEXT,                       -- e.g. target mode for home_mode_changed, or HH:MM for scheduled_time
  -- conditions: AND-ed gates, list of {field, op, value}. field ∈
  --   home_mode | people_home | time_window | day    (see rule for op/value shapes)
  conditions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  message        TEXT NOT NULL DEFAULT '',    -- free text with {placeholders}: {people_home} {home_mode} {time} {date} {count}
  -- delivery: off is expressed via enabled=false; delivery ∈ immediate | at_time | daily
  delivery       TEXT NOT NULL DEFAULT 'immediate',
  delivery_time  TEXT,                        -- HH:MM for at_time / daily
  throttle_min   INTEGER NOT NULL DEFAULT 0,  -- min minutes between fires (0 = no throttle)
  -- surfaces: where it shows. {popup: bool, pages: [slug…] | 'all', phone: bool}
  surfaces       JSONB NOT NULL DEFAULT '{"popup":true,"pages":"all","phone":false}'::jsonb,
  level          TEXT NOT NULL DEFAULT 'info',-- info | warn | alert (styles the popup accent)
  action         TEXT,                        -- interactive popup: 'set_people' adds a number input + Save (writes the manual people count)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Fired instances = the feed the dashboard popup polls (30-day retention) ──
CREATE TABLE IF NOT EXISTS notification_events (
  id            BIGSERIAL PRIMARY KEY,
  def_id        INTEGER REFERENCES notification_defs(id) ON DELETE SET NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  title         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  level         TEXT NOT NULL DEFAULT 'info',
  surfaces      JSONB NOT NULL DEFAULT '{"popup":true,"pages":"all","phone":false}'::jsonb,
  dedupe_key    TEXT,                          -- optional: collapse duplicates
  expires_at    TIMESTAMPTZ,                   -- popup ignores events past this
  pushed        BOOLEAN NOT NULL DEFAULT false,-- phone-push forwarder marks this (Phase 3)
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_events_ts ON notification_events (ts DESC);

-- ── Seed: the first notification — door closes & home → people-home popup ──
INSERT INTO notification_defs (name, enabled, trigger, trigger_param, conditions, message, delivery, surfaces, level, action)
SELECT
  'Main door closed — people home', true, 'main_door_closed', NULL,
  '[{"field":"home_mode","op":"is","value":"home"}]'::jsonb,
  '🚪 Main door closed — {people_home} people at home',
  'immediate',
  '{"popup":true,"pages":"all","phone":false}'::jsonb,
  'info', 'set_people'
WHERE NOT EXISTS (SELECT 1 FROM notification_defs WHERE trigger = 'main_door_closed');

COMMIT;
