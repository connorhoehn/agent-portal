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
  kind             TEXT NOT NULL CONSTRAINT access_catalog_items_kind_check CHECK (kind IN ('tenant-role', 'initiative-membership', 'capability', 'sprint-envelope')),
  tenant           TEXT NOT NULL,
  role             TEXT,
  project_id       TEXT,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  sensitive        BOOLEAN NOT NULL DEFAULT FALSE,
  default_duration TEXT NOT NULL CHECK (default_duration IN ('8h', '24h', '7d', '30d', 'standing')),
  steward_rule     TEXT NOT NULL CONSTRAINT access_catalog_items_steward_rule_check CHECK (steward_rule IN ('tenant-steward', 'initiative-owner', 'budget-owner', 'budget-holder')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- `capability` (2026-10-13): a grant entry that is not a role, held in user_tenant_roles
  -- like one (orgiq `budgets-reader`, the budgets read tier); `role` names the entry.
  -- `sprint-envelope` (2026-10-28): a budget_grants row on `project_id`. Not seeded: the route
  -- derives one `envelope:<project_id>` item per initiative (LIST_CATALOG_SQL in
  -- middleware/src/lib/access/sql.ts); a stored row with that id overrides the derived one.
  CONSTRAINT access_catalog_items_shape_check CHECK ((kind IN ('tenant-role', 'capability') AND role IS NOT NULL)
    OR (kind IN ('initiative-membership', 'sprint-envelope') AND project_id IS NOT NULL))
);
-- Clusters created before 2026-10-28 carry the three-kind list and the unnamed shape check; replace by name.
ALTER TABLE access_catalog_items DROP CONSTRAINT IF EXISTS access_catalog_items_kind_check;
ALTER TABLE access_catalog_items ADD CONSTRAINT access_catalog_items_kind_check CHECK (kind IN ('tenant-role', 'initiative-membership', 'capability', 'sprint-envelope'));
ALTER TABLE access_catalog_items DROP CONSTRAINT IF EXISTS access_catalog_items_steward_rule_check;
ALTER TABLE access_catalog_items ADD CONSTRAINT access_catalog_items_steward_rule_check CHECK (steward_rule IN ('tenant-steward', 'initiative-owner', 'budget-owner', 'budget-holder'));
ALTER TABLE access_catalog_items DROP CONSTRAINT IF EXISTS access_catalog_items_check;
ALTER TABLE access_catalog_items DROP CONSTRAINT IF EXISTS access_catalog_items_shape_check;
ALTER TABLE access_catalog_items ADD CONSTRAINT access_catalog_items_shape_check CHECK ((kind IN ('tenant-role', 'capability') AND role IS NOT NULL)
  OR (kind IN ('initiative-membership', 'sprint-envelope') AND project_id IS NOT NULL));

