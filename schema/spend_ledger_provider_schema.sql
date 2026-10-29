-- DE-33: ledger provenance. `cost_usd = 0 AND provider = 'local'` (a run served
-- on owned hardware, lib/run-cost.ts) must be distinguishable from a Bedrock
-- run that reported $0, and from a simulated one. Nullable and never
-- backfilled, matching bot_runs.model_provider's rule of not asserting a
-- provider for history. Additive; loads after spend_ledger_schema.sql.
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS provider TEXT
  CHECK (provider IN ('bedrock', 'local', 'simulated'));
