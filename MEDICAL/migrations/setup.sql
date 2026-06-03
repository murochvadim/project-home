-- ════════════════════════════════════════════════════════════
-- Medical Agent — Phase 1 setup migration
-- Idempotent: safe to re-run.
-- Scope: 8 medical_* tables + retention policies + agents row
--        + cleanup of legacy "documents" table.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. medical_providers ─────────────────────────────────
-- Address book for clinics, doctors, hospitals, labs.
-- Self-FK parent_id lets doctors belong to a clinic.
CREATE TABLE IF NOT EXISTS medical_providers (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('clinic', 'doctor', 'hospital', 'lab')),
  name         TEXT NOT NULL,
  parent_id    INTEGER REFERENCES medical_providers(id) ON DELETE SET NULL,
  specialty    TEXT,
  address      TEXT,
  phone        TEXT,
  email        TEXT,
  website_url  TEXT,
  patient_portal_url TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medical_providers_kind ON medical_providers(kind);
CREATE INDEX IF NOT EXISTS idx_medical_providers_parent ON medical_providers(parent_id);

-- ─── 2. medical_visits ─────────────────────────────────────
-- Past doctor visits (already happened).
CREATE TABLE IF NOT EXISTS medical_visits (
  id                     SERIAL PRIMARY KEY,
  visit_date             DATE NOT NULL,
  doctor_name            TEXT NOT NULL,
  specialty              TEXT,
  clinic                 TEXT,
  center_id              INTEGER REFERENCES medical_providers(id) ON DELETE SET NULL,
  reason                 TEXT,
  notes                  TEXT,
  conclusion             TEXT,
  follow_up_needed       BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_after_weeks  INTEGER,
  linked_document_ids    INTEGER[] NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medical_visits_date ON medical_visits(visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_medical_visits_doctor ON medical_visits(doctor_name);

-- ─── 3. medical_appointments ───────────────────────────────
-- Future scheduled visits.
CREATE TABLE IF NOT EXISTS medical_appointments (
  id               SERIAL PRIMARY KEY,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  doctor_name      TEXT NOT NULL,
  specialty        TEXT,
  clinic           TEXT,
  center_id        INTEGER REFERENCES medical_providers(id) ON DELETE SET NULL,
  address          TEXT,
  reason           TEXT,
  reminder_at      TIMESTAMPTZ,
  confirmed        BOOLEAN NOT NULL DEFAULT FALSE,
  linked_visit_id  INTEGER REFERENCES medical_visits(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medical_appointments_scheduled ON medical_appointments(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_medical_appointments_status ON medical_appointments(status);

-- ─── 4. medical_documents ─────────────────────────────────
-- PDFs / images / scanned results, stored on QNAP NFS.
CREATE TABLE IF NOT EXISTS medical_documents (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  mime_type        TEXT,
  size_bytes       BIGINT,
  doc_type         TEXT NOT NULL DEFAULT 'other'
                   CHECK (doc_type IN ('prescription', 'lab_result', 'imaging',
                                       'doctor_letter', 'invoice', 'other')),
  issued_date      DATE,
  linked_visit_id  INTEGER REFERENCES medical_visits(id) ON DELETE SET NULL,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  notes            TEXT,
  ocr_text         TEXT,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by      TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_medical_documents_visit ON medical_documents(linked_visit_id);
CREATE INDEX IF NOT EXISTS idx_medical_documents_type ON medical_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_medical_documents_issued ON medical_documents(issued_date DESC);

-- ─── 5. medications ───────────────────────────────────────
-- Active + past prescriptions.
CREATE TABLE IF NOT EXISTS medications (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL,
  dosage                    TEXT,
  prescribed_by             TEXT,
  prescribed_at_visit_id    INTEGER REFERENCES medical_visits(id) ON DELETE SET NULL,
  start_date                DATE,
  end_date                  DATE,
  purpose                   TEXT,
  notes                     TEXT,
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medications_active ON medications(active);

-- ─── 6. medication_schedules ──────────────────────────────
-- One row per time slot per medication.
CREATE TABLE IF NOT EXISTS medication_schedules (
  id                     SERIAL PRIMARY KEY,
  medication_id          INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  time_of_day            TIME NOT NULL,
  days_of_week           INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  with_food              BOOLEAN NOT NULL DEFAULT FALSE,
  alert_minutes_before   INTEGER NOT NULL DEFAULT 0,
  alert_methods          TEXT[] NOT NULL DEFAULT '{dashboard}',
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medication_schedules_med ON medication_schedules(medication_id);
CREATE INDEX IF NOT EXISTS idx_medication_schedules_active ON medication_schedules(active);

-- ─── 7. medication_log ────────────────────────────────────
-- When the user confirmed taking a pill (or skipped).
CREATE TABLE IF NOT EXISTS medication_log (
  id              SERIAL PRIMARY KEY,
  medication_id   INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  schedule_id     INTEGER REFERENCES medication_schedules(id) ON DELETE SET NULL,
  due_at          TIMESTAMPTZ NOT NULL,
  taken_at        TIMESTAMPTZ,
  skipped         BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_medication_log_due ON medication_log(due_at DESC);
CREATE INDEX IF NOT EXISTS idx_medication_log_med_due ON medication_log(medication_id, due_at DESC);

-- ─── 8. medical_conclusions ───────────────────────────────
-- Timeline of statements: doctor, AI, or self.
CREATE TABLE IF NOT EXISTS medical_conclusions (
  id                    SERIAL PRIMARY KEY,
  ts                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                TEXT NOT NULL CHECK (source IN ('doctor', 'ai', 'self')),
  source_name           TEXT,
  category              TEXT NOT NULL DEFAULT 'observation'
                        CHECK (category IN ('diagnosis', 'recommendation', 'observation', 'risk_factor')),
  text                  TEXT NOT NULL,
  confidence            TEXT DEFAULT 'probable'
                        CHECK (confidence IN ('definite', 'probable', 'speculative')),
  linked_visit_id       INTEGER REFERENCES medical_visits(id) ON DELETE SET NULL,
  linked_document_ids   INTEGER[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medical_conclusions_ts ON medical_conclusions(ts DESC);
CREATE INDEX IF NOT EXISTS idx_medical_conclusions_source ON medical_conclusions(source);

-- ─── retention_policies — all 8 tables forever ───────────
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description) VALUES
  ('medical_providers',     NULL, FALSE, 24, 'Address book for clinics + doctors. Forever (config-like).'),
  ('medical_visits',        NULL, FALSE, 24, 'Past doctor visits. Forever (lifetime medical record).'),
  ('medical_appointments',  NULL, FALSE, 24, 'Future scheduled visits. Forever (history of completed ones is valuable).'),
  ('medical_documents',     NULL, FALSE, 24, 'PDFs / lab results / imaging metadata. Forever (path metadata; files on QNAP).'),
  ('medications',           NULL, FALSE, 24, 'Active + discontinued prescriptions. Forever (lifetime medication history).'),
  ('medication_schedules',  NULL, FALSE, 24, 'When to take each pill. Forever (config-like).'),
  ('medication_log',        NULL, FALSE, 24, 'Taken / skipped log. Forever (adherence history).'),
  ('medical_conclusions',   NULL, FALSE, 24, 'Doctor / AI / self conclusions timeline. Forever.')
ON CONFLICT (table_name) DO NOTHING;

-- ─── agents row ───────────────────────────────────────────
INSERT INTO agents (
  name, description, lxc_id, lxc_ip, service_name,
  data_table, settings_table, enabled,
  deploy_path, git_branch, service_oneshot
) VALUES (
  'medical',
  'Centralized medical history: visits, appointments, prescriptions, documents, conclusions, providers',
  NULL, NULL, NULL,
  NULL, NULL, TRUE,
  NULL, NULL, FALSE
)
ON CONFLICT (name) DO NOTHING;

-- ─── Cleanup legacy "documents" table ─────────────────────
-- The Project Health Documents tab held 2 stale URL rows (HOOK,
-- Home Connect Re-auth). Both unrelated to medical; user OK'd removal.
-- /api/documents/file (used by viewer.html for the generic file viewer)
-- DOES NOT touch this table; it's a filesystem endpoint. Safe to drop.
DROP TABLE IF EXISTS documents;
DELETE FROM retention_policies WHERE table_name = 'documents';

COMMIT;