-- ── access_requests ──────────────────────────────────────────────────────────
-- `kind` (lane A2): a `grant` asks for access and names a catalog item; a
-- `revocation` is created pre-approved by an access review to take a standing
-- grant away and names it as `role:<tenant>:<role>` — a grant that need not be
-- requestable (orgiq `member`, …), which is why item_id carries no foreign key
-- to the catalog. The route validates a grant's item against the catalog.
CREATE TABLE IF NOT EXISTS access_requests (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL DEFAULT 'grant' CHECK (kind IN ('grant', 'revocation')),
  review_id           TEXT,
  requester_id        TEXT NOT NULL,
  beneficiary_id      TEXT NOT NULL,
  item_id             TEXT NOT NULL,
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
  revoked_at          TIMESTAMPTZ,
  -- When the 24-hour expiry warning was sent (lib/access-expiry.ts): the
  -- once-only marker the sweeper claims with a conditional UPDATE.
  expiry_warned_at    TIMESTAMPTZ,
  -- A sprint envelope's request (2026-10-28): the dollars asked for (becomes
  -- budget_grants.allocated_usd when provisioned) and the dispatch forecast it
  -- was filed against ({ workItemId, model, costUsdP25, costUsdP75 }, stored
  -- whole so the approver sees what the requester saw). NULL on every other kind.
  requested_usd       NUMERIC CHECK (requested_usd IS NULL OR requested_usd > 0),
  forecast            JSONB
);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMPTZ;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'grant';
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS review_id TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requested_usd NUMERIC CHECK (requested_usd IS NULL OR requested_usd > 0);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS forecast JSONB;
CREATE INDEX IF NOT EXISTS access_requests_beneficiary_idx ON access_requests (beneficiary_id);
CREATE INDEX IF NOT EXISTS access_requests_status_idx ON access_requests (status);
CREATE INDEX IF NOT EXISTS access_requests_expires_idx ON access_requests (expires_at) WHERE expires_at IS NOT NULL;
-- One open grant request per (beneficiary, item): the duplicate refusal the
-- submit makes (409) held by the table, so two racing submits file once.
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_open_idx ON access_requests (beneficiary_id, item_id)
  WHERE kind = 'grant' AND status IN ('draft', 'submitted', 'pending');

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
  -- Escalation timers (2026-10-14, lib/access-escalation.ts): when the step
  -- became the one awaiting a decision, how far it has escalated (0 = its own
  -- deciders, 1 = + the next tier, 2 = + the tier after) and when it last did.
  current_since    TIMESTAMPTZ,
  escalation_level INTEGER NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 2),
  escalated_at     TIMESTAMPTZ,
  -- Delegation (2026-10-14): the approver a delegate decided this step for, else NULL.
  delegated_from   TEXT,
  PRIMARY KEY (request_id, step)
);
ALTER TABLE access_request_steps ADD COLUMN IF NOT EXISTS current_since TIMESTAMPTZ;
ALTER TABLE access_request_steps ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_request_steps ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE access_request_steps ADD COLUMN IF NOT EXISTS delegated_from TEXT;
ALTER TABLE access_request_steps DROP CONSTRAINT IF EXISTS access_request_steps_escalation_level_check;
ALTER TABLE access_request_steps ADD CONSTRAINT access_request_steps_escalation_level_check CHECK (escalation_level BETWEEN 0 AND 2);
CREATE INDEX IF NOT EXISTS access_request_steps_open_idx ON access_request_steps (current_since) WHERE status IN ('current', 'info-requested');

-- Two row rules the route also enforces (decision A5), held by the table so no
-- writer can skip them: nobody decides a step of a request they submitted or
-- benefit from, and a decided step (approved / rejected / skipped) never
-- changes again. The decide statement (middleware/src/lib/access/sql.ts) checks
-- both in its WHERE; this trigger refuses any other path.
CREATE OR REPLACE FUNCTION access_step_decision_guard() RETURNS trigger AS $$
DECLARE
  req RECORD;
BEGIN
  IF OLD.status IN ('approved', 'rejected', 'skipped') AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'access: step % of % was already decided', OLD.step, OLD.request_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by IS NOT NULL AND NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    SELECT requester_id, beneficiary_id INTO req FROM access_requests WHERE id = NEW.request_id;
    IF NEW.decided_by = req.requester_id OR NEW.decided_by = req.beneficiary_id THEN
      RAISE EXCEPTION 'access: % cannot decide request % they submitted or benefit from', NEW.decided_by, NEW.request_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_step_decision_guard ON access_request_steps;
CREATE TRIGGER access_step_decision_guard BEFORE UPDATE ON access_request_steps
FOR EACH ROW EXECUTE FUNCTION access_step_decision_guard();

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
-- request_id is NULL for an event about a policy (`policy-updated`, lane A2),
-- which names policy_id instead; before/after_status then carry the severity.
CREATE TABLE IF NOT EXISTS access_events (
  id            TEXT PRIMARY KEY,
  request_id    TEXT REFERENCES access_requests(id) ON DELETE CASCADE,
  policy_id     TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id      TEXT,
  -- `delegation_id` (2026-10-14) names the delegation a `delegated` /
  -- `delegation-ended` event is about; such an event carries no request.
  delegation_id TEXT,
  kind          TEXT NOT NULL CONSTRAINT access_events_kind_check CHECK (kind IN ('submitted', 'step-approved', 'step-rejected', 'info-requested', 'withdrawn',
                  'approved', 'provisioned', 'expired', 'revoked', 'sod-override', 'sod-blocked', 'policy-updated',
                  'escalated', 'delegated', 'delegation-ended')),
  before_status TEXT,
  after_status  TEXT,
  reason        TEXT,
  CONSTRAINT access_events_target_check CHECK (request_id IS NOT NULL OR policy_id IS NOT NULL OR delegation_id IS NOT NULL)
);
ALTER TABLE access_events ADD COLUMN IF NOT EXISTS policy_id TEXT;
ALTER TABLE access_events ADD COLUMN IF NOT EXISTS delegation_id TEXT;
ALTER TABLE access_events ALTER COLUMN request_id DROP NOT NULL;
-- Clusters created before 2026-10-14 carry the old unnamed target check and the
-- old kind list; replace both by name (a re-run drops and re-adds the same rule).
ALTER TABLE access_events DROP CONSTRAINT IF EXISTS access_events_check;
ALTER TABLE access_events DROP CONSTRAINT IF EXISTS access_events_target_check;
ALTER TABLE access_events ADD CONSTRAINT access_events_target_check CHECK (request_id IS NOT NULL OR policy_id IS NOT NULL OR delegation_id IS NOT NULL);
ALTER TABLE access_events DROP CONSTRAINT IF EXISTS access_events_kind_check;
ALTER TABLE access_events ADD CONSTRAINT access_events_kind_check CHECK (kind IN ('submitted', 'step-approved', 'step-rejected', 'info-requested', 'withdrawn',
  'approved', 'provisioned', 'expired', 'revoked', 'sod-override', 'sod-blocked', 'policy-updated',
  'escalated', 'delegated', 'delegation-ended'));
