-- The `access` tenant's model (docs/access-tenant-design.md §3,
-- docs/access-tenant-goal.md §"The model").
--
-- ADDITIVE and NOT YET APPLIED TO AURORA: the user decides when (lane E).
-- Registered in schema/load_schema.py and schema/apply_all_seed.py so a
-- rebuilt cluster carries it; every statement is IF NOT EXISTS / ON CONFLICT,
-- so a re-run is a no-op. The offline mirror is middleware/src/mock/access-*.ts,
-- and the parity harness (mock/core/parity/entities.ts) compares the seed rows
-- below with those fixtures id by id.
--
-- The grant store is NOT here (decision A2): an approved request is provisioned
-- into user_tenant_roles / project_contributions through the existing writers.
-- Approvers are NOT stored on a request either (decision A4): a step records
-- who DID decide it; who MAY decide it is resolved live at decision time from
-- people.manager_id, the tenant steward roles and the initiative owner.

-- ── people.manager_id ───────────────────────────────────────────────────────
-- Additive, nullable. The manager step of a request resolves to the
-- beneficiary's person's manager through this column.
ALTER TABLE people ADD COLUMN IF NOT EXISTS manager_id TEXT REFERENCES people(id);

-- The access cast's people rows (docs/access-tenant-goal.md §Cast). Priya
-- manages Omar, Omar manages Rhea, so a request from Rhea has a manager step
-- Omar decides without any fixture-specific code.
INSERT INTO people (id, name, email, title, team) VALUES
  ('p-priya', 'Priya Venkataraman', 'priya.venkataraman@orgiq.example', 'Identity Governance Lead', 'Security'),
  ('p-omar',  'Omar Haddad',        'omar.haddad@orgiq.example',        'Engineering Manager',      'Security'),
  ('p-rhea',  'Rhea Castellanos',   'rhea.castellanos@orgiq.example',   'Security Engineer',        'Security')
ON CONFLICT (id) DO NOTHING;

UPDATE people SET manager_id = 'p-priya' WHERE id = 'p-omar' AND manager_id IS NULL;
UPDATE people SET manager_id = 'p-omar'  WHERE id = 'p-rhea' AND manager_id IS NULL;

-- identity_schema.sql may have loaded before these people rows existed (its
-- person_id subqueries then resolved to NULL); link the cast now.
UPDATE app_users SET person_id = 'p-rhea'  WHERE id = 'u-rhea'  AND person_id IS NULL;
UPDATE app_users SET person_id = 'p-omar'  WHERE id = 'u-omar'  AND person_id IS NULL;
UPDATE app_users SET person_id = 'p-priya' WHERE id = 'u-priya' AND person_id IS NULL;

-- ── access_catalog_items ─────────────────────────────────────────────────────
-- What can be requested. `admin` cross-tenant grants are deliberately absent
-- (design: "provisioned by hand").
CREATE TABLE IF NOT EXISTS access_catalog_items (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('tenant-role', 'initiative-membership')),
  tenant           TEXT NOT NULL,
  role             TEXT,
  project_id       TEXT,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  sensitive        BOOLEAN NOT NULL DEFAULT FALSE,
  default_duration TEXT NOT NULL CHECK (default_duration IN ('8h', '24h', '7d', '30d', 'standing')),
  steward_rule     TEXT NOT NULL CHECK (steward_rule IN ('tenant-steward', 'initiative-owner')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'tenant-role' AND role IS NOT NULL) OR (kind = 'initiative-membership' AND project_id IS NOT NULL))
);

-- ── access_requests ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id                  TEXT PRIMARY KEY,
  requester_id        TEXT NOT NULL,
  beneficiary_id      TEXT NOT NULL,
  item_id             TEXT NOT NULL REFERENCES access_catalog_items(id),
  justification       TEXT NOT NULL,
  duration            TEXT NOT NULL CHECK (duration IN ('8h', '24h', '7d', '30d', 'standing')),
  status              TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'pending', 'approved', 'provisioned',
                        'active', 'expired', 'revoked', 'rejected', 'withdrawn')),
  sod_verdict         TEXT NOT NULL DEFAULT 'clear' CHECK (sod_verdict IN ('clear', 'warn', 'block')),
  sod_overridden_by   TEXT,
  sod_override_reason TEXT,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at          TIMESTAMPTZ,
  provisioned_at      TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS access_requests_beneficiary_idx ON access_requests (beneficiary_id);
