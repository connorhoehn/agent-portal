-- Durable authorization audit trail. The middleware's in-memory ring buffer
-- (last 1000 events, SSE) remains the live view; this table is the permanent
-- record, written by a batched write-behind sink in middleware/src/lib/audit.ts.

CREATE SCHEMA IF NOT EXISTS observability;

CREATE TABLE IF NOT EXISTS observability.authz_events (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL,           -- ALLOW | DENY
  action   TEXT NOT NULL,           -- Cedar action id, or session lifecycle (Login, Masquerade, TenantScope, ...)
  sub      TEXT NOT NULL,           -- effective identity
  role     TEXT NOT NULL,
  tenant   TEXT,
  actor    TEXT,                    -- real identity when masquerading
  path     TEXT,
  reason   TEXT
);

CREATE INDEX IF NOT EXISTS authz_events_ts_idx     ON observability.authz_events (ts DESC);
CREATE INDEX IF NOT EXISTS authz_events_tenant_idx ON observability.authz_events (tenant, ts DESC);
CREATE INDEX IF NOT EXISTS authz_events_sub_idx    ON observability.authz_events (sub, ts DESC);