CREATE INDEX IF NOT EXISTS access_events_request_idx ON access_events (request_id, at);

-- ── access_delegations (2026-10-14) ──────────────────────────────────────────
-- An approver hands their decisions to another eligible approver for a window
-- (out of office). Resolved live like every decider (A4): a delegate decides
-- the steps their delegator may decide now, never a request they are a party
-- to, never an access-admin step unless they hold access-admin themselves, and
-- never through a second delegation. `ended_at` closes it early.
CREATE TABLE IF NOT EXISTS access_delegations (
  id           TEXT PRIMARY KEY,
  delegator_id TEXT NOT NULL,
  delegate_id  TEXT NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  ended_by     TEXT,
  CONSTRAINT access_delegations_not_self CHECK (delegator_id <> delegate_id),
  CONSTRAINT access_delegations_window CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS access_delegations_delegator_idx ON access_delegations (delegator_id, ends_at);
CREATE INDEX IF NOT EXISTS access_delegations_delegate_idx ON access_delegations (delegate_id, ends_at);

-- ── access_reviews / access_review_items (phase A2) ──────────────────────────
-- A campaign certifies the standing grants (user_tenant_roles) of one tenant:
-- one item per (user, role) the directory held there when it opened.
-- `opened_by` is the campaign's owner, who decides its items with any
-- access-admin. A `revoke` creates a pre-approved revocation request
-- (access_requests.kind = 'revocation') named by `revocation_request_id`.
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
  id          TEXT NOT NULL UNIQUE,
  review_id   TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  tenant      TEXT NOT NULL,
  role        TEXT NOT NULL,
  decision    TEXT CHECK (decision IN ('keep', 'revoke')),
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  comment     TEXT,
  revocation_request_id TEXT,
  PRIMARY KEY (review_id, user_id, tenant, role)
);

-- ── Seed: catalog (9 items) ──────────────────────────────────────────────────
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
  ('capability:orgiq:budgets-read', 'capability', 'orgiq', 'budgets-reader', NULL, 'Budget visibility in Work',
     'See month-to-date spend and allocations on the Initiatives table, the detail header and budget answers. Grants no role and no budget authority.', FALSE, '30d', 'budget-owner'),
  ('initiative:p-auth-migration', 'initiative-membership', 'orgiq', NULL, 'p-auth-migration', 'Member of Auth Migration',
     'Contribute to the Auth Migration initiative: its board, discussion and dispatched work.', FALSE, '30d', 'initiative-owner'),
  ('initiative:p-observability', 'initiative-membership', 'orgiq', NULL, 'p-observability', 'Member of Observability Platform',
     'Contribute to the Observability Platform initiative: its board, discussion and dispatched work.', FALSE, '30d', 'initiative-owner')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: separation-of-duties policies (4) ──────────────────────────────────
