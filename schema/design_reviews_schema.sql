-- Design reviews — the Design phase's ADR system.
--
-- One review per design question on an initiative. Agents open the thread
-- (problem restatement), iterate options, and raise `question` posts when
-- intent is ambiguous; humans answer, agents revise, and the loop runs until
-- a `decision` post exists and the stewards sign off. An approved review is
-- an ADR: logged, synced into the knowledge base (a documents row), and a
-- GATED INPUT — a review that depends_on it cannot be approved while it is
-- not approved itself (enforced in middleware providers/design-reviews.ts,
-- decideApproval).
--
-- The middleware currently serves this domain mock-first; these tables are
-- the Aurora contract the provider's SQL path lands on.

CREATE TABLE IF NOT EXISTS design_reviews (
  id             TEXT PRIMARY KEY DEFAULT ('des-' || gen_random_uuid()::TEXT),
  org_project_id TEXT NOT NULL REFERENCES projects(id),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ideating'
                 CHECK (status IN ('ideating','awaiting_input','proposed','approved','rejected','superseded')),
  -- Approved review ids this one is gated by.
  depends_on     TEXT[] NOT NULL DEFAULT '{}',
  -- Agent-maintained executive summary, kept current as the thread evolves.
  summary        TEXT NOT NULL DEFAULT '',
  -- Blast radius: [{org_project_id, org_project_name, impact}] — every
  -- initiative this decision touches beyond its home.
  affected       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Set when the approved ADR has been written to the KB (documents row id).
  kb_document_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS design_reviews_project_idx ON design_reviews (org_project_id, status);

CREATE TABLE IF NOT EXISTS design_posts (
  id           TEXT PRIMARY KEY DEFAULT ('dp-' || gen_random_uuid()::TEXT),
  review_id    TEXT NOT NULL REFERENCES design_reviews(id) ON DELETE CASCADE,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('agent','human')),
  author_name  TEXT NOT NULL,
  kind         TEXT NOT NULL
               CHECK (kind IN ('problem','analysis','option','question','answer','artifact','revision','decision')),
  body         TEXT NOT NULL,
  -- question posts: the answer post id once resolved; open while NULL.
  resolved_by  TEXT,
  -- artifact posts: {name, type, url} — browser screenshots, diagrams, docs.
  artifact     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS design_posts_review_idx ON design_posts (review_id, created_at);

CREATE TABLE IF NOT EXISTS design_signoffs (
  review_id   TEXT NOT NULL REFERENCES design_reviews(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id),
  role        TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One standing sign-off per person; a new decision replaces the old.
  PRIMARY KEY (review_id, person_id)
);
