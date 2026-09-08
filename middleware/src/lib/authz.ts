// Verified Permissions enforcement middleware. One IsAuthorized call per
// (tenant, role, action) is cached for 60 seconds — Cedar policies aren't
// expected to change per-request, and AVP charges per evaluation.
//
// The principal sent to Cedar is the *user* (entityId = session.sub) carrying
// role + tenant as attributes; policies condition on the attributes
// (`principal.role == "..." && principal.tenant == "..."`), so decisions are
// cacheable across users holding the same (tenant, role) pair.

import type { Request, Response, NextFunction } from 'express';
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
  type AttributeValue,
  type EntityItem,
} from '@aws-sdk/client-verifiedpermissions';
import { config } from '../config.js';
import { eventFromSession, logAuthz } from './audit.js';
import {
  demoSession, demoFallbackAllowed, ssoAvailable, ADMIN_ROLE, DEFAULT_ROLE,
  type Tenant, type Role, type Session,
} from './session.js';

const NAMESPACE = 'OrgIQ';
const RESOURCE_ID = 'app';

/**
 * Every Cedar action the UI gates on — the union of all requireAction() /
 * readForRolesElseAction() / isAllowed() action ids across the middleware
 * routes. GET /api/session/capabilities evaluates each of these for the
 * current session so the portal can hide/disable controls the server would
 * 403 anyway. Keep in sync when adding a new requireAction() guard.
 */
export const CAPABILITY_ACTIONS = [
  'Search',              // agents.ts — agent invoke
  'ViewOrgChart',        // index.ts — /api/graph
  'ViewLeaderboard',     // index.ts — /api/scores
  'ViewObservability',   // index.ts — observability surfaces
  'ViewIdentityAdmin',   // identity.ts — admin identity read
  'ManageUsers',         // identity.ts — tenants/users/grants
  'EditPolicy',          // identity.ts — Cedar policy CRUD
  'EditSchema',          // identity.ts — Cedar schema
  'EditGuardrail',       // capabilities.ts — guardrail config
  'ManageDevbox',        // index.ts, work.ts, bots.ts, capabilities.ts
  'ManageBots',          // bots.ts — create/edit standing missions (sme, program-owner, leaders)
  'DispatchAgentRun',    // projects.ts, bots.ts
  'ManageIngest',        // index.ts — ingest + connections
  'ManageKB',            // index.ts kb-registry, knowledge-base.ts
  'ManageCanary',        // canary.ts, canary-library.ts, evaluations.ts, prompt-history.ts
  'LabelFeedback',       // quality.ts
  'ApproveTransaction',  // approvals.ts
  'Masquerade',          // session.ts
  'ManageBudgets',       // budgets.ts — initiative allocations (program management)
  'ManageSprints',       // sprints.ts — create sprints, move work between them (org-leader + sme)
  'EnterEnvironment',    // environments.ts — reach a deployed environment from a devbox
  'ManageEnvironments',  // environments.ts — describe/edit/remove an environment
  'ConnectLocalCompute', // local-compute.ts — pair/manage your own machine as a fleet node
  // Assessment tenant — routes/assessment.ts. Missing from this list, every
  // assessment control hid for every role: the portal's can() read undefined
  // for actions the server never evaluated. See docs/assessment-tenant.md.
  'ViewAssessment',         // reads: teams, dimensions, runs, knowledge, rollup
  'ScoreAssessment',        // intake, scores apply, feedback resolve/dismiss
  'ApproveException',       // N/A exception approve/deny — lead-assessor and up
  'PublishReport',          // publish a team/program report — lead-assessor and up
  'ManageSubmissions',      // Forms envelope parse/commit/clear
  'RunAssessmentAgent',     // POST /runs — launch/stop the scorer and drafter
  'ManageKnowledge',        // knowledge doc PUT/restore
  'ManageAssessmentConfig', // motions + target level — program-lead only
] as const;

export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];

const client = new VerifiedPermissionsClient({ region: config.region });

const cache = new Map<string, { decision: 'ALLOW' | 'DENY'; expiresAt: number }>();
const TTL_MS = 60_000;

/** The slice of a session that authorization decisions depend on. */
export interface PrincipalRef {
  sub: string;
  role: string;
  tenant: string;
}

/** Optional resource attributes — used by Cedar `when { resource.amount > N }` policies. */
export interface ResourceAttrs {
  amount?: number;
  /** Environment tier ordering: dev(0) → staging(10) → prod(30). */
  envRank?: number;
  envName?: string;
  envKind?: string;
  envStatus?: string;
  [k: string]: unknown;
}

