// The access tenant's cluster statements (lane E; schema/access_schema.sql).
//
// providers/access.ts serves the tenant from registered fixtures under
// MOCK_AURORA and answers 503 elsewhere until the user decides to apply the
// additive schema (docs/access-tenant-goal.md §E). These are the statements the
// cluster half runs when it lands — the same compare-and-set claims the mock
// makes in one tick (casRequest, casStep, the decide transition), written so
// PostgreSQL itself decides every race. Each one is proven against native
// PostgreSQL 16 over the unmodified schema file, concurrent callers included,
// in lib/access/__tests__/access-postgres.test.ts (opt-in, a dedicated
// container; it does NOT establish Aurora, IAM or Data API binding).
//
// Parameters use the RDS Data API's `:name` binding. Timestamps travel as ISO
// strings and are CAST here; an absent optional value is bound as NULL.
//
// What each statement guarantees:
//   INSERT_REQUEST_SQL     one open grant request per (beneficiary, item): two
//                          racing submits insert once (access_requests_one_open_idx);
//                          the loser gets no row back and answers 409.
//   DECIDE_STEP_SQL        a step is decided once, never by a party (A5): the
//                          claim's WHERE re-checks the step's status and both
//                          parties after the row lock, so of N concurrent
//                          approvers exactly one moves the request; the
//                          access_step_decision_guard trigger refuses any other
//                          writer that tries either.
//   PROVISION_CLAIM_SQL /  approved → provisioned → active, each a claim, so a
//   PROVISION_ACTIVATE_SQL racing provisioner does nothing twice; GRANT_ROLE_SQL
//                          writes the one role (providers/identity.ts grantRole;
//                          no writer deletes and re-inserts a user's set).
//   END_GRANT_SQL          active|provisioned → expired|revoked once, with its
//                          event; the expiry sweep and a person's revoke race safely.
//   WARN_EXPIRY_SQL        the 24-hour warning claimed once per request.
//   ESCALATE_STEP_SQL      a current step escalates once per level.
//   INSERT_DELEGATION_SQL / END_DELEGATION_SQL  a delegation and its event; ending once.

/**
 * The catalog as the route reads it: the seeded rows plus one DERIVED
 * `envelope:<project>` row per initiative (lib/access/items.ts envelopeItem —
 * the SQL below must say what that function says). providers/access.ts
 * `listCatalog` is the mock twin.
 */
export const LIST_CATALOG_SQL = `
SELECT id, kind, tenant, role, project_id, title, description, sensitive, default_duration, steward_rule
  FROM access_catalog_items
UNION ALL
SELECT 'envelope:' || p.id, 'sprint-envelope', 'orgiq', NULL, p.id,
       'Sprint envelope on ' || p.name,
       'A spend envelope on ' || p.name || ': dispatch agent work against it inside the active sprint. Provisioned as a budget grant by the initiative''s budget holder.',
       FALSE, 'standing', 'budget-holder'
  FROM projects p
 WHERE NOT EXISTS (SELECT 1 FROM access_catalog_items c WHERE c.id = 'envelope:' || p.id)
 ORDER BY 1`;

/** One open grant request per beneficiary and item; RETURNING id is empty for the loser of a race.
 *  `requested_usd` / `forecast` (JSON text, CAST here) are a sprint envelope's; NULL for every other kind. */
export const INSERT_REQUEST_SQL = `
INSERT INTO access_requests (id, kind, requester_id, beneficiary_id, item_id, justification, duration, requested_usd, forecast, status, sod_verdict, submitted_at)
VALUES (:id, 'grant', :requester_id, :beneficiary_id, :item_id, :justification, :duration, :requested_usd, CAST(:forecast AS JSONB), 'submitted', :sod_verdict, CAST(:at AS TIMESTAMPTZ))
ON CONFLICT DO NOTHING
RETURNING id`;

/** A planned step (step 1 current with its escalation clock started, the rest waiting). */
export const INSERT_STEP_SQL = `
INSERT INTO access_request_steps (request_id, step, kind, status, current_since)
VALUES (:request_id, :step, :kind, :status, CAST(:current_since AS TIMESTAMPTZ))`;

/** One audit event about a request. */
export const INSERT_EVENT_SQL = `
INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason)
VALUES (:id, :request_id, CAST(:at AS TIMESTAMPTZ), :actor_id, :kind, :before_status, :after_status, :reason)`;

