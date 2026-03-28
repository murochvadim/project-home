CREATE TABLE IF NOT EXISTS system_alerts (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          VARCHAR(50)  NOT NULL DEFAULT 'orchestrator',
  severity        VARCHAR(10)  NOT NULL DEFAULT 'warn',
  affected_agent  VARCHAR(50),
  alert_type      VARCHAR(50)  NOT NULL,
  message         TEXT         NOT NULL,
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alerts_active     ON system_alerts (resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_agent      ON system_alerts (affected_agent, resolved_at);
