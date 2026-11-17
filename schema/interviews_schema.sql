-- The `interviews` tenant's model (docs/interviews-tenant-plan.md, "The model"; row I0.3).
--
-- DDL only, the assessment pattern: the seed story lives in the registered
-- fixtures (middleware/src/mock/interviews.ts) and the shape table
-- (middleware/src/mock/core/parity/shape-entities.ts) holds those fixtures to
-- the columns, NOT NULLs and CHECK vocabularies below. Every statement is
-- IF NOT EXISTS, so a re-run is a no-op. NOT yet applied to Aurora: with
-- INTERVIEWS_ENABLED unset a cluster leaves the tenant off.
--
-- Phase 0 holds openings (with their kit), candidates, applications,
-- interviews and scorecards. Consents, the suggestion log, the pad log, runs
-- and the deletion log are later rows (I2.3, I3.3, I4.3, I4.4, I6.3) and add
-- their own tables; the columns that will point at them are here already
-- (interviews.invite_token_hash, interviews.call_id, a scorecard's version
-- and changed_after_recap).
--
-- Candidates are records, never users (decision 3): no app_users row, no
-- grant. Every user id below is an app_users id (the recruiter, the hiring
-- manager, the interviewers); the tables carry no tenant column because all
-- of them belong to the interviews tenant (row_level_security.sql lists them).
-- The middleware's statements are middleware/src/lib/interviews/store-sql.ts.

-- ── openings ────────────────────────────────────────────────────────────────
-- The kit is one JSONB document: { rounds: [{ id, name, type, minutes }],
-- competencies: [{ id, name, lookFor, anchors: { "1".."4" } }], questions:
-- [{ id, prompt, followUps: [text], competencyId, roundType, starter?:
-- { <language>: code } }] }, each list in the order shown. It is replaced as
-- a whole by the kit editor (row I1.3), checked first by
-- middleware/src/lib/interviews/kit.ts, and read as a whole by every
-- interview of the opening. `revision` is bumped by every write; a write
-- names the revision it was made against (compare-and-set), so two editors
-- never overwrite each other unseen.
CREATE TABLE IF NOT EXISTS interview_openings (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  level              TEXT NOT NULL,
  team               TEXT NOT NULL,
  location           TEXT NOT NULL,
  hiring_manager_id  TEXT REFERENCES app_users(id),
  recruiter_id       TEXT NOT NULL REFERENCES app_users(id),
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paused', 'closed')),
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kit                JSONB NOT NULL DEFAULT '{"rounds": [], "competencies": [], "questions": []}'::jsonb,
  -- The opening's spending cap across all its interviews, in US dollars (row I0.6). NULL: none set, nothing spends.
  budget_cap_usd     NUMERIC(10, 2),
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- The cap per interview, in US dollars (row I0.6). NULL: the deployment's default.
  interview_cap_usd  NUMERIC(10, 2)
);
CREATE INDEX IF NOT EXISTS interview_openings_hiring_manager_idx ON interview_openings (hiring_manager_id);
ALTER TABLE interview_openings ADD COLUMN IF NOT EXISTS interview_cap_usd NUMERIC(10, 2);

-- ── candidates ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview_candidates (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  headline           TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT '',
  -- The uploaded résumé (row I1.6).
  resume_file_id     TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── résumés ─────────────────────────────────────────────────────────────────
-- A candidate's current résumé (row I1.6): one row per candidate, a new upload replaces it. The bytes are
-- not here: they are in the private bucket named by INTERVIEWS_RESUME_BUCKET under `storage_key`, which is
-- made from two ids and never from `file_name`. `interview_candidates.resume_file_id` points at `id`.
CREATE TABLE IF NOT EXISTS interview_resumes (
  id                 TEXT PRIMARY KEY,
  candidate_id       TEXT NOT NULL UNIQUE REFERENCES interview_candidates(id),
  file_name          TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL CHECK (size_bytes > 0),
  content_type       TEXT NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  sha256             TEXT NOT NULL,
  uploaded_by        TEXT NOT NULL,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  storage_key        TEXT NOT NULL
);

-- ── applications ────────────────────────────────────────────────────────────
-- One candidate on one opening. `history` is the stage decisions in order:
-- [{ stage, at, by, reason }], the last one being `stage`.
CREATE TABLE IF NOT EXISTS interview_applications (
  id                 TEXT PRIMARY KEY,
  candidate_id       TEXT NOT NULL REFERENCES interview_candidates(id),
  opening_id         TEXT NOT NULL REFERENCES interview_openings(id),
  stage              TEXT NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied', 'screening', 'interviewing', 'debrief', 'offer',
                       'hired', 'on-hold', 'rejected', 'withdrawn')),
  applied_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  history            JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (candidate_id, opening_id)
);
CREATE INDEX IF NOT EXISTS interview_applications_opening_idx ON interview_applications (opening_id);