/**
 * Decide the step awaiting a decision, in one statement: claim the step (only
 * while it is current / info-requested, the request open, and the actor is
 * neither requester nor beneficiary), then — only if the claim won — make the
 * next step current, skip the rest on a rejection, move the request and append
 * the events. The route computes the outcome with lib/access/status.ts
 * `decide` and binds it: `:step_status`, `:next_step` (0 = none),
 * `:skip_rest` ('true'/'false'), `:request_status`, `:final` ('true' stamps
 * decided_at), `:on_behalf_of` (a delegate's delegator, else NULL), and up to
 * two events (`:e2_id` '' for none). Returns the claimed step; no row = the
 * claim lost (decided already, not current, or a party) — a 409/403 upstream.
 */
export const DECIDE_STEP_SQL = `
WITH prior AS (
  SELECT status FROM access_requests WHERE id = :request_id
), claimed AS (
  UPDATE access_request_steps s
     SET status = :step_status, decided_by = :actor, decided_at = CAST(:at AS TIMESTAMPTZ), comment = :comment, delegated_from = :on_behalf_of
    FROM access_requests r
   WHERE s.request_id = :request_id AND s.step = :step AND r.id = s.request_id
     AND s.status IN ('current', 'info-requested')
     AND r.status IN ('draft', 'submitted', 'pending')
     AND r.requester_id <> :actor AND r.beneficiary_id <> :actor
  RETURNING s.request_id, s.step
), advanced AS (
  UPDATE access_request_steps n
     SET status = 'current', current_since = CAST(:at AS TIMESTAMPTZ)
    FROM claimed c
   WHERE n.request_id = c.request_id AND n.step = :next_step AND n.status = 'waiting'
  RETURNING n.step
), skipped AS (
  UPDATE access_request_steps k
     SET status = 'skipped'
    FROM claimed c
   WHERE :skip_rest = 'true' AND k.request_id = c.request_id AND k.step > c.step AND k.status = 'waiting'
  RETURNING k.step
), moved AS (
  UPDATE access_requests r
     SET status = :request_status,
         decided_at = CASE WHEN :final = 'true' THEN CAST(:at AS TIMESTAMPTZ) ELSE r.decided_at END
    FROM claimed c
   WHERE r.id = c.request_id
  RETURNING r.id, r.status
), events AS (
  INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason)
  SELECT v.id, m.id, CAST(:at AS TIMESTAMPTZ), :actor, v.kind, (SELECT status FROM prior), m.status, v.reason
    FROM moved m
    CROSS JOIN (VALUES (:e1_id, :e1_kind, :e1_reason), (:e2_id, :e2_kind, NULL)) AS v (id, kind, reason)
   WHERE v.id <> ''
  RETURNING id
)
SELECT c.request_id, c.step, (SELECT count(*) FROM events) AS events FROM claimed c`;

/** Claim an approved request for provisioning; no row = someone else claimed it (or it is not approved). */
export const PROVISION_CLAIM_SQL = `
UPDATE access_requests
   SET status = 'provisioned', provisioned_at = CAST(:at AS TIMESTAMPTZ), expires_at = CAST(:expires_at AS TIMESTAMPTZ)
 WHERE id = :id AND status = 'approved' AND kind = 'grant'
RETURNING id`;

/**
 * The grant itself (one (user, tenant, role) row, idempotent) and its inverse.
 * They belong to the grant store, so they live beside it: providers/identity.ts
 * `grantRole` / `revokeRole` / `setGrants` run exactly these strings.
 */
export { GRANT_ROLE_SQL, REVOKE_ROLE_SQL } from '../identity-grants-sql.js';

/** Retire every cookie the beneficiary holds (decision A3) — the epoch bump revocation and expiry make. */
export const BUMP_EPOCH_SQL = `
UPDATE app_users SET session_epoch = COALESCE(session_epoch, 0) + 1 WHERE id = :user_id
RETURNING session_epoch`;

/** provisioned → active with its `provisioned` event, once. */
export const PROVISION_ACTIVATE_SQL = `
WITH done AS (
  UPDATE access_requests SET status = 'active' WHERE id = :id AND status = 'provisioned'
  RETURNING id
)
INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason)
SELECT :event_id, d.id, CAST(:at AS TIMESTAMPTZ), NULL, 'provisioned', 'approved', 'active', :reason FROM done d
RETURNING request_id`;