/**
 * "May this principal reach THIS environment?" — the environments domain's
 * central authorization question, and a design decision worth stating.
 *
 * Cedar here authorizes a SINGLETON: every decision targets
 * OrgIQ::Application::"app", and the principal carries only role + tenant. The
 * two honest ways to express a per-environment answer were:
 *
 *   (a) a real, non-singleton OrgIQ::Environment entity type, one Cedar entity
 *       per row, with policies naming environments (or groups of them); or
 *   (b) the attribute escape hatch already proven by ApproveTransaction, which
 *       conditions on `resource.amount > 10000` — pass the environment's
 *       *properties* on the singleton resource and let policies condition on
 *       them.
 *
 * (b), because the real rule is about environment PROPERTIES, not identities:
 * an SME may reach environments; a member may reach none; nobody reaches a
 * retired one. None of those sentences names an environment. Modelling one
 * entity per row would let Cedar express what no policy actually says, and
 * would mean the entity store has to be kept in sync with a table that humans
 * edit — a second source of truth, and a stale one is a security bug.
 *
 * THE TRADEOFF, stated plainly: this cannot express a per-environment ACL.
 * "Priya may reach the auth prod cluster but not the LLM one" is unsayable
 * here — the grain of the decision is (role, tier, kind, status), not (person,
 * environment). The day that grain is genuinely needed, (a) is the move:
 * declare OrgIQ::Environment in seeds/schema.json, project each row into the
 * entity list, and change `evaluate()` to send the environment as the resource
 * instead of the singleton. Until then (a) buys nothing and costs a sync loop.
 *
 * A second, quieter reason (b) fits: the AVP decision cache keys on
 * tenant|role|action|attrs. These attributes are low-cardinality (a handful of
 * tiers and kinds), so caching still works. Passing the environment ID would
 * make every row its own cache entry and every check a fresh billed
 * evaluation — which is also the honest signal that per-ID rules belong in (a),
 * not smuggled through here.
 *
 * Note this decides REACHABILITY only. Actually getting in still requires
 * assuming `access_role_arn`, and IAM decides what that role may do. Two
 * independent gates; neither is sufficient alone.
 */
export function environmentAttrs(env: {
  name: string; kind: string; rank: number; status: string;
}): ResourceAttrs {
  return { envName: env.name, envKind: env.kind, envRank: env.rank, envStatus: env.status };
}

function attrsToAvp(attrs: ResourceAttrs): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = { long: Math.trunc(v) } as AttributeValue;
    } else if (typeof v === 'string') {
      out[k] = { string: v } as AttributeValue;
    } else if (typeof v === 'boolean') {
      out[k] = { boolean: v } as AttributeValue;
    }
  }
  return out;
}

/**
 * The local, no-policy-store decision: does this role hold this action in the
 * seed Cedar policies?
 *
 * Loaded LAZILY and cached. role-registry.ts reads `import.meta.url` at module
 * scope, which ts-jest's CommonJS transform cannot handle — every existing test
 * that touches it mocks it out. A static import here would drag that breakage
 * into every test that imports authz.ts, so the import happens only on the
 * branch that needs it, which no AVP-configured run and no production run
 * reaches.
 *
 * FIDELITY LIMIT, stated rather than hidden: this is a flat role -> action
 * matrix, so Cedar's ATTRIBUTE CONDITIONS are not applied. `ApproveTransaction`
 * gated on `resource.amount > 10000`, or a grant-scoped `DispatchAgentRun`,
 * resolve here on the role grant alone. So local dev can still be more
 * permissive than production for conditioned actions — but only for those,
 * instead of for everything.
 *
 * If the seeds cannot be read we return false (deny) rather than falling back
 * to allow: a dev environment that silently reverts to "everyone is an admin"
 * is exactly the state this replaced, and a visible denial is easier to
 * diagnose than an invisible grant.
 */
let seedMatrix: Map<string, ReadonlySet<string>> | null = null;
let seedMatrixFailed = false;