CREATE INDEX IF NOT EXISTS access_requests_status_idx ON access_requests (status);
CREATE INDEX IF NOT EXISTS access_requests_expires_idx ON access_requests (expires_at) WHERE expires_at IS NOT NULL;

-- ── access_request_steps ─────────────────────────────────────────────────────
-- The chain computed at submit. `decided_by` records who did decide; the set
-- who MAY decide is never stored (A4).
CREATE TABLE IF NOT EXISTS access_request_steps (
  request_id  TEXT NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  step        INTEGER NOT NULL CHECK (step >= 1),
  kind        TEXT NOT NULL CHECK (kind IN ('manager', 'steward', 'access-admin')),
  status      TEXT NOT NULL CHECK (status IN ('waiting', 'current', 'approved', 'rejected', 'info-requested', 'skipped')),
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  comment     TEXT,
  PRIMARY KEY (request_id, step)
);

-- ── access_policies ──────────────────────────────────────────────────────────
-- Separation-of-duties rules: two (tenant, role) pairs not to be held together.
CREATE TABLE IF NOT EXISTS access_policies (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  left_tenant  TEXT NOT NULL,
  left_role    TEXT NOT NULL,
  right_tenant TEXT NOT NULL,
  right_role   TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('warn', 'block')),
  reason       TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT
);

-- ── access_events ────────────────────────────────────────────────────────────
-- The audit trail: append-only, one row per transition.
CREATE TABLE IF NOT EXISTS access_events (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id      TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('submitted', 'step-approved', 'step-rejected', 'info-requested', 'withdrawn',
                  'approved', 'provisioned', 'expired', 'revoked', 'sod-override', 'policy-updated')),
  before_status TEXT,
  after_status  TEXT,
  reason        TEXT
);
CREATE INDEX IF NOT EXISTS access_events_request_idx ON access_events (request_id, at);