INSERT INTO access_policies (id, title, left_tenant, left_role, right_tenant, right_role, severity, reason, updated_at, updated_by) VALUES
  ('sod-001', 'Spend and allocate', 'orgiq', 'sme', 'orgiq', 'org-leader', 'block',
     'An SME spends a sprint envelope; an org leader grants it. One person holding both approves their own spending.', NOW() - INTERVAL '1 day', 'u-priya'),
  ('sod-002', 'Write and approve a pipeline', 'pipelines', 'author', 'pipelines', 'operator', 'block',
     'An author writes a definition; an operator approves its steps. Holding both approves your own definition.', NOW() - INTERVAL '92 days', 'u-priya'),
  ('sod-003', 'Score and approve exceptions', 'assessment', 'assessor', 'assessment', 'lead-assessor', 'warn',
     'A lead assessor approves not-applicable exceptions on scores that assessors entered. Holding both means approving exceptions to your own scores.', NOW() - INTERVAL '47 days', 'u-priya'),
  ('sod-004', 'Retain recordings and approve runs', 'social', 'moderator', 'pipelines', 'operator', 'warn',
     'Moderators decide which call recordings are kept; operators approve pipeline runs that can read them. One person holding both keeps the evidence and approves its use.', NOW() - INTERVAL '21 days', 'u-priya')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: requests (7, in seven statuses), their steps and events ──────────────
