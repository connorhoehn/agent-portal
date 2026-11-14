-- The meeting assistant's state and transcript (docs/meeting-assistant-design.md, decisions 8 and 9).
--
-- One `meeting_assistants` row per call the assistant (Nova) was invited to, written by
-- middleware/src/lib/meeting-assistant/ (store-sql.ts) behind /api/calls/:callId/assistant.
-- One `meeting_transcript_lines` row per caption stored while it was listening. Words are
-- stored, audio never is: there is no audio column and no place to put one. Lines are
-- deleted once they are older than MEETING_TRANSCRIPT_RETENTION_DAYS (30 by default) by the
-- sweep in lib/meeting-assistant/retention.ts; the readable window is the attendees' only.
--
-- Additive and idempotent. Both tables carry `tenant`, so they are tenant tables:
-- schema/row_level_security.sql lists them and the middleware's providers/db-tenant.ts
-- pattern names them.

CREATE TABLE IF NOT EXISTS meeting_assistants (
  call_id            TEXT        PRIMARY KEY CHECK (call_id ~ '^[a-zA-Z0-9:_-]{1,256}$'),
  tenant             TEXT        NOT NULL,
  lobby              TEXT        NOT NULL,
  initiative_id      TEXT,
  state              TEXT        NOT NULL CHECK (state IN ('invited', 'listening', 'paused', 'left')),
  invited_by         TEXT        NOT NULL,
  invited_at         TIMESTAMPTZ NOT NULL,
  paused_by          TEXT,
  left_at            TIMESTAMPTZ,
  left_by            TEXT,
  -- Who has acknowledged the transcription notice; who held a seat; who was seated at the invite.
  acked              JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acked) = 'array'),
  attendees          JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attendees) = 'array'),
  present_at_invite  JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(present_at_invite) = 'array'),
  requests           INTEGER     NOT NULL DEFAULT 0 CHECK (requests >= 0),
  lines_stored       INTEGER     NOT NULL DEFAULT 0 CHECK (lines_stored >= 0),
  next_seq           INTEGER     NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  -- Requests the detector found, waiting for the brain.
  pending_requests   JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pending_requests) = 'array'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_assistants_tenant_idx ON meeting_assistants (tenant, invited_at DESC);

CREATE TABLE IF NOT EXISTS meeting_transcript_lines (
  call_id         TEXT        NOT NULL REFERENCES meeting_assistants (call_id) ON DELETE CASCADE,
  seq             INTEGER     NOT NULL CHECK (seq >= 1),
  tenant          TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  participant_id  TEXT        NOT NULL DEFAULT '',
  speaker_name    TEXT        NOT NULL DEFAULT '',
  text            TEXT        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  at              TIMESTAMPTZ NOT NULL,
  caption_id      TEXT        NOT NULL,
  -- Offsets within the call session, and everyone heard when speech overlapped.
  start_ms        INTEGER,
  end_ms          INTEGER,
  speakers        JSONB       CHECK (speakers IS NULL OR jsonb_typeof(speakers) = 'array'),
  PRIMARY KEY (call_id, seq),
  -- The same caption delivered twice is stored once.
  UNIQUE (call_id, caption_id)
);
CREATE INDEX IF NOT EXISTS meeting_transcript_lines_at_idx ON meeting_transcript_lines (at);

-- Actions Nova offered in the call chat (package 2). One row per card; only the asker decides it
-- (the route checks), and a decision moves `waiting` once. Running the tool is package 4.
CREATE TABLE IF NOT EXISTS meeting_assistant_actions (
  call_id      TEXT        NOT NULL REFERENCES meeting_assistants (call_id) ON DELETE CASCADE,
  action_id    TEXT        NOT NULL CHECK (action_id ~ '^[a-zA-Z0-9:_-]{1,128}$'),
  tenant       TEXT        NOT NULL,
  message_id   TEXT        NOT NULL,
  asked_by     TEXT        NOT NULL,
  tool_name    TEXT        NOT NULL,
  args_digest  TEXT        NOT NULL DEFAULT '',
  status       TEXT        NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'confirmed', 'declined', 'expired', 'done', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL,
  decided_by   TEXT,
  decided_at   TIMESTAMPTZ,
  result_text  TEXT,
  PRIMARY KEY (call_id, action_id)
);