-- ── access_reviews / access_review_items (phase A2) ──────────────────────────
CREATE TABLE IF NOT EXISTS access_reviews (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_by  TEXT,
  opened_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closes_at  TIMESTAMPTZ,
  closed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS access_review_items (
  review_id   TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  tenant      TEXT NOT NULL,
  role        TEXT NOT NULL,
  decision    TEXT CHECK (decision IN ('keep', 'revoke')),
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  comment     TEXT,
  PRIMARY KEY (review_id, user_id, tenant, role)
);

-- ── Seed: catalog (8 items) ──────────────────────────────────────────────────
INSERT INTO access_catalog_items (id, kind, tenant, role, project_id, title, description, sensitive, default_duration, steward_rule) VALUES
  ('role:orgiq:sme', 'tenant-role', 'orgiq', 'sme', NULL, 'SME in Work',
     'Dispatch agent work against a granted sprint envelope on the initiatives you contribute to.', FALSE, '30d', 'tenant-steward'),
  ('role:orgiq:org-leader', 'tenant-role', 'orgiq', 'org-leader', NULL, 'Org leader in Work',
     'Full org visibility, leaderboards, budget allocation and transaction approval over $10k.', TRUE, '7d', 'tenant-steward'),
  ('role:assessment:assessor', 'tenant-role', 'assessment', 'assessor', NULL, 'Assessor in Assessment',
     'Score dimensions and manage submission intake.', FALSE, '30d', 'tenant-steward'),
  ('role:assessment:lead-assessor', 'tenant-role', 'assessment', 'lead-assessor', NULL, 'Lead assessor in Assessment',
     'Approve N/A exceptions and publish team reports.', TRUE, '7d', 'tenant-steward'),
  ('role:social:moderator', 'tenant-role', 'social', 'moderator', NULL, 'Moderator in Social',
     'Manage channels, teams and recordings.', FALSE, '30d', 'tenant-steward'),
  ('role:pipelines:operator', 'tenant-role', 'pipelines', 'operator', NULL, 'Operator in Pipelines',
     'Run pipelines, approve steps waiting on a person and cancel runs.', FALSE, '7d', 'tenant-steward'),
  ('initiative:p-auth-migration', 'initiative-membership', 'orgiq', NULL, 'p-auth-migration', 'Member of Auth Migration',
     'Contribute to the Auth Migration initiative: its board, discussion and dispatched work.', FALSE, '30d', 'initiative-owner'),
  ('initiative:p-observability', 'initiative-membership', 'orgiq', NULL, 'p-observability', 'Member of Observability Platform',
     'Contribute to the Observability Platform initiative: its board, discussion and dispatched work.', FALSE, '30d', 'initiative-owner')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: separation-of-duties policies (4) ──────────────────────────────────
INSERT INTO access_policies (id, title, left_tenant, left_role, right_tenant, right_role, severity, reason) VALUES
  ('sod-001', 'Spend and allocate', 'orgiq', 'sme', 'orgiq', 'org-leader', 'block',
     'An SME spends a sprint envelope; an org leader grants it. One person holding both approves their own spending.'),
  ('sod-002', 'Write and approve a pipeline', 'pipelines', 'author', 'pipelines', 'operator', 'block',
     'An author writes a definition; an operator approves its steps. Holding both approves your own definition.'),
  ('sod-003', 'Score and except', 'assessment', 'assessor', 'assessment', 'lead-assessor', 'warn',
     'A lead assessor approves N/A exceptions on scores an assessor entered; review who scored before approving.'),
  ('sod-004', 'Moderate and run pipelines', 'social', 'moderator', 'pipelines', 'operator', 'warn',
     'Recordings a moderator retains can carry run approvals an operator decided; keep the two visible.')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: requests (6, in six statuses), their steps and events ──────────────
-- req-0001 submitted: Rhea asks for SME in Work; Omar (her manager) is current.
-- req-0002 pending:   Rhea asks for Auth Migration; Omar approved, the steward is current.
-- req-0003 approved:  Omar asked for Operator in Pipelines; Priya (his manager) and the steward approved.
-- req-0004 active:    Nora's standing SME grant, provisioned (she holds it in user_tenant_roles).
-- req-0005 rejected:  Rhea asked for Org leader; Omar rejected at the manager step.
-- req-0006 withdrawn: Rhea asked for Moderator in Social and withdrew it.
INSERT INTO access_requests (id, requester_id, beneficiary_id, item_id, justification, duration, status, sod_verdict, submitted_at, decided_at, provisioned_at, expires_at, revoked_at) VALUES
  ('req-0001', 'u-rhea', 'u-rhea', 'role:orgiq:sme',
     'I am picking up the SSO cutover stories and need to dispatch agent work against the sprint envelope.', '30d', 'submitted', 'clear',
     NOW() - INTERVAL '3 hours', NULL, NULL, NULL, NULL),
  ('req-0002', 'u-rhea', 'u-rhea', 'initiative:p-auth-migration',
     'Pairing with Vera on the SAML shim retirement for the next two sprints.', '30d', 'pending', 'clear',
     NOW() - INTERVAL '2 days', NULL, NULL, NULL, NULL),
  ('req-0003', 'u-omar', 'u-omar', 'role:pipelines:operator',
     'Covering the on-call approvals rotation for the ingest pipelines this week.', '7d', 'approved', 'clear',
     NOW() - INTERVAL '4 days', NOW() - INTERVAL '3 days', NULL, NULL, NULL),
  ('req-0004', 'u-nora', 'u-nora', 'role:orgiq:sme',
     'Standing SME on Observability and Auth Migration; owns the dispatched maintenance work.', 'standing', 'active', 'clear',
     NOW() - INTERVAL '40 days', NOW() - INTERVAL '39 days', NOW() - INTERVAL '39 days', NULL, NULL),
  ('req-0005', 'u-rhea', 'u-rhea', 'role:orgiq:org-leader',
     'Would like to see the leaderboards while preparing the quarterly security review.', '7d', 'rejected', 'clear',
     NOW() - INTERVAL '6 days', NOW() - INTERVAL '5 days', NULL, NULL, NULL),
  ('req-0006', 'u-rhea', 'u-rhea', 'role:social:moderator',
     'Planned to curate the security-announcements channel during the rollout.', '30d', 'withdrawn', 'clear',
     NOW() - INTERVAL '10 days', NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO access_request_steps (request_id, step, kind, status, decided_by, decided_at, comment) VALUES
  ('req-0001', 1, 'manager', 'current', NULL, NULL, NULL),
  ('req-0001', 2, 'steward', 'waiting', NULL, NULL, NULL),
  ('req-0002', 1, 'manager', 'approved', 'u-omar', NOW() - INTERVAL '1 day', 'Agreed with Vera; two sprints.'),
  ('req-0002', 2, 'steward', 'current', NULL, NULL, NULL),
  ('req-0003', 1, 'manager', 'approved', 'u-priya', NOW() - INTERVAL '4 days', 'Covers the rotation.'),
  ('req-0003', 2, 'steward', 'approved', 'u-priya', NOW() - INTERVAL '3 days', 'Seven days, then it lapses.'),
  ('req-0004', 1, 'steward', 'approved', 'u-priya', NOW() - INTERVAL '39 days', 'Owns the maintenance bots.'),
  ('req-0005', 1, 'manager', 'rejected', 'u-omar', NOW() - INTERVAL '5 days', 'The review does not need leaderboard access; I will share the export.'),
  ('req-0005', 2, 'steward', 'skipped', NULL, NULL, NULL),
  ('req-0005', 3, 'access-admin', 'skipped', NULL, NULL, NULL),
  ('req-0006', 1, 'manager', 'skipped', NULL, NULL, NULL),
  ('req-0006', 2, 'steward', 'skipped', NULL, NULL, NULL)
ON CONFLICT (request_id, step) DO NOTHING;

INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason) VALUES
  ('evt-0001', 'req-0001', NOW() - INTERVAL '3 hours', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0002', 'req-0002', NOW() - INTERVAL '2 days', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0003', 'req-0002', NOW() - INTERVAL '1 day', 'u-omar', 'step-approved', 'submitted', 'pending', 'Agreed with Vera; two sprints.'),
  ('evt-0004', 'req-0003', NOW() - INTERVAL '4 days', 'u-omar', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0005', 'req-0003', NOW() - INTERVAL '4 days', 'u-priya', 'step-approved', 'submitted', 'pending', 'Covers the rotation.'),
  ('evt-0006', 'req-0003', NOW() - INTERVAL '3 days', 'u-priya', 'step-approved', 'pending', 'approved', 'Seven days, then it lapses.'),
  ('evt-0007', 'req-0003', NOW() - INTERVAL '3 days', 'u-priya', 'approved', 'pending', 'approved', NULL),
  ('evt-0008', 'req-0004', NOW() - INTERVAL '40 days', 'u-nora', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0009', 'req-0004', NOW() - INTERVAL '39 days', 'u-priya', 'step-approved', 'submitted', 'approved', 'Owns the maintenance bots.'),
  ('evt-0010', 'req-0004', NOW() - INTERVAL '39 days', 'u-priya', 'approved', 'submitted', 'approved', NULL),
  ('evt-0011', 'req-0004', NOW() - INTERVAL '39 days', NULL, 'provisioned', 'approved', 'active', NULL),
  ('evt-0012', 'req-0005', NOW() - INTERVAL '6 days', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0013', 'req-0005', NOW() - INTERVAL '5 days', 'u-omar', 'step-rejected', 'submitted', 'rejected', 'The review does not need leaderboard access; I will share the export.'),
  ('evt-0014', 'req-0006', NOW() - INTERVAL '10 days', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0015', 'req-0006', NOW() - INTERVAL '9 days', 'u-rhea', 'withdrawn', 'submitted', 'withdrawn', 'The channel moved to the platform team.')
ON CONFLICT (id) DO NOTHING;
