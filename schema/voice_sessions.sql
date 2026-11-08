-- The voice navigator's sessions and tool calls (docs/voice-navigator-spec.md §7, §9).
--
-- One `voice_sessions` row per session minted by POST /api/voice/sessions
-- (middleware/src/routes/voice.ts), closed by the dock's close or by the
-- reaper (lib/voice/reaper.ts) past max_seconds + grace, and one
-- `voice_tool_calls` row per tool call the dock reports. Stored nowhere:
-- audio, transcripts, the model's words, the user's words, or a tool's
-- arguments. A tool-call row keeps the sha256 of the arguments only.
--
-- The money is the ledger's: one spend_entries row per session (source
-- 'voice_session', source_id = id) settles the spend_holds row named by
-- hold_id. The 'voice_session' source value lives in the named source checks
-- of spend_holds_schema.sql and spend_ledger_schema.sql, and the 'openai'
-- provider in spend_ledger_provider_schema.sql.
--
-- Additive and idempotent. Both tables carry `tenant`, so they are tenant
-- tables: schema/row_level_security.sql lists them and the middleware's
-- providers/db-tenant.ts pattern names them. FKs spend_holds, so it loads
-- after spend_holds_schema.sql.

CREATE TABLE IF NOT EXISTS voice_sessions (
  id                   TEXT        PRIMARY KEY CHECK (id ~ '^vs_[0-9a-f-]{36}$'),
  user_sub             TEXT        NOT NULL,
  tenant               TEXT        NOT NULL,
  hold_id              UUID        REFERENCES spend_holds (id) ON DELETE SET NULL,
  -- The provider's own session id (the hang-up target). Never shown to the browser.
  provider_session_id  TEXT,
  model                TEXT,
  voice                TEXT,
  mock                 BOOLEAN     NOT NULL DEFAULT false,
  -- The ceiling at mint (VOICE_SESSION_MAX_MINUTES x 60) and the rate the
  -- session is priced at, so a config change never re-prices a live session.
  max_seconds          INTEGER     NOT NULL CHECK (max_seconds > 0),
  usd_per_minute       NUMERIC(10,4) NOT NULL CHECK (usd_per_minute >= 0),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at             TIMESTAMPTZ,
  -- Null = unknown (the reaper's case), never coerced to 0.
  seconds              INTEGER     CHECK (seconds IS NULL OR seconds >= 0),
  cost_usd             NUMERIC(10,4),
  cost_basis           TEXT        CHECK (cost_basis IS NULL OR cost_basis IN ('reported', 'estimated', 'unknown')),
  stop_reason          TEXT        CHECK (stop_reason IS NULL OR stop_reason IN ('closed', 'dropped', 'cutoff', 'tenant-switch', 'reaped', 'mint-failed')),
  tool_calls           INTEGER     NOT NULL DEFAULT 0 CHECK (tool_calls >= 0)
);

-- What the provider itself reported over the sideband (G12,
-- docs/voice-navigator-gaps.md §2.4): the middleware that minted the session
-- attaches to wss://api.openai.com/v1/live/sessions/{id}/attach and records
-- the cumulative session.usage.updated / session.closed usage.seconds and the
-- sums of every nested response.completed.response.usage. Null = the sideband
-- never delivered that figure (no socket, or the minting replica died); the
-- close and the reaper then fall back to the dock's figures (`estimated`).
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS provider_seconds       INTEGER CHECK (provider_seconds IS NULL OR provider_seconds >= 0);
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS provider_tokens_in     BIGINT  CHECK (provider_tokens_in IS NULL OR provider_tokens_in >= 0);
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS provider_tokens_out    BIGINT  CHECK (provider_tokens_out IS NULL OR provider_tokens_out >= 0);
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS provider_tokens_cached BIGINT  CHECK (provider_tokens_cached IS NULL OR provider_tokens_cached >= 0);

CREATE INDEX IF NOT EXISTS voice_sessions_open_idx ON voice_sessions (started_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_sessions_user_idx ON voice_sessions (user_sub, started_at DESC);

CREATE TABLE IF NOT EXISTS voice_tool_calls (
  id            UUID        PRIMARY KEY,
  session_id    TEXT        NOT NULL REFERENCES voice_sessions (id) ON DELETE CASCADE,
  -- The session's tenant, copied so the row-level policy needs no join.
  tenant        TEXT        NOT NULL,
  tool          TEXT        NOT NULL,
  args_sha256   TEXT        CHECK (args_sha256 IS NULL OR args_sha256 ~ '^[0-9a-f]{64}$'),
  outcome       TEXT        NOT NULL CHECK (outcome IN ('done', 'refused', 'failed', 'cancelled')),
  confirmed_by  TEXT        CHECK (confirmed_by IS NULL OR confirmed_by IN ('voice', 'click')),
  duration_ms   INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS voice_tool_calls_session_idx ON voice_tool_calls (session_id, at);