-- Package 4a: the live session's bookkeeping, unattributed lines, and the turns that carry a tool call to the asker's browser.
-- `session` holds refused calls, listening seconds, the ceiling, the spend hold ids and the usage to settle (types.ts AssistantSession).
ALTER TABLE meeting_assistants ADD COLUMN IF NOT EXISTS session JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(session) = 'object');
-- A piece nobody's audio was voiced for is stored with no person; the name lock never counts it.
ALTER TABLE meeting_transcript_lines ALTER COLUMN user_id DROP NOT NULL;

-- One row per tool call the assistant turned into work for the person who asked. Reads run in that person's browser at once
-- (status pending); a write waits behind its card in the chat (pending) and runs after the asker confirms (running).
-- Reads expire after 90 seconds, writes after 10 minutes.
CREATE TABLE IF NOT EXISTS meeting_assistant_turns (
  call_id     TEXT        NOT NULL REFERENCES meeting_assistants (call_id) ON DELETE CASCADE,
  turn_id     TEXT        NOT NULL CHECK (turn_id ~ '^[a-zA-Z0-9:_-]{1,128}$'),
  tenant      TEXT        NOT NULL,
  asked_by    TEXT        NOT NULL,
  tool_name   TEXT        NOT NULL,
  tool_args   JSONB,
  kind        TEXT        NOT NULL CHECK (kind IN ('read', 'write', 'private-read')),
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'declined', 'expired')),
  action_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (call_id, turn_id)
);
-- A browser claims a turn before running it (one claim per turn; the result must carry the claim id).
ALTER TABLE meeting_assistant_turns ADD COLUMN IF NOT EXISTS claim_id TEXT;
ALTER TABLE meeting_assistant_turns ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS meeting_assistant_turns_asker_idx ON meeting_assistant_turns (call_id, asked_by) WHERE status IN ('pending', 'running');

-- Package 5: the minutes. One row per call, written once when the assistant leaves. `deleted_at` marks a tombstone (the inviter
-- deleted the record: content gone, never written again). The same retention as transcript lines (created_at).
CREATE TABLE IF NOT EXISTS meeting_minutes (
  call_id       TEXT        PRIMARY KEY REFERENCES meeting_assistants (call_id) ON DELETE CASCADE,
  tenant        TEXT        NOT NULL,
  lobby         TEXT        NOT NULL,
  initiative_id TEXT,
  call_name     TEXT        NOT NULL DEFAULT '',
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ NOT NULL,
  invited_by    TEXT        NOT NULL,
  attendees     JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attendees) = 'array'),
  summary       TEXT        NOT NULL DEFAULT '',
  decisions     JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(decisions) = 'array'),
  action_items  JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_items) = 'array'),
  topics        JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(topics) = 'array'),
  line_count    INTEGER     NOT NULL DEFAULT 0,
  truncated     BOOLEAN     NOT NULL DEFAULT false,
  writer        TEXT        NOT NULL CHECK (writer IN ('scripted', 'openai', 'none')),
  created_at    TIMESTAMPTZ NOT NULL,
  deleted_at    TIMESTAMPTZ,
  deleted_by    TEXT
);
CREATE INDEX IF NOT EXISTS meeting_minutes_tenant_idx ON meeting_minutes (tenant, ended_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_minutes_created_idx ON meeting_minutes (created_at);

-- Package 7a: Nova speaking aloud is a per-call switch, off by default. Audio itself is never stored; this is only the flag.
ALTER TABLE meeting_assistants ADD COLUMN IF NOT EXISTS voice BOOLEAN NOT NULL DEFAULT false;
