-- Medical Documents tab (added 2026-06-03).
-- One table backing the new "Documents" sub-tab on medical.html.
-- Files live on QNAP at \\192.168.1.155\Claude_Data\Medical_Documents\
-- (mounted on LXC 104 as /mnt/qnap-claude/Medical_Documents).
-- file_path stores the basename only; the storage root is in server.js.

BEGIN;

CREATE TABLE IF NOT EXISTS medical_documents (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    doc_type    TEXT NOT NULL CHECK (doc_type IN (
                  'lab_result', 'imaging', 'prescription', 'visit_summary',
                  'referral', 'insurance', 'vaccine_record', 'id_card', 'other')),
    doctor_id   INTEGER REFERENCES medical_contacts(id) ON DELETE SET NULL,
    producer_id INTEGER REFERENCES medical_contacts(id) ON DELETE SET NULL,
    file_path   TEXT NOT NULL,
    file_size   BIGINT NOT NULL,
    mime_type   TEXT NOT NULL,
    doc_date    DATE,
    notes       TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_med_docs_type     ON medical_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_med_docs_doctor   ON medical_documents(doctor_id);
CREATE INDEX IF NOT EXISTS idx_med_docs_producer ON medical_documents(producer_id);
CREATE INDEX IF NOT EXISTS idx_med_docs_uploaded ON medical_documents(uploaded_at DESC);

INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
VALUES ('medical_documents', NULL, false, 24, 'Medical document metadata + filesystem refs. Retention=forever.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