async function seedPolicyDecision(role: string, action: string): Promise<boolean> {
  if (!seedMatrix && !seedMatrixFailed) {
    try {
      const { roleRegistry } = await import('./role-registry.js');
      seedMatrix = new Map(roleRegistry().map((r) => [r.id, new Set(r.capabilities)]));
    } catch (err) {
      seedMatrixFailed = true;
      // Named explicitly — a bare "failed" with no cause is how the platform's
      // tracing shutdown bug hid itself for weeks.
      console.error(
        '[authz] no policy store AND the Cedar seeds could not be read; denying every action.',
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
    }
  }
  const granted = seedMatrix?.get(role);
  // `*` is how role-registry records an UNCONSTRAINED permit (admin.cedar has
  // no `action in [...]` list). A plain `has(action)` never matched it, so in
  // open mode admin was denied on every plain requireAction gate while
  // passing the read gates that special-case the role by name — an
  // inconsistency the assessment tenant exposed, since all of its gates are
  // plain. The wildcard means what it says.
  return granted != null && (granted.has(action) || granted.has('*'));
}

async function evaluate(principal: PrincipalRef, action: string, resourceAttrs?: ResourceAttrs): Promise<'ALLOW' | 'DENY'> {
  if (!config.auth.policyStoreId) {
    // No policy store wired up. In production that is a misconfiguration, and
    // silently disabling every tenant/role boundary is the worst failure mode.
    if (process.env['NODE_ENV'] === 'production') return 'DENY';
    // Locally, fall back to the SEED POLICIES rather than blanket ALLOW.
    //
    // Blanket ALLOW made every role look like an admin: GET
    // /api/session/capabilities returned all 24 actions true for `member`, the
    // portal rendered every control for everyone, and /api/identity/users
    // answered 200 to a rank-and-file member. Nothing was insecure — production
    // denies — but it made every permission-dependent journey IMPOSSIBLE to
    // exercise or demo locally, and it made the masquerade menu meaningless
    // because every role rendered the same UI.
    //
    // role-registry.ts derives the role -> action matrix from the same .cedar
    // seed files AVP is loaded from, so this is the real policy rather than a
    // second hand-maintained list that could drift from it.
    return (await seedPolicyDecision(principal.role, action)) ? 'ALLOW' : 'DENY';
  }
  // Attribute-bearing checks (e.g. ApproveTransaction when amount > N) cache
  // under a key that includes the attributes (sorted, so ordering can't split
  // entries) — a plain key would collide across different resources, but
  // skipping the cache entirely made every capabilities probe re-hit AVP.
  const hasAttrs = !!resourceAttrs && Object.keys(resourceAttrs).length > 0;
  const attrsKey = hasAttrs
    ? '|' + JSON.stringify(Object.fromEntries(Object.entries(resourceAttrs).sort(([a], [b]) => a.localeCompare(b))))
    : '';
  const key = `${principal.tenant}|${principal.role}|${action}${attrsKey}`;
  {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.decision;
  }

  const entityList: EntityItem[] = [{
    identifier: { entityType: `${NAMESPACE}::User`, entityId: principal.sub },
    attributes: {
      role: { string: principal.role } as AttributeValue,
      tenant: { string: principal.tenant } as AttributeValue,
    },
    parents: [],
  }];
  if (hasAttrs) {
    entityList.push({
      identifier: { entityType: `${NAMESPACE}::Application`, entityId: RESOURCE_ID },
      attributes: attrsToAvp(resourceAttrs!),
      parents: [],
    });
  }

  const out = await client.send(new IsAuthorizedCommand({
    policyStoreId: config.auth.policyStoreId,
    principal: { entityType: `${NAMESPACE}::User`, entityId: principal.sub },
    action: { actionType: `${NAMESPACE}::Action`, actionId: action },
    resource: { entityType: `${NAMESPACE}::Application`, entityId: RESOURCE_ID },
    entities: { entityList },
  }));
  const decision = out.decision === 'ALLOW' ? 'ALLOW' : 'DENY';
  cache.set(key, { decision, expiresAt: Date.now() + TTL_MS });
  return decision;
}

/** The caller's session, or the demo fallback while it's still allowed (no
 * real IdP configured + demo mode). Null means the request is anonymous and a
 * real login exists — guards must 401 with ssoRequired so the client routes
 * through Cognito instead of silently demoting to demo-user. */
export function resolveSession(req: Request): Session | null {
  return req.session ?? (demoFallbackAllowed() ? demoSession() : null);
}

function denyUnauthenticated(req: Request, res: Response, action: string): void {
  logAuthz({
    decision: 'DENY', action, sub: 'anonymous', role: '-',
    path: req.path, reason: 'no session',
  });
  // ssoRequired only when an IdP actually exists — pointing a client at a
  // sign-in flow that isn't wired up is worse than a plain 401.
  res.status(401).json({ error: 'Unauthenticated', ssoRequired: ssoAvailable() });
}

/**
 * Requires a SESSION, not a capability — the floor beneath every Cedar gate.
 *
 * Some surfaces are deliberately readable by every role (the work queue's
 * overview, the agent fleet, session history). "Every role" was implemented as
 * no guard at all, which is not the same thing: with no guard the handler never
 * inspects the session, so an anonymous caller reads it too. In dev the demo
 * fallback disguises that; in production, with SSO on and the fallback off,
 * those routes served real data — conversation transcripts among them — to a
 * request carrying no cookie.
 *
 * Use this wherever the intent is "any signed-in user may look". Use
 * requireAction where a specific authority is needed.
 */
export function requireSession(label = 'Read') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!resolveSession(req)) { denyUnauthenticated(req, res, label); return; }
    next();
  };
}