-- req-0001 submitted: Rhea asks for SME in Work; Omar (her manager) is current.
-- req-0002 pending:   Rhea asks for Auth Migration; Omar approved, the steward is current.
-- req-0003 expired:   Omar asked for Operator in Pipelines for seven days; Priya (his manager) and the steward approved, it was provisioned and has lapsed.
-- req-0004 active:    Nora's standing SME grant, provisioned (she holds it in user_tenant_roles).
-- req-0005 rejected:  Rhea asked for Org leader; Omar rejected at the manager step.
-- req-0006 withdrawn: Rhea asked for Moderator in Social (Priya decided Omar's step for him, inside his delegation) and withdrew it.
-- req-0007 pending:   Eli (an SME) asks for Org leader in Work; sod-001 now blocks it; Rachel approved the steward step, Priya's is current.
INSERT INTO access_requests (id, requester_id, beneficiary_id, item_id, justification, duration, status, sod_verdict, submitted_at, decided_at, provisioned_at, expires_at, revoked_at) VALUES
  ('req-0001', 'u-rhea', 'u-rhea', 'role:orgiq:sme',
     'I am picking up the SSO cutover stories and need to dispatch agent work against the sprint envelope.', '30d', 'submitted', 'clear',
     NOW() - INTERVAL '3 hours', NULL, NULL, NULL, NULL),
  ('req-0002', 'u-rhea', 'u-rhea', 'initiative:p-auth-migration',
     'Pairing with Vera on the SAML shim retirement for the next two sprints.', '30d', 'pending', 'clear',
     NOW() - INTERVAL '2 days', NULL, NULL, NULL, NULL),
  ('req-0003', 'u-omar', 'u-omar', 'role:pipelines:operator',
     'Covering the on-call approvals rotation for the ingest pipelines for a week.', '7d', 'expired', 'clear',
     NOW() - INTERVAL '12 days', NOW() - INTERVAL '11 days', NOW() - INTERVAL '11 days', NOW() - INTERVAL '4 days', NULL),
  ('req-0004', 'u-nora', 'u-nora', 'role:orgiq:sme',
     E'I run the Auth Migration cutover rehearsals and dispatch their agent work against the sprint envelope.\n\nStanding access: the rehearsals recur every sprint, so a 30-day grant would lapse in the middle of a cutover.', 'standing', 'active', 'clear',
     NOW() - INTERVAL '40 days', NOW() - INTERVAL '39 days', NOW() - INTERVAL '39 days', NULL, NULL),
  ('req-0005', 'u-rhea', 'u-rhea', 'role:orgiq:org-leader',
     'Would like to see the leaderboards while preparing the quarterly security review.', '7d', 'rejected', 'clear',
     NOW() - INTERVAL '6 days', NOW() - INTERVAL '5 days', NULL, NULL, NULL),
  ('req-0006', 'u-rhea', 'u-rhea', 'role:social:moderator',
     'Planned to curate the security-announcements channel during the rollout.', '30d', 'withdrawn', 'clear',
     NOW() - INTERVAL '13 days', NULL, NULL, NULL, NULL),
  ('req-0007', 'u-eli', 'u-eli', 'role:orgiq:org-leader',
     'The Observability dispatches wait on the release manager for each sprint envelope. As org leader I could grant them their envelope myself.', '7d', 'pending', 'warn',
     NOW() - INTERVAL '30 hours', NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO access_request_steps (request_id, step, kind, status, decided_by, decided_at, comment, current_since) VALUES
  ('req-0001', 1, 'manager', 'current', NULL, NULL, NULL, NOW() - INTERVAL '3 hours'),
  ('req-0001', 2, 'steward', 'waiting', NULL, NULL, NULL, NULL),
  ('req-0002', 1, 'manager', 'approved', 'u-omar', NOW() - INTERVAL '1 day', 'Agreed with Vera; two sprints.', NOW() - INTERVAL '2 days'),
  ('req-0002', 2, 'steward', 'current', NULL, NULL, NULL, NOW() - INTERVAL '1 day'),
  ('req-0003', 1, 'manager', 'approved', 'u-priya', NOW() - INTERVAL '12 days', 'Covers the rotation.', NOW() - INTERVAL '12 days'),
  ('req-0003', 2, 'steward', 'approved', 'u-priya', NOW() - INTERVAL '11 days', 'Seven days, then it lapses.', NOW() - INTERVAL '12 days'),
  ('req-0004', 1, 'steward', 'approved', 'u-priya', NOW() - INTERVAL '39 days', 'Owns the maintenance bots.', NOW() - INTERVAL '40 days'),
  ('req-0005', 1, 'manager', 'rejected', 'u-omar', NOW() - INTERVAL '5 days', 'The review does not need leaderboard access; I will share the export.', NOW() - INTERVAL '6 days'),
  ('req-0005', 2, 'steward', 'skipped', NULL, NULL, NULL, NULL),
  ('req-0005', 3, 'access-admin', 'skipped', NULL, NULL, NULL, NULL),
  ('req-0006', 1, 'manager', 'approved', 'u-priya', NOW() - INTERVAL '12 days', 'Fine for the rollout window.', NOW() - INTERVAL '13 days'),
  ('req-0006', 2, 'steward', 'skipped', NULL, NULL, NULL, NULL),
  ('req-0007', 1, 'steward', 'approved', 'u-rachel', NOW() - INTERVAL '20 hours', 'Fine by me if Priya clears the policy side.', NOW() - INTERVAL '30 hours'),
  ('req-0007', 2, 'access-admin', 'current', NULL, NULL, NULL, NOW() - INTERVAL '20 hours')
ON CONFLICT (request_id, step) DO NOTHING;

INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason) VALUES
  ('evt-0001', 'req-0001', NOW() - INTERVAL '3 hours', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0002', 'req-0002', NOW() - INTERVAL '2 days', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0003', 'req-0002', NOW() - INTERVAL '1 day', 'u-omar', 'step-approved', 'submitted', 'pending', 'Agreed with Vera; two sprints.'),
  ('evt-0004', 'req-0003', NOW() - INTERVAL '12 days', 'u-omar', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0005', 'req-0003', NOW() - INTERVAL '12 days', 'u-priya', 'step-approved', 'submitted', 'pending', 'Covers the rotation.'),
  ('evt-0006', 'req-0003', NOW() - INTERVAL '11 days', 'u-priya', 'step-approved', 'pending', 'approved', 'Seven days, then it lapses.'),
  ('evt-0007', 'req-0003', NOW() - INTERVAL '11 days', 'u-priya', 'approved', 'pending', 'approved', NULL),
  ('evt-0017', 'req-0003', NOW() - INTERVAL '11 days', NULL, 'provisioned', 'approved', 'active', NULL),
  ('evt-0018', 'req-0003', NOW() - INTERVAL '4 days', NULL, 'expired', 'active', 'expired', NULL),
  ('evt-0008', 'req-0004', NOW() - INTERVAL '40 days', 'u-nora', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0009', 'req-0004', NOW() - INTERVAL '39 days', 'u-priya', 'step-approved', 'submitted', 'approved', 'Owns the maintenance bots.'),
  ('evt-0010', 'req-0004', NOW() - INTERVAL '39 days', 'u-priya', 'approved', 'submitted', 'approved', NULL),
  ('evt-0011', 'req-0004', NOW() - INTERVAL '39 days', NULL, 'provisioned', 'approved', 'active', NULL),
  ('evt-0012', 'req-0005', NOW() - INTERVAL '6 days', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0013', 'req-0005', NOW() - INTERVAL '5 days', 'u-omar', 'step-rejected', 'submitted', 'rejected', 'The review does not need leaderboard access; I will share the export.'),
  ('evt-0014', 'req-0006', NOW() - INTERVAL '13 days', 'u-rhea', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0019', 'req-0006', NOW() - INTERVAL '12 days', 'u-priya', 'step-approved', 'submitted', 'pending', 'Fine for the rollout window. — decided on behalf of Omar Haddad'),
  ('evt-0015', 'req-0006', NOW() - INTERVAL '9 days', 'u-rhea', 'withdrawn', 'pending', 'withdrawn', 'The channel moved to the platform team.'),
  ('evt-0021', 'req-0007', NOW() - INTERVAL '30 hours', 'u-eli', 'submitted', 'draft', 'submitted', NULL),
  ('evt-0022', 'req-0007', NOW() - INTERVAL '23 hours', NULL, 'sod-blocked', 'submitted', 'submitted', 'Spend and allocate: Eli Garcia already holds SME in Work.'),
  ('evt-0023', 'req-0007', NOW() - INTERVAL '20 hours', 'u-rachel', 'step-approved', 'submitted', 'pending', 'Fine by me if Priya clears the policy side.')
ON CONFLICT (id) DO NOTHING;

UPDATE access_request_steps SET delegated_from = 'u-omar' WHERE request_id = 'req-0006' AND step = 1 AND delegated_from IS NULL;

-- sod-001 was tightened from a warning to a block yesterday; req-0007 is what it now catches.
INSERT INTO access_events (id, request_id, policy_id, at, actor_id, kind, before_status, after_status, reason) VALUES
  ('evt-0020', NULL, 'sod-001', NOW() - INTERVAL '1 day', 'u-priya', 'policy-updated', 'warn', 'block',
     'Spend and allocate: tightened so that nobody grants the sprint envelope they spend.')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: one review campaign (lane A2) ─────────────────────────────────────
-- rev-0001 certifies the four standing `sme` grants in Work: two kept, two open.
INSERT INTO access_reviews (id, tenant, title, status, opened_by, opened_at, closes_at, closed_at) VALUES
  ('rev-0001', 'orgiq', 'Q4 SME certification — Work', 'open', 'u-priya', NOW() - INTERVAL '5 days', NOW() + INTERVAL '9 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO access_review_items (id, review_id, user_id, tenant, role, decision, decided_by, decided_at, comment, revocation_request_id) VALUES
  ('ri-0001', 'rev-0001', 'u-nora',  'orgiq', 'sme', 'keep', 'u-priya', NOW() - INTERVAL '2 days', 'Owns the Observability maintenance bots; still needs dispatch.', NULL),
  ('ri-0002', 'rev-0001', 'u-eli',   'orgiq', 'sme', 'keep', 'u-priya', NOW() - INTERVAL '1 day', 'Active on two initiatives this sprint.', NULL),
  ('ri-0003', 'rev-0001', 'u-layla', 'orgiq', 'sme', NULL, NULL, NULL, NULL, NULL),
  ('ri-0004', 'rev-0001', 'u-caleb', 'orgiq', 'sme', NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (review_id, user_id, tenant, role) DO NOTHING;

-- ── Seed: one delegation (2026-10-14) ───────────────────────────────────────
-- dlg-0001: Omar handed his decisions to Priya for three days of travel; it ended.
INSERT INTO access_delegations (id, delegator_id, delegate_id, starts_at, ends_at, reason, created_at, ended_at, ended_by) VALUES
  ('dlg-0001', 'u-omar', 'u-priya', NOW() - INTERVAL '14 days', NOW() - INTERVAL '11 days',
     'Travelling to the identity governance summit; Priya covers my approvals.', NOW() - INTERVAL '15 days', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO access_events (id, request_id, delegation_id, at, actor_id, kind, before_status, after_status, reason) VALUES
  ('evt-0016', NULL, 'dlg-0001', NOW() - INTERVAL '15 days', 'u-omar', 'delegated', NULL, NULL,
     'Omar Haddad → Priya Venkataraman: Travelling to the identity governance summit; Priya covers my approvals.')
ON CONFLICT (id) DO NOTHING;
