-- Per-site receipts (invoices/receipts extracted from email), linked to a Privacy Site.
-- Written by the Email Agent (LXC 110) when an automation rule with store='receipt'
-- fires live: it stores the STRUCTURED data here (vendor / amount / invoice_date) so the
-- per-site Receipts window can total + CSV-export + graph it. The ORIGINAL PDF is filed
-- into the site's Docs window (privacy_site_docs) by the DASHBOARD (LXC 110 has no QNAP
-- access) and linked back here via doc_id. The generic email_extractions audit row is
-- still written too (Email domain). Added 2026-07-02.
CREATE TABLE IF NOT EXISTS privacy_site_receipts (
  id           BIGSERIAL PRIMARY KEY,
  site_id      INTEGER NOT NULL REFERENCES privacy_sites(id) ON DELETE CASCADE,
  vendor       TEXT,
  amount       NUMERIC(12,2),
  currency     TEXT DEFAULT 'ILS',
  invoice_date DATE,
  invoice_no   TEXT,
  gmail_id     TEXT,
  doc_id       INTEGER REFERENCES privacy_site_docs(id) ON DELETE SET NULL,
  data         JSONB,
  source       TEXT DEFAULT 'email',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- one receipt per source email (Run-now / poll overlap never duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_receipts_gmail
  ON privacy_site_receipts (gmail_id) WHERE gmail_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_receipts_site
  ON privacy_site_receipts (site_id, invoice_date DESC);

-- forever + protected (financial data, like the other privacy_* tables)
INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, protected, description)
VALUES ('privacy_site_receipts', NULL, false, 24, true,
        'Per-site receipts/invoices extracted from email (financial - forever, protected)')
ON CONFLICT (table_name) DO NOTHING;