-- ── interviews ──────────────────────────────────────────────────────────────
-- One round of one application. `state` follows the plan's model:
-- assigned → accepted → ready → live → ended → scored → reviewed, or declined /
-- cancelled. `ready` is accepted with a time set and questions chosen.
CREATE TABLE IF NOT EXISTS interviews (
  id                 TEXT PRIMARY KEY,
  application_id     TEXT NOT NULL REFERENCES interview_applications(id),
  round_id           TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('technical', 'behavioural')),
  lead_id            TEXT NOT NULL REFERENCES app_users(id),
  -- Up to two more panel members (decision 20).
  panel_ids          TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(panel_ids) <= 2),
  scheduled_at       TIMESTAMPTZ,
  minutes            INTEGER NOT NULL CHECK (minutes > 0),
  state              TEXT NOT NULL DEFAULT 'assigned' CHECK (state IN ('assigned', 'accepted', 'ready', 'live', 'ended',
                       'scored', 'reviewed', 'declined', 'cancelled')),
  question_ids       TEXT[] NOT NULL DEFAULT '{}',
  assigned_by        TEXT NOT NULL REFERENCES app_users(id),
  assigned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The invite link's token hash (row I2.1) and the call (row I2.2).
  invite_token_hash  TEXT,
  call_id            TEXT,
  ended_at           TIMESTAMPTZ,
  -- Row I1.4: each seat's answer. [{ userId, seat, at }] for the seats held now that accepted;
  -- [{ userId, seat, reason, at }] for every decline, kept across reassignments.
  acceptances        JSONB NOT NULL DEFAULT '[]'::jsonb,
  declines           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Bumped by every write; a write names the revision it was made against (compare-and-set).
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS interviews_application_idx ON interviews (application_id);
CREATE INDEX IF NOT EXISTS interviews_lead_idx ON interviews (lead_id);

-- ── consents (row I2.3) ─────────────────────────────────────────────────────
-- The candidate's three answers (decision 5): one current row per interview.
-- Each answer has the time it last took its present value; `notice_version` is
-- the notice the current answers were given under. `history` is append-only,
-- one entry per answer sent: [{ at, noticeVersion, recording, transcription,
-- milo, miloForcedOff }]. Milo needs the transcript, so the row cannot say yes
-- to Milo and no to the transcript. Nothing here is defaulted to yes. A write
-- names the revision it was made against (compare-and-set).
CREATE TABLE IF NOT EXISTS interview_consents (
  interview_id      TEXT PRIMARY KEY REFERENCES interviews(id),
  notice_version    TEXT NOT NULL,
  recording         BOOLEAN NOT NULL,
  recording_at      TIMESTAMPTZ NOT NULL,
  transcription     BOOLEAN NOT NULL,
  transcription_at  TIMESTAMPTZ NOT NULL,
  milo              BOOLEAN NOT NULL,
  milo_at           TIMESTAMPTZ NOT NULL,
  answered_at       TIMESTAMPTZ NOT NULL,
  changed_at        TIMESTAMPTZ NOT NULL,
  history           JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (transcription OR NOT milo)
);