/** Grants due to expire now (the sweep's read; END_GRANT_SQL decides each). */
export const EXPIRY_DUE_SQL = `
SELECT id, beneficiary_id, item_id FROM access_requests
 WHERE kind = 'grant' AND status IN ('active', 'provisioned') AND expires_at IS NOT NULL AND expires_at <= CAST(:now AS TIMESTAMPTZ)
 ORDER BY expires_at, id`;

/** active|provisioned → :outcome ('expired' | 'revoked') with its event, once. No row = already ended. */
export const END_GRANT_SQL = `
WITH prior AS (
  SELECT status FROM access_requests WHERE id = :id
), done AS (
  UPDATE access_requests SET status = :outcome, revoked_at = CAST(:at AS TIMESTAMPTZ)
   WHERE id = :id AND status IN ('active', 'provisioned')
  RETURNING id
)
INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason)
SELECT :event_id, d.id, CAST(:at AS TIMESTAMPTZ), :actor_id, :outcome, (SELECT status FROM prior), :outcome, :reason FROM done d
RETURNING request_id`;

/** Claim the 24-hour expiry warning once per request. */
export const WARN_EXPIRY_SQL = `
UPDATE access_requests SET expiry_warned_at = CAST(:at AS TIMESTAMPTZ)
 WHERE id = :id AND status = 'active' AND expiry_warned_at IS NULL
RETURNING id`;

/** Escalate a current step from :from_level to :to_level once, with its `escalated` event. No row = lost the claim. */
export const ESCALATE_STEP_SQL = `
WITH claimed AS (
  UPDATE access_request_steps s
     SET escalation_level = :to_level, escalated_at = CAST(:at AS TIMESTAMPTZ)
    FROM access_requests r
   WHERE s.request_id = :request_id AND s.step = :step AND r.id = s.request_id
     AND s.status = 'current' AND s.escalation_level = :from_level
     AND r.status IN ('draft', 'submitted', 'pending')
  RETURNING s.request_id, r.status
)
INSERT INTO access_events (id, request_id, at, actor_id, kind, before_status, after_status, reason)
SELECT :event_id, c.request_id, CAST(:at AS TIMESTAMPTZ), NULL, 'escalated', c.status, c.status, :reason FROM claimed c
RETURNING request_id`;

/** A delegation and its `delegated` event. */
export const INSERT_DELEGATION_SQL = `
WITH d AS (
  INSERT INTO access_delegations (id, delegator_id, delegate_id, starts_at, ends_at, reason, created_at)
  VALUES (:id, :delegator_id, :delegate_id, CAST(:starts_at AS TIMESTAMPTZ), CAST(:ends_at AS TIMESTAMPTZ), :reason, CAST(:at AS TIMESTAMPTZ))
  RETURNING id, delegator_id
)
INSERT INTO access_events (id, delegation_id, at, actor_id, kind, reason)
SELECT :event_id, d.id, CAST(:at AS TIMESTAMPTZ), d.delegator_id, 'delegated', :event_reason FROM d
RETURNING delegation_id`;

/** End a delegation early, once, with its `delegation-ended` event. No row = already ended. */
export const END_DELEGATION_SQL = `
WITH d AS (
  UPDATE access_delegations SET ended_at = CAST(:at AS TIMESTAMPTZ), ended_by = :actor_id
   WHERE id = :id AND ended_at IS NULL AND ends_at > CAST(:at AS TIMESTAMPTZ)
  RETURNING id
)
INSERT INTO access_events (id, delegation_id, at, actor_id, kind, reason)
SELECT :event_id, d.id, CAST(:at AS TIMESTAMPTZ), :actor_id, 'delegation-ended', :reason FROM d
RETURNING delegation_id`;

/** Delegations in force at :now (the live directory's `activeDelegations`). */
export const ACTIVE_DELEGATIONS_SQL = `
SELECT id, delegator_id, delegate_id FROM access_delegations
 WHERE ended_at IS NULL AND starts_at <= CAST(:now AS TIMESTAMPTZ) AND ends_at > CAST(:now AS TIMESTAMPTZ)
 ORDER BY id`;
