-- Human-in-the-loop approvals for high-stakes agent actions.
--
-- Workflow agents (esp. transaction-ingest) call the `request_approval` Strands
-- tool when a transaction exceeds a Cedar-gated threshold. The tool POSTs to
-- middleware which inserts a row here and long-polls until status changes.
--
-- Cedar gates who can approve (action: OrgIQ::Action::"ApproveTransaction").
--
-- Apply via:
--   ./infra/scripts/apply-observability-approvals-schema.sh

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- Approval requests (one row per high-stakes agent action awaiting decision)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.approvals (
  approval_id  uuid PRIMARY KEY,
  tx_id        text NOT NULL,
  agent_id     text NOT NULL,
  payload      jsonb NOT NULL,
  reason       text,
  status       text NOT NULL DEFAULT 'PENDING',
  requested_at timestamptz DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  decided_note text
);

CREATE INDEX IF NOT EXISTS approvals_status_requested_at_idx
  ON observability.approvals (status, requested_at);

-- ---------------------------------------------------------------------------
-- Decision audit log (immutable record of every APPROVE/REJECT decision)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.approval_decisions (
  decision_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id  uuid NOT NULL REFERENCES observability.approvals(approval_id),
  status       text NOT NULL,
  decided_at   timestamptz DEFAULT now(),
  decided_by   text NOT NULL,
  note         text
);
