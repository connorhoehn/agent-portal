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

-- A session resumed after its predecessor dropped (G35,
-- docs/voice-navigator-gaps.md): the dock keeps the dropped session's id for
-- 60 seconds and mints with `resumeOf`; the mint links the two rows only when
-- the earlier one is the same user's, in the same tenant. Null otherwise.
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS resume_of TEXT REFERENCES voice_sessions (id) ON DELETE SET NULL;

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

-- The session's structured event log (debugging: "what happened in my last
-- voice session"), read back only by the session's owner through
-- GET /api/voice/sessions[/:id[/export]|/latest] (middleware/src/routes/voice-log.ts).
-- One row per event the middleware or the dock records, numbered by `seq`
-- within the session. `data` is structured and small: never transcript text,
-- never a tool's arguments (their sha256 only), never a key or a presigned
-- URL (middleware/src/lib/voice/session-log.ts sanitizes every row before it
-- is written). At most 500 rows per session (`voice_sessions.events` is the
-- counter the insert bumps), and rows older than 30 days are deleted by the
-- voice reaper's sweep.
ALTER TABLE voice_sessions ADD COLUMN IF NOT EXISTS events INTEGER NOT NULL DEFAULT 0 CHECK (events >= 0);

CREATE TABLE IF NOT EXISTS voice_session_events (
  id          UUID        PRIMARY KEY,
  session_id  TEXT        NOT NULL REFERENCES voice_sessions (id) ON DELETE CASCADE,
  -- The session's tenant, copied so the row-level policy needs no join.
  tenant      TEXT        NOT NULL,
  seq         INTEGER     NOT NULL CHECK (seq BETWEEN 1 AND 500),
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind        TEXT        NOT NULL CHECK (kind IN ('minted', 'started', 'delegation', 'tool-call', 'tool-result', 'refused',
                            'confirm-shown', 'confirmed', 'cancelled', 'usage', 'sideband', 'reaper', 'closed', 'error', 'client')),
  -- The writer caps the compact JSON at 2 KB; jsonb's text form adds a space
  -- after every colon and comma, so the backstop here is twice that.
  data        JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 4096),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS voice_session_events_at_idx ON voice_session_events (at);

-- A person's voice settings (G38, docs/voice-navigator-gaps.md): the voice,
-- speaking style and pace the mint applies (middleware/src/lib/voice/voices.ts,
-- GET/PUT /api/voice/settings). One row per person who saved a choice; no row
-- = the deployment's default (VOICE_VOICE, else the provider's). No tenant
-- column: a person's voice is the same in every workspace, like app_users, so
-- this is not a tenant table and row_level_security.sql does not list it; the
-- route reads and writes only the caller's own row. The values are checked
-- for shape here and against the catalogue in the middleware, so a new style
-- needs no migration. A new table reaches orgiq_app_middleware through
-- service_roles.sql's schema-wide grant: re-apply it (--roles-only) after
-- loading this file on an existing cluster.
CREATE TABLE IF NOT EXISTS voice_settings (
  user_sub    TEXT        PRIMARY KEY,
  -- A preset name (lowercase) or an allowlisted designed voice id; null = the default.
  voice       TEXT        CHECK (voice IS NULL OR voice ~ '^([a-z]{2,20}|voice_[A-Za-z0-9_-]{4,80})$'),
  style       TEXT        NOT NULL DEFAULT 'plain' CHECK (style ~ '^[a-z][a-z-]{0,39}$'),
  pace        TEXT        NOT NULL DEFAULT 'normal' CHECK (pace ~ '^[a-z][a-z-]{0,39}$'),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
