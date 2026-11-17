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
  -- The spend cap per interview, in US dollars; how it is held is row I0.6.
  budget_cap_usd     NUMERIC(10, 2),
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS interview_openings_hiring_manager_idx ON interview_openings (hiring_manager_id);

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
  ended_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS interviews_application_idx ON interviews (application_id);
CREATE INDEX IF NOT EXISTS interviews_lead_idx ON interviews (lead_id);

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