-- ── scorecards ──────────────────────────────────────────────────────────────
-- One interviewer's judgement of one interview. A submitted scorecard is never
-- edited: a correction is a new version (decision 14). `ratings` is
-- [{ competencyId, rating 1..4, note }]. Milo never writes one (decision 6).
CREATE TABLE IF NOT EXISTS interview_scorecards (
  id                   TEXT PRIMARY KEY,
  interview_id         TEXT NOT NULL REFERENCES interviews(id),
  interviewer_id       TEXT NOT NULL REFERENCES app_users(id),
  ratings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation       TEXT NOT NULL CHECK (recommendation IN ('strong-no', 'no', 'yes', 'strong-yes')),
  summary              TEXT NOT NULL DEFAULT '',
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  changed_after_recap  BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (interview_id, interviewer_id, version)
);
CREATE INDEX IF NOT EXISTS interview_scorecards_interview_idx ON interview_scorecards (interview_id);

-- ── invites (row I2.1) ──────────────────────────────────────────────────────
-- The candidate's link. The token is 32 random bytes; only its SHA-256 is kept,
-- so a read of this table hands nobody a working link. One live invite per
-- interview: issuing revokes the one before in the same statement, and the
-- partial unique index holds the table to it. `expires_at` is the ceiling (30
-- days after issue); the live expiry also follows the interview's time
-- (lib/interviews/invite/rules.ts). `session_hash` names the one live guest
-- session: a new opening of the link replaces it. This table, not
-- interviews.invite_token_hash, is the truth about invites.
CREATE TABLE IF NOT EXISTS interview_invites (
  id               TEXT PRIMARY KEY,
  interview_id     TEXT NOT NULL REFERENCES interviews(id),
  token_hash       TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by        TEXT NOT NULL REFERENCES app_users(id),
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  revoked_by       TEXT REFERENCES app_users(id),
  first_opened_at  TIMESTAMPTZ,
  last_opened_at   TIMESTAMPTZ,
  open_count       INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  session_hash     TEXT,
  -- The waiting room for the current guest session (row I2.2; lib/interviews/invite/admission.ts): a new exchange resets it.
  admission_state  TEXT NOT NULL DEFAULT 'not-knocked' CHECK (admission_state IN ('not-knocked', 'waiting', 'admitted', 'turned-away')),
  knocked_at       TIMESTAMPTZ,
  admission_decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS interview_invites_interview_idx ON interview_invites (interview_id, issued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS interview_invites_one_live_idx ON interview_invites (interview_id) WHERE revoked_at IS NULL;

-- Row I2.2 (round 3): the waiting room's columns, for a database made before them.
ALTER TABLE interview_invites ADD COLUMN IF NOT EXISTS admission_state TEXT NOT NULL DEFAULT 'not-knocked' CHECK (admission_state IN ('not-knocked', 'waiting', 'admitted', 'turned-away'));
ALTER TABLE interview_invites ADD COLUMN IF NOT EXISTS knocked_at TIMESTAMPTZ;
ALTER TABLE interview_invites ADD COLUMN IF NOT EXISTS admission_decided_at TIMESTAMPTZ;

-- ── deletion log (row I6.3) ─────────────────────────────────────────────────
-- One row per deletion: a candidate's request (requested_by the recruiter who
-- asked) or a sweep whose period ran out (requested_by NULL). What was removed
-- is kinds and counts only ([{ kind, count }]); what is left is [{ kind, why,
-- retry }]. Never content, a name, an address or a file name. A row with
-- something left to retry has no done_at, and the next sweep finishes it
-- (lib/interviews/retention/service.ts).
CREATE TABLE IF NOT EXISTS interview_deletions (
  id             TEXT PRIMARY KEY,
  candidate_id   TEXT NOT NULL REFERENCES interview_candidates(id),
  interview_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason         TEXT NOT NULL CHECK (reason IN ('request', 'media-period', 'record-period')),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by   TEXT REFERENCES app_users(id),
  due_by         TIMESTAMPTZ NOT NULL,
  done_at        TIMESTAMPTZ,
  removed        JSONB NOT NULL DEFAULT '[]'::jsonb,
  left_behind    JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS interview_deletions_candidate_idx ON interview_deletions (candidate_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS interview_deletions_open_idx ON interview_deletions (requested_at) WHERE done_at IS NULL;
