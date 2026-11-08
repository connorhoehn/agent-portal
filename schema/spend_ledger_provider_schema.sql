-- DE-33: ledger provenance. `cost_usd = 0 AND provider = 'local'` (a run served
-- on owned hardware, lib/run-cost.ts) must be distinguishable from a Bedrock
-- run that reported $0, and from a simulated one. Nullable and never
-- backfilled, matching bot_runs.model_provider's rule of not asserting a
-- provider for history. Additive; loads after spend_ledger_schema.sql.
ALTER TABLE spend_entries ADD COLUMN IF NOT EXISTS provider TEXT
  CHECK (provider IN ('bedrock', 'local', 'simulated'));

-- 'openai': a voice navigator session (docs/voice-navigator-spec.md §7). The
-- column check above is named by PostgreSQL's default (<table>_<column>_check);
-- it is replaced here as a named constraint, so adding a provider is a
-- re-apply of this file.
ALTER TABLE spend_entries DROP CONSTRAINT IF EXISTS spend_entries_provider_check;
ALTER TABLE spend_entries ADD CONSTRAINT spend_entries_provider_check
  CHECK (provider IN ('bedrock', 'local', 'simulated', 'openai'));
