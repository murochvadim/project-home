-- Balcony / HASP widget schema extensions, generated 2026-05-01.
-- System-wide tables (hasp_buttons / hasp_displays) — applies to every panel,
-- not balcony-only. Lives under BALCONY/migrations/ because Balcony is the
-- first agent to consume them.
-- Idempotent: safe to re-run.

-- 1) hasp_buttons.event — distinguish 'short' / 'long' / 'down' / 'up' / 'double'
--    so one button can have different bindings per event type.
ALTER TABLE hasp_buttons
  ADD COLUMN IF NOT EXISTS event VARCHAR(20) NOT NULL DEFAULT 'short';

-- 2) Replace UNIQUE(panel_id, page, button_id) with UNIQUE(panel_id, page, button_id, event).
ALTER TABLE hasp_buttons
  DROP CONSTRAINT IF EXISTS hasp_buttons_panel_id_page_button_id_key;
ALTER TABLE hasp_buttons
  DROP CONSTRAINT IF EXISTS hasp_buttons_panel_id_page_button_id_event_key;
ALTER TABLE hasp_buttons
  ADD CONSTRAINT hasp_buttons_panel_id_page_button_id_event_key
  UNIQUE (panel_id, page, button_id, event);

-- 3) hasp_displays.target_property — which HASP property to mutate
--    ('text' for labels, 'val' for gauges/sliders, 'bg_color' for tint, etc.)
ALTER TABLE hasp_displays
  ADD COLUMN IF NOT EXISTS target_property VARCHAR(20) NOT NULL DEFAULT 'text';

-- 4) hasp_displays.display_type — widget shape so the renderer knows how to
--    fan a single source out into multiple props ('text' = simple label,
--    'gauge' = single val, 'series' = bar/dot history, 'bar' = static bar).
ALTER TABLE hasp_displays
  ADD COLUMN IF NOT EXISTS display_type VARCHAR(20) NOT NULL DEFAULT 'text';