/**
 * Returns a middleware that requires Cedar permission for `action`.
 * Action ids match the Cedar schema (Search, ViewSalary, EditGuardrail, ...).
 */
/**
 * Pass when the session holds ANY of the actions. For a router whose
 * routes are owned by different capabilities — identity.ts serves both the
 * hr-admin read surface (ViewIdentityAdmin) and the tenant-scoped user
 * admin that program-lead holds via ManageUsers — a single router-wide
 * `requireAction` silently locks the second group out (review finding 2).
 * The audit line names the action that passed.
 */
export function requireAnyAction(actions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = resolveSession(req);
    if (!session) { denyUnauthenticated(req, res, actions[0] ?? 'unknown'); return; }
    try {
      for (const action of actions) {
        if ((await evaluate(session, action)) === 'ALLOW') {
          logAuthz(eventFromSession(session, action, 'ALLOW', { path: req.path }));
          next();
          return;
        }
      }
      logAuthz(eventFromSession(session, actions.join('|'), 'DENY', { path: req.path }));
      res.status(403).json({ error: 'Forbidden', action: actions.join('|'), role: session.role, tenant: session.tenant });
    } catch (err) {
      logAuthz(eventFromSession(session, actions.join('|'), 'DENY', { path: req.path, reason: `authz-error: ${(err as Error).message}` }));
      res.status(503).json({ error: 'authorization unavailable', action: actions.join('|') });
    }
  };
}

export function requireAction(action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = resolveSession(req);
    if (!session) { denyUnauthenticated(req, res, action); return; }
    try {
      const decision = await evaluate(session, action);
      logAuthz(eventFromSession(session, action, decision, { path: req.path }));
      if (decision === 'ALLOW') {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden', action, role: session.role, tenant: session.tenant });
    } catch (err) {
      // Authorization *infrastructure* failure (AVP unreachable, throttled,
      // IAM broken) — not a policy DENY. 503 keeps it distinguishable from
      // both a real 403 and an application 500, and tells clients to retry.
      logAuthz(eventFromSession(session, action, 'DENY', {
        path: req.path,
        reason: `authz-error: ${(err as Error).message}`,
      }));
      res.status(503).json({ error: 'authorization unavailable', action });
    }
  };
}

/**
 * Returns a middleware that requires the session's active tenant to be
 * `tenant`. This is the data-boundary guard: routes serving one tenant's
 * tables reject sessions parked in another tenant. The tenant comes from the
 * signed cookie only — never from a header or query param. The cross-tenant
 * `admin` role passes any tenant guard.
 */
export function requireTenant(tenant: Tenant) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = resolveSession(req);
    if (!session) { denyUnauthenticated(req, res, 'TenantScope'); return; }
    if (session.tenant === tenant || session.role === ADMIN_ROLE) {
      next();
      return;
    }
    logAuthz(eventFromSession(session, 'TenantScope', 'DENY', {
      path: req.path,
      reason: `route requires tenant=${tenant}`,
    }));
    res.status(403).json({ error: 'Forbidden', requiredTenant: tenant, tenant: session.tenant });
  };
}

/** Evaluate a Cedar decision outside middleware (approvals, masquerade, ...). */
export async function isAllowed(principal: PrincipalRef, action: string, resourceAttrs?: ResourceAttrs): Promise<boolean> {
  return (await evaluate(principal, action, resourceAttrs)) === 'ALLOW';
}

/**
 * Read-wide, write-narrow gating for a router.
 *
 * A GET is treated as operational visibility and allowed for any of `readRoles`
 * (plus `admin`); every mutating method falls through to `requireAction(action)`.
 * Use where a surface should be *viewable* more broadly than it is *writable* —
 * e.g. the knowledge-base registry, which org-leaders read but only hr-admins
 * change. `admin` always passes, matching requireAction's future bypass.
 */
export function readForRolesElseAction(readRoles: Role[], action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = resolveSession(req);
    const role = (session?.role ?? DEFAULT_ROLE) as Role;
    // No session → skip the read fast-path; requireAction below 401s it.
    if (req.method === 'GET' && session && (role === 'admin' || readRoles.includes(role))) {
      next();
      return;
    }
    void requireAction(action)(req, res, next);
  };
}

/**
 * Drop every cached Cedar decision. Call this from mutating routes
 * (CreatePolicy / UpdatePolicy / DeletePolicy / PutSchema) so the next
 * IsAuthorized check reflects the new state.
 */
export function clearAuthzCache(): void {
  cache.clear();
}
