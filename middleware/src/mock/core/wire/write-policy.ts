// WHICH WRITES THE CAPTURE IS ALLOWED TO REPLAY, AND WHY.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// `capture.ts` GETs the real surface and snapshots what the server actually
// sends, so a fixture can be measured against reality instead of memory. It was
// GET-only, and `allow.ts` said so out loud: one of the three legitimate
// reasons to exempt a fixture was "the string only exists after a POST, and
// capture is GET-only". That left every POST/PUT/PATCH response shape in this
// app unpinned — the create/update/decide/dispatch responses, which are exactly
// the ones a portal page reads straight back into its own state. The
// `enterprise` / `enterprise_context` bug could ship there today and every
// check would stay green.
//
// ── Why a write capture needs a policy at all ───────────────────────────────
//
// A GET is a question. A write is an act: it can spend money, call a real cloud
// API, arm a scheduler, or delete a row the next check reads. So the capture
// does NOT replay "the write routes"; it replays the writes someone has read
// the handler for and written down a reason for. Everything else is REFUSED,
// by a stated rule, and the refusal is part of the output.
//
// That is deliberately an ALLOWLIST. A denylist would mean a route added
// tomorrow is replayed tomorrow, by a harness that has never seen its handler,
// against whatever it happens to reach — and the failure mode of getting that
// wrong is not a red test, it is a bill or a wiped table. An allowlist's
// failure mode is a gap, and a gap is printed.
//
// ── What "safe to replay" means ─────────────────────────────────────────────
//
// A route may be replayed only when ALL of these hold, with the handler read:
//
//   1. It spends nothing. No Bedrock model call, no AgentCore runtime
//      invocation, no AWS SDK call of any kind under the mock providers.
//   2. It reaches nothing real. No outbound fetch, no S3 object, no devbox
//      microVM, no browser or code-interpreter session, no SSM write.
//   3. It is not destructive. It does not remove a row.
//   4. It does not arm or fire anything. No cron registration, no agent job
//      enqueued for the fleet dispatcher, no background timer.
//   5. It leaves no SEEDED row in a state the sweep cannot put back. The sweep
//      calls `POST /api/__mock/reset` before every replay, which restores every
//      REGISTERED fixture — so a route backed by one may change whatever it
//      likes. Eight provider domains (bots, sprints, grants, work-items,
//      promotions, session-bundle, lab, prompt-evals) hold their mock rows in
//      module-level arrays that register no fixture, and reset cannot touch
//      those. Against one of those a replay may APPEND a row (harmless — the
//      shape is unchanged and nothing seeded moved) or write a value back
//      UNCHANGED (an echo-back patch: it exercises the write path and returns
//      the real response shape while leaving the row byte-identical). It may
//      not flip a seeded row's state: that is the exact damage the control
//      plane exists to prevent — "promo-aurora-cold-start is now Promoted until
//      the middleware restarts", quoted in docs/mock-floor.md. Registering the
//      fixture is what makes such a route replayable.
//   6. Its body can be synthesised from the route's OWN validation and from
//      rows the server itself hands back. Never from imagination: an invented
//      body is the same class of fiction this whole harness exists to stop.
//
// ── How a future route gets classified ──────────────────────────────────────
//
// It does not, until someone reads its handler. A new write route is
// `unclassified` — the catch-all refusal below — and shows up in the writes
// snapshot as such on the very next capture. To move it, add a `WriteSpec`
// entry with `safe` (why the six rules above hold) and `bodyFrom` (which lines
// of the handler's own validation the body comes from). Both are required, on
// the same contract as `allow.ts`: an exemption with no reason is not an
// exemption, and a replay with no stated reason is not a decision.
//
// If the body cannot be synthesised, say so with `unsynthesisable('why')` and
// the route is recorded as uncaptured WITH THAT REASON. That is not a failure.
// A visible gap beats an assumed-away one — the same rule the GET sweep's
// `skipped` list already follows.

import { type PersonaName } from './http.js';
import { type Json } from './shape.js';

// ---------------------------------------------------------------------------
// Building a body
// ---------------------------------------------------------------------------

/** Marks a route whose body cannot be built from the server + its own source. */
export interface Unsynthesisable {
  unsynthesisable: string;
}

export const unsynthesisable = (why: string): Unsynthesisable => ({ unsynthesisable: why });

export function isUnsynthesisable(v: Json | Unsynthesisable): v is Unsynthesisable {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'unsynthesisable' in v;
}

/**
 * What a body builder is allowed to draw on: the live server, and nothing else.
 * There is no `random()`, no clock and no id generator here on purpose — every
 * value in a replayed body is either a literal the handler's own source spells
 * or a row the server just handed back.
 */
export interface BodyContext {
  /** The RESOLVED request path, `:params` already filled from the server. */
  path: string;
  /** GET a path as the replay persona. `null` unless it answered 200 with JSON. */
  get(path: string): Promise<Json | null>;
  /** First value of `field` anywhere in `path`'s body — the id the route wants. */
  pick(path: string, field: string): Promise<string | null>;
  /**
   * A name that is unique within one capture run but stable in SHAPE, so a
   * created row is distinguishable without a clock or a random number (rule 3
   * of the floor forbids both in a fixture, and a snapshot diff full of churn
   * is unreadable). `wire-capture-1`, `wire-capture-2`, …
   */
  label(): string;
}

/** Every object in a body that carries all of `keys`, in document order. */
export function objectsWith(v: Json | null, ...keys: string[]): Array<Record<string, Json>> {
  const out: Array<Record<string, Json>> = [];
  const walk = (node: Json): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (keys.every((k) => k in node)) out.push(node);
    for (const child of Object.values(node)) walk(child);
  };
  if (v !== null) walk(v);
  return out;
}

/** Narrow a Json to a string, or `null` — every builder wants exactly this. */
export function str(v: Json | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface WriteSpec {
  /** `POST /api/bots` — as `routeKey()` spells it. */
  route: string;
  /** Which captured session may call it. */
  persona: PersonaName;
  /** Why replaying it satisfies the six rules above. Required. */
  safe: string;
  /** Which of the handler's own validation the body is derived from. Required. */
  bodyFrom: string;
  /** Build the request body. Omit for a route that takes none. */
  build?(ctx: BodyContext): Promise<Json | Unsynthesisable>;
  /**
   * Statuses whose body is still a real shape worth pinning. 2xx is always
   * accepted; a route whose interesting answer is a 409 (the money gates name
   * `gate` and `confirmFlag` there) says so here.
   */
  alsoAccept?: readonly number[];
}

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

export interface RefusalRule {
  /** Short id, printed in the snapshot: `destructive`. */
  id: string;
  /** The rule itself, stated so a future route can be tested against it. */
  because: string;
  /** Does this rule cover `route` (`DELETE /api/bots/:id`)? */
  applies(route: string): boolean;
  /** Optional extra clause naming what THIS route reaches. */
  detail?(route: string): string | null;
}

/**
 * A trailing `/*` matches everything below that path; a `*` anywhere else
 * matches exactly one path segment, which is how a `:id` in the middle of a
 * route is written, as in the pause/resume pair under /api/bots. No star at
 * all means an exact route key.
 */
function routeMatches(pattern: string, route: string): boolean {
  if (pattern.endsWith('/*')) return route.startsWith(pattern.slice(0, -1));
  if (!pattern.includes('*')) return pattern === route;
  const rx = pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+');
  return new RegExp(`^${rx}$`).test(route);
}

interface Family {
  /** `POST /api/capabilities/*` or an exact route key. */
  pattern: string;
  /** What this family reaches — the clause appended to the rule. */
  what: string;
}

/**
 * Rules 1/2: replaying these reaches a real cloud resource. Two kinds sit here
 * and both belong: a call that SPENDS (a model, an agent runtime, an optimizer)
 * and a call that WRITES somewhere durable (S3, SSM, a Bedrock prompt resource,
 * the RDS Data API with no `config.mock` branch above it). The second kind is
 * harmless on a laptop only because this process has no cluster and no
 * credentials — which is a property of the laptop, not of the route, and a
 * policy that leans on it is one `WIRE_BASE_URL` away from being wrong.
 */
const SPENDS: Family[] = [
  { pattern: 'POST /api/agents/*', what: 'invokes an AgentCore runtime' },
  { pattern: 'POST /api/capabilities/*', what: 'opens a real Browser or Code Interpreter session' },
  { pattern: 'PATCH /api/capabilities/*', what: 'edits a live Bedrock Guardrail' },
  { pattern: 'POST /api/devbox/*', what: 'drives a devbox microVM' },
  { pattern: 'PATCH /api/devbox/*', what: 'drives a devbox microVM' },
  { pattern: 'POST /api/agent-projects', what: 'drives a devbox microVM (lib/project-runner.ts)' },
  { pattern: 'POST /api/agent-projects/*', what: 'drives a devbox microVM (lib/project-runner.ts)' },
  { pattern: 'POST /api/drop/*', what: 'reaches the RDS Data API unguarded, then S3' },
  { pattern: 'POST /api/gateway/channels/*', what: 'signs and POSTs to the real MCP gateway when a gateway URL is set' },

  // Ingest: enumerated, not wildcarded — `POST /api/ingest/start` next door IS
  // mock-branched and is on the allowlist, so a wildcard here would be wrong.
  { pattern: 'POST /api/ingest/crawl', what: 'fetches the target URL and runs the Bedrock vision extractor' },
  { pattern: 'POST /api/ingest/survey', what: 'fetches robots.txt and every discovered page' },
  { pattern: 'POST /api/ingest/upload', what: 'writes an uploaded object to S3' },

  { pattern: 'POST /api/admin/kb-registry', what: 'INSERTs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/admin/kb-registry/upload-links', what: 'INSERTs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/admin/kb-registry/*/landing-zone/upload', what: 'writes the uploaded object to S3' },
  { pattern: 'POST /api/admin/kb-registry/*/sync', what: 'calls Bedrock Agent StartIngestionJob directly from the handler' },

  { pattern: 'POST /api/sdlc/changes/*/rereview', what: 'sends the diff to Bedrock Converse (lib/change-reviewer.ts, no mock branch)' },
  { pattern: 'POST /api/sdlc/changes/*/address', what: 'resolves the devbox runtime via ListAgentRuntimes, then invokes it' },
  { pattern: 'POST /api/sdlc/changes/*/deliver', what: 'resolves the devbox runtime via ListAgentRuntimes' },

  { pattern: 'POST /api/environments', what: 'INSERTs through the RDS Data API with no mock branch' },

  { pattern: 'POST /api/observability/harness/trace', what: 'runs Titan embedding AND the Nova judge — it spends even with Aurora down' },
  { pattern: 'POST /api/observability/harness/runs/*', what: 'invokes the fleet and the judge per case' },
  { pattern: 'POST /api/observability/harness/results/*', what: 're-judges with three Nova calls' },
  { pattern: 'POST /api/observability/harness/promote', what: 'writes through the RDS Data API with no mock branch' },
  { pattern: 'PATCH /api/observability/harness/runs/*/results', what: 'writes through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/observability/calibration/cases', what: 'INSERTs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/observability/calibration/runs', what: 'runs the Nova judge once per active case' },
  { pattern: 'POST /api/observability/quality/feedback', what: 'UPDATEs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/observability/memory/events', what: 'INSERTs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/observability/test-fixtures/*', what: 'DELETEs and UPDATEs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/observability/invocations/*', what: 'resolves and invokes a deployed agent, then embeds and judges the reply' },
  { pattern: 'PUT /api/observability/evaluations/config', what: 'writes the judge config to SSM, changing live judging for the whole fleet' },
  { pattern: 'POST /api/observability/canary/ask', what: 'streams from a Bedrock prompt ARN and fires the judge' },
  { pattern: 'POST /api/observability/canary/start', what: 'writes both subject ARNs to SSM' },
  { pattern: 'POST /api/observability/canary/library', what: 'creates a real Bedrock managed prompt' },
  { pattern: 'POST /api/observability/canary/library/*', what: 'publishes, invokes or optimizes a real Bedrock managed prompt' },
  { pattern: 'PUT /api/observability/canary/library/*', what: 'updates a real Bedrock managed prompt' },
  { pattern: 'POST /api/iq/prompts/experiments/*', what: 'upserts through the RDS Data API with no mock branch' },
  { pattern: 'PUT /api/iq/prompts/meta/*', what: 'upserts through the RDS Data API with no mock branch' },
];

/**
 * Rule 4: replaying these arms or fires something that outlives the request.
 * The seeded bots are parked deliberately (CLAUDE.md) so the scheduler cannot
 * fire against repos that do not exist yet; a capture that resumes one leaves a
 * cron armed behind it.
 */
const FIRES: Family[] = [
  { pattern: 'POST /api/bots/*/run', what: 'fires the bot now' },
  { pattern: 'POST /api/bots/*/resume', what: 'arms the bot on the live cron scheduler' },
  { pattern: 'PATCH /api/bots/*', what: 'calls registerBot, which re-arms the patched bot on the live cron scheduler' },
  { pattern: 'POST /api/bots/dispatch-work', what: 'authorizes a run and enqueues it for the fleet dispatcher' },
  { pattern: 'POST /api/work/dispatch', what: 'drives one dispatcher tick synchronously, claiming queued jobs' },
  { pattern: 'POST /api/work/jobs', what: 'enqueues an agent job the dispatcher will claim' },
  { pattern: 'POST /api/work/jobs/*/requeue', what: 'enqueues a fresh copy of the job' },
  { pattern: 'POST /api/work/findings/*/promote', what: 'enqueues an agent job the dispatcher will claim' },
  { pattern: 'POST /api/assessment/runs', what: 'starts progress timers that auto-complete the run eight seconds later' },
  { pattern: 'POST /api/assessment/knowledge/pull', what: 'schedules a deferred pull that mutates the section 1.5s later' },
  { pattern: 'POST /api/distillation/compact', what: 'schedules a three-second completion timer' },
  { pattern: 'POST /api/ingest/schedules', what: 'writes ingest-schedules.json and registers a node-cron task' },
  { pattern: 'PATCH /api/ingest/schedules/*', what: 'writes ingest-schedules.json and starts or stops a node-cron task' },
  { pattern: 'POST /api/ingest/crawl-targets', what: 'writes crawl-targets.json and may register a node-cron task' },
  { pattern: 'PATCH /api/ingest/crawl-targets/*', what: 'writes crawl-targets.json and re-registers its node-cron task' },
  { pattern: 'POST /api/ingest/crawl-targets/*/run', what: 'starts a crawl and writes crawl-targets.json' },
  { pattern: 'POST /api/ingest/survey/*/target', what: 'writes crawl-targets.json and may register a node-cron task' },
  { pattern: 'POST /api/admin/kb-registry/*/provision', what: 'starts a fire-and-forget provisioning job' },
];

/**
 * Rule 5: flips a SEEDED row held in module-level provider state that registers
 * no fixture, so `POST /api/__mock/reset` cannot put it back. The fix is not an
 * exemption — it is `defineFixture`. Until then a replay here would leave the
 * server changed for whoever looks at it next, which is precisely the damage
 * the control plane was built to end.
 */
const UNRESETTABLE: Family[] = [
  { pattern: 'POST /api/promotions/*/promote', what: 'providers/promotions.ts MOCK_CANDIDATES registers no fixture' },
  { pattern: 'POST /api/promotions/*/dismiss', what: 'providers/promotions.ts MOCK_CANDIDATES registers no fixture' },
  { pattern: 'POST /api/session-bundle/*/publish', what: 'providers/session-bundle.ts MOCK_BUNDLES registers no fixture, and publishing supersedes the live bundle' },
];

const family = (list: Family[]) => ({
  applies: (route: string): boolean => list.some((f) => routeMatches(f.pattern, route)),
  detail: (route: string): string | null => list.find((f) => routeMatches(f.pattern, route))?.what ?? null,
});

/**
 * Evaluated in order, and the FIRST match wins — refusals are checked before
 * the allowlist, so no entry can smuggle a route past a rule. `unclassified`
 * is last and matches everything left, which is what makes this an allowlist:
 * silence is a refusal, not a permission.
 */
export const REFUSAL_RULES: readonly RefusalRule[] = [
  {
    id: 'destructive',
    because:
      'DELETE removes a row. `POST /api/__mock/reset` restores REGISTERED ' +
      'fixtures only, and a good deal of mock state is a module-level array ' +
      'that registers nothing — so a delete is not reliably undoable, and an ' +
      'un-undone one silently shrinks every shape captured after it.',
    applies: (route) => route.startsWith('DELETE '),
  },
  {
    id: 'session',
    because:
      "Mutates the capture's own identity. The sweep holds one cookie per " +
      'persona; logging out, switching tenant or masquerading mid-sweep would ' +
      'either drop that cookie or bump `session_epoch` and invalidate it, and ' +
      'every later route would be captured as 401/403. The GET sweep already ' +
      'calls login/tenant itself — those two shapes are pinned there.',
    applies: (route) => /^[A-Z]+ \/api\/(session|auth)\//.test(route),
  },
  {
    id: 'control-plane',
    because:
      "The capture's own tool. `POST /api/__mock/scenario` switches the world " +
      'every later shape would be captured in, so the harness may not replay ' +
      'it. (`POST /api/__mock/reset` IS replayed — the sweep calls it between ' +
      'every write anyway, so its shape comes for free and costs nothing.)',
    applies: (route) => route === 'POST /api/__mock/scenario',
  },
  {
    id: 'spends',
    because:
      'Reaches a real cloud resource: a Bedrock model, an AgentCore runtime, ' +
      'a Browser or Code Interpreter session, a devbox microVM, S3, or an ' +
      'outbound fetch. Replaying it costs money or mutates something outside ' +
      'this process, neither of which a snapshot script gets to do.',
    ...family(SPENDS),
  },
  {
    id: 'fires',
    because:
      'Arms or fires something that outlives the capture — a cron ' +
      'registration, an agent job enqueued for the fleet dispatcher, a ' +
      'background sweep. The seeded bots are parked deliberately so the ' +
      'scheduler cannot fire against repos that do not exist yet.',
    ...family(FIRES),
  },
  {
    id: 'unresettable',
    because:
      'Flips a seeded row that lives in module-level provider state registering ' +
      'no fixture, so `POST /api/__mock/reset` cannot put it back. Appending a ' +
      'row to such a provider is fine and several specs do it; changing one the ' +
      'seed shipped is not. `defineFixture` is the fix, not an exemption.',
    ...family(UNRESETTABLE),
  },
  {
    id: 'unclassified',
    because:
      'No allowlist entry. A write is replayed only once someone has read its ' +
      'handler and written down why the six safety rules hold and where its ' +
      'body comes from. Until then this is a visible gap, which is the point.',
    applies: () => true,
  },
];

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

const ok = (body: Json) => async (): Promise<Json> => body;

/**
 * FREE TEXT IS NOT A WIRE STRING. Several bodies below carry `ctx.label()` in a
 * title, a name, a prompt, a note. Those fields are open sets — the check in
 * `shape.ts` deliberately never asserts on them — so a synthetic value there
 * invents nothing that any fixture is measured against. Every CLOSED-set field
 * (a status, a decision, a kind, a cohort, a template) is either a literal the
 * handler's own validation spells or a value read back off the server.
 */
export const WRITE_SPECS: readonly WriteSpec[] = [
  {
    route: 'POST /api/__mock/reset',
    persona: 'orgiq/admin',
    safe: 'It IS the reset. The sweep calls it between every other replay, so capturing its shape adds no mutation that was not already happening.',
    bodyFrom: 'routes/mock-control.ts — `{ fixture? }`, both optional.',
    build: ok({}),
  },

  // ── assessment ────────────────────────────────────────────────────────────
  {
    route: 'POST /api/assessment/teams',
    persona: 'assessment/admin',
    safe: 'Appends to the registered `assessment-teams` fixture; reset restores it. No AWS, no fs, no fetch, no timer.',
    bodyFrom: "routes/assessment.ts: `name` non-empty, `cohort` ∈ VALID_COHORTS ('white_glove'|'self_service'|'general').",
    build: async (ctx) => ({ name: ctx.label(), cohort: 'general' }),
  },
  {
    route: 'PATCH /api/assessment/teams/:id',
    persona: 'assessment/admin',
    safe: 'Every field is optional, so an empty patch mutates nothing at all and still returns the full team shape.',
    bodyFrom: 'routes/assessment.ts: all fields optional; `{}` passes validation.',
    build: ok({}),
  },
  {
    route: 'POST /api/assessment/teams/:id/evidence',
    persona: 'assessment/admin',
    safe: 'Appends one row to the registered `assessment-evidence-log` fixture; reset restores it. No AWS, no model.',
    bodyFrom: 'routes/assessment.ts: `excerpt` non-empty; `source_type`/`dimension_id` optional.',
    build: async (ctx) => ({ excerpt: ctx.label() }),
  },
  {
    route: 'PATCH /api/assessment/teams/:id/exceptions/:dimensionId',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-teams`/`assessment-scores` fixtures.',
    bodyFrom: "routes/assessment.ts: `status` ∈ {'approved','denied'}; the dimension must carry a 'requested' exception.",
    build: ok({ status: 'approved' }),
  },
  {
    route: 'POST /api/assessment/teams/:id/intake/text',
    persona: 'assessment/admin',
    safe: 'Appends to the registered `assessment-evidence-log` fixture. Despite the name it reaches no agent under the mock providers.',
    bodyFrom: 'routes/assessment.ts: `text` non-empty; everything else optional.',
    build: async (ctx) => ({ text: ctx.label() }),
  },
  {
    route: 'POST /api/assessment/teams/:id/intake/image',
    persona: 'assessment/admin',
    safe: 'Appends to the registered `assessment-evidence-log` fixture. No file is read or written despite the name.',
    bodyFrom: 'routes/assessment.ts: `filename` non-empty; it is a label, not an upload.',
    build: async (ctx) => ({ filename: `${ctx.label()}.png` }),
  },
  {
    route: 'POST /api/assessment/teams/:id/scores/apply',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-scores`/`assessment-teams` fixtures.',
    bodyFrom: "routes/assessment.ts + providers/assessment.ts: `scores[]`, `relevant_dimension_ids[]`; dimension ids are M.DIMENSION_IDS '1'..'17'; `confidence` ∈ {'low','moderate','high'}.",
    build: ok({
      scores: [{ dimension_id: '1', confidence: 'moderate', rationale: 'wire capture', suggested_level: 3 }],
      relevant_dimension_ids: ['1'],
    }),
  },
  {
    route: 'POST /api/assessment/teams/:id/reset-assessment',
    persona: 'assessment/admin',
    safe: 'Blanks registered score/team/feedback fixtures only, all of which reset restores. No AWS, no model, no timer.',
    bodyFrom: 'routes/assessment.ts: no body.',
  },
  {
    route: 'POST /api/assessment/feedback',
    persona: 'assessment/admin',
    safe: 'Appends one row to the registered `assessment-feedback` fixture; reset restores it. No AWS, no model.',
    bodyFrom: 'routes/assessment.ts: `question` non-empty.',
    build: async (ctx) => ({ question: `${ctx.label()}?` }),
  },
  {
    route: 'POST /api/assessment/feedback/:taskId/resolve',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-feedback` fixture; reset restores the task. No AWS, no model, no timer.',
    bodyFrom: 'routes/assessment.ts: `response` non-empty.',
    build: async (ctx) => ({ response: ctx.label() }),
  },
  {
    route: 'POST /api/assessment/feedback/:taskId/dismiss',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-feedback` fixture; reset restores the task. No AWS, no model, no timer.',
    bodyFrom: 'routes/assessment.ts: no body.',
  },
  {
    route: 'POST /api/assessment/runs/:runId/complete',
    persona: 'assessment/admin',
    safe: 'Mutates registered run/score fixtures. It is the agent callback, so it takes no session — the sweep still calls it as a persona, which is allowed.',
    bodyFrom: "routes/assessment.ts: `status` ∈ {'completed','failed'}; the run must still be 'running'.",
    build: ok({ status: 'completed' }),
  },
  {
    route: 'POST /api/assessment/runs/:runId/stop',
    persona: 'assessment/admin',
    safe: 'Mutates the registered run fixture and publishes one broker event, which every gated request already does.',
    bodyFrom: 'routes/assessment.ts: no body; the run must be `running`.',
  },
  {
    route: 'POST /api/assessment/reports/publish',
    persona: 'assessment/admin',
    safe: 'Persists nothing at all — it is a read of the rollup returned under a POST.',
    bodyFrom: 'routes/assessment.ts: body ignored entirely.',
  },
  {
    route: 'PUT /api/assessment/configuration',
    persona: 'assessment/admin',
    safe: 'Both fields optional, so an empty body leaves the single registered configuration row untouched.',
    bodyFrom: 'routes/assessment.ts: `target_level` and `motions` both optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/assessment/submissions/parse',
    persona: 'assessment/admin',
    safe: 'The legacy `rows` shape is deliberately chosen: it stages NOTHING (its staging_token is a throwaway), so unlike the `records` shape it leaves no entry in the module-level STAGED_PARSES map.',
    bodyFrom: 'routes/assessment.ts: legacy shape is `rows[]` with `team_name_raw`; the name is read off GET /api/assessment/teams.',
    build: async (ctx) => {
      const name = str(objectsWith(await ctx.get('/api/assessment/teams'), 'id', 'name')[0]?.['name']);
      if (name === null) return unsynthesisable('GET /api/assessment/teams listed no team to name a row after');
      return { rows: [{ team_name_raw: name }] };
    },
  },
  {
    route: 'POST /api/assessment/submissions/commit',
    persona: 'assessment/admin',
    safe: 'The legacy `team_id`/`envelope_ids` shape mutates the registered `assessment-submissions` fixture and consumes no staging token.',
    bodyFrom: 'routes/assessment.ts: legacy shape needs `team_id` + non-empty `envelope_ids[]`, both read off GET /api/assessment/submissions.',
    build: async (ctx) => {
      const env = objectsWith(await ctx.get('/api/assessment/submissions'), 'envelope_id', 'team_id')[0];
      const team = str(env?.['team_id']);
      const envelope = str(env?.['envelope_id']);
      if (team === null || envelope === null) return unsynthesisable('GET /api/assessment/submissions listed no envelope');
      return { team_id: team, envelope_ids: [envelope] };
    },
  },
  {
    route: 'POST /api/assessment/submissions/clear',
    persona: 'assessment/admin',
    safe: 'An empty `targets` array clears nothing, so the route is exercised and no row moves.',
    bodyFrom: 'routes/assessment.ts: `targets` is an array and may be empty.',
    build: ok({ targets: [] }),
  },
  {
    route: 'PATCH /api/assessment/submissions/:team/:envelope/links',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-submissions` fixture; reset restores the envelope. No AWS, no fetch.',
    bodyFrom: "routes/assessment.ts: `status` ∈ {'fetched','skipped'} plus one of `url`/`dimension_id`, read off the envelope itself.",
    build: async (ctx) => {
      const envelope = await ctx.get(ctx.path.replace(/\/links$/, ''));
      const url = str(objectsWith(envelope, 'url')[0]?.['url']);
      if (url === null) return unsynthesisable('the envelope carries no link to mark');
      return { status: 'fetched', url };
    },
  },
  {
    route: 'PUT /api/assessment/knowledge/doc',
    persona: 'assessment/admin',
    safe: 'An echo-back write: it saves the document’s OWN current markdown, so the registered docs fixture ends byte-identical while the real save path runs.',
    bodyFrom: 'routes/assessment.ts: `id` must resolve, `markdown` must be a string. Both are read off GET /api/assessment/knowledge/doc.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      const doc = await ctx.get(`/api/assessment/knowledge/doc?id=${encodeURIComponent(id)}`);
      const markdown = objectsWith(doc, 'markdown')[0]?.['markdown'];
      if (typeof markdown !== 'string') return unsynthesisable(`GET /api/assessment/knowledge/doc?id=${id} returned no markdown to write back`);
      return { id, markdown };
    },
  },
  {
    route: 'POST /api/assessment/knowledge/doc/restore',
    persona: 'assessment/admin',
    safe: 'Restores a document to a version the server itself lists, inside the registered docs/versions fixtures.',
    bodyFrom: 'routes/assessment.ts: `id` from the tree, `stamp` from GET /api/assessment/knowledge/doc/versions.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      const versions = await ctx.get(`/api/assessment/knowledge/doc/versions?id=${encodeURIComponent(id)}`);
      const stamp = str(objectsWith(versions, 'stamp')[0]?.['stamp']);
      if (stamp === null) return unsynthesisable(`no seeded version stamp for ${id}; only some documents carry history`);
      return { id, stamp };
    },
  },
  {
    route: 'POST /api/assessment/knowledge/doc/comment',
    persona: 'assessment/admin',
    safe: 'Under the mock providers this persists nothing; it publishes one broker event, which every gated request already does.',
    bodyFrom: 'routes/assessment.ts: `id` must resolve, `body` non-empty.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      return { id, body: ctx.label() };
    },
  },
  {
    route: 'POST /api/assessment/knowledge/presence',
    persona: 'assessment/admin',
    safe: "action 'enter' touches only the broker's 45-second presence roster and starts no timer — only 'leave' schedules the grace timer.",
    bodyFrom: "routes/assessment.ts: `doc_id`, `tab_id`, `action` ∈ PRESENCE_ACTIONS ('enter'|'heartbeat'|'leave').",
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      return { doc_id: id, tab_id: ctx.label(), action: 'enter' };
    },
  },

  // ── program: work, sprints, grants, budgets ───────────────────────────────
  {
    route: 'POST /api/graph/work-items',
    persona: 'orgiq/admin',
    safe: 'Appends to the in-memory work-item cache. Nothing seeded moves, so reset having no fixture here does not matter.',
    bodyFrom: "routes/work-items.ts: `projectId`, `type` ∈ {'epic','story','bug'}, `title`; any key outside CREATE_KEYS is a 400.",
    build: async (ctx) => {
      const projectId = await ctx.pick('/api/graph/projects', 'id');
      if (projectId === null) return unsynthesisable('GET /api/graph/projects listed no initiative');
      return { projectId, type: 'story', title: ctx.label() };
    },
  },
  {
    route: 'PATCH /api/graph/work-items/:id',
    persona: 'orgiq/admin',
    safe: "An echo-back patch: it writes the item's OWN current priority, so the row ends unchanged. work-items registers no fixture, so a real edit here would not be undoable.",
    bodyFrom: "routes/work-items.ts: PATCH_KEYS, `priority` ∈ {'critical','high','medium','low'}; the value is read off GET /api/graph/work.",
    build: async (ctx) => {
      const id = ctx.path.split('/').pop() ?? '';
      const item = objectsWith(await ctx.get('/api/graph/work'), 'id', 'priority')
        .find((w) => w['id'] === decodeURIComponent(id));
      const priority = str(item?.['priority']);
      if (priority === null) return unsynthesisable(`GET /api/graph/work does not list ${id} with a priority to echo back`);
      return { priority };
    },
  },
  {
    route: 'PATCH /api/graph/projects/:id',
    persona: 'orgiq/admin',
    safe: "`updateProjectOwner` is mock-branched and answers 503 without touching anything, so this pins the refusal shape rather than the success one.",
    bodyFrom: 'routes/projects.ts: `ownerId` is required as a key and may be null.',
    build: ok({ ownerId: null }),
  },
  {
    route: 'PATCH /api/graph/projects/:id/contributors/:personId',
    persona: 'orgiq/admin',
    safe: 'The contribution-role update is mock-branched and answers 503 without touching anything, so this pins the refusal shape.',
    bodyFrom: 'routes/projects.ts: `role` is required as a key and may be null.',
    build: ok({ role: null }),
  },
  {
    route: 'POST /api/sprints',
    persona: 'orgiq/admin',
    safe: 'Appends to the in-memory sprint list. Nothing seeded moves, so the missing fixture only means the new row outlives a reset.',
    bodyFrom: 'routes/sprints.ts: `initiativeId`, `name`, `startsOn`/`endsOn` as YYYY-MM-DD with endsOn > startsOn. The dates are copied off an existing sprint rather than minted, so no clock enters a request body.',
    build: async (ctx) => {
      const sprint = objectsWith(await ctx.get('/api/sprints'), 'id', 'orgProjectId', 'startsOn', 'endsOn')[0];
      const initiativeId = str(sprint?.['orgProjectId']);
      const startsOn = str(sprint?.['startsOn']);
      const endsOn = str(sprint?.['endsOn']);
      if (initiativeId === null || startsOn === null || endsOn === null) {
        return unsynthesisable('GET /api/sprints listed no sprint to copy an initiative and a date window from');
      }
      return { initiativeId, name: ctx.label(), startsOn, endsOn };
    },
  },
  {
    route: 'PATCH /api/sprints/:sprintId/items',
    persona: 'orgiq/admin',
    safe: 'An echo-back move: the work item chosen is one already IN this sprint, so the row ends unchanged.',
    bodyFrom: 'routes/sprints.ts: `workItemId` whose projectId equals the sprint’s orgProjectId; read off GET /api/graph/work.',
    build: async (ctx) => {
      const sprintId = decodeURIComponent(ctx.path.split('/').slice(-2)[0] ?? '');
      const item = objectsWith(await ctx.get('/api/graph/work'), 'id', 'sprintId')
        .find((w) => w['sprintId'] === sprintId);
      const workItemId = str(item?.['id']);
      if (workItemId === null) return unsynthesisable(`no work item is already in sprint ${sprintId}, so no move is an echo-back`);
      return { workItemId };
    },
  },
  {
    route: 'POST /api/grants',
    persona: 'orgiq/admin',
    safe: 'Appends to the in-memory grant overlay. Nothing seeded moves.',
    bodyFrom: 'routes/grants.ts: `initiativeId`+`sprintId` must agree (both off GET /api/sprints), `granteePersonId` off GET /api/roster, `amountUsd` a finite number >= 0 (copied off an existing grant on GET /api/budgets/grants, which spells it `allocatedUsd`).',
    build: async (ctx) => {
      const sprint = objectsWith(await ctx.get('/api/sprints'), 'id', 'orgProjectId')[0];
      const sprintId = str(sprint?.['id']);
      const initiativeId = str(sprint?.['orgProjectId']);
      const granteePersonId = await ctx.pick('/api/roster', 'personId') ?? await ctx.pick('/api/roster', 'id');
      const existing = objectsWith(await ctx.get('/api/budgets/grants'), 'id', 'allocatedUsd')[0]?.['allocatedUsd'];
      if (sprintId === null || initiativeId === null || granteePersonId === null) {
        return unsynthesisable('GET /api/sprints or GET /api/roster listed nothing to grant against');
      }
      return { initiativeId, sprintId, granteePersonId, amountUsd: typeof existing === 'number' ? existing : 0 };
    },
  },
  {
    route: 'PATCH /api/grants/:id',
    persona: 'orgiq/admin',
    safe: "An echo-back patch: it writes the grant's OWN current amount, so the row ends unchanged.",
    bodyFrom: 'routes/grants.ts: at least one of `amountUsd` (finite >= 0) / `note`; the amount is read off GET /api/budgets/grants, which spells it `allocatedUsd`.',
    build: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const grant = objectsWith(await ctx.get('/api/budgets/grants'), 'id', 'allocatedUsd').find((g) => g['id'] === id);
      const allocatedUsd = grant?.['allocatedUsd'];
      if (typeof allocatedUsd !== 'number') {
        return unsynthesisable(`GET /api/budgets/grants does not list ${id} with an amount to echo back`);
      }
      return { amountUsd: allocatedUsd };
    },
  },
  {
    route: 'PUT /api/budgets/:orgProjectId',
    persona: 'orgiq/admin',
    safe: '`upsertAllocation` is mock-branched and returns null, so the route answers 503 without writing; the allocation echoed back would be a no-op anyway.',
    bodyFrom: 'routes/budgets.ts: `allocatedUsd` a finite number >= 0, read off GET /api/budgets.',
    build: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const budget = objectsWith(await ctx.get('/api/budgets'), 'orgProjectId', 'allocatedUsd').find((b) => b['orgProjectId'] === id);
      const allocatedUsd = budget?.['allocatedUsd'];
      return { allocatedUsd: typeof allocatedUsd === 'number' ? allocatedUsd : 0 };
    },
  },

  // ── work queue ────────────────────────────────────────────────────────────
  {
    route: 'POST /api/work/sweeps/run',
    persona: 'orgiq/admin',
    safe: 'The mock branch only bumps `lastSeenAt` on the registered org-findings fixture; it enqueues nothing.',
    bodyFrom: 'routes/work.ts: `{}` runs every sweep.',
    build: ok({}),
  },
  {
    route: 'POST /api/work/findings/:id/analyze',
    persona: 'orgiq/admin',
    safe: "`analyzeDocumentLinks` short-circuits on `config.mock.aurora` with problem 'Aurora is mocked' before the S3 read and the model call.",
    bodyFrom: 'routes/work.ts: `dryRun` optional boolean; the finding must be a document one (GET /api/work/findings?sweep=stale_docs).',
    build: ok({ dryRun: true }),
  },
  {
    route: 'POST /api/work/findings/analyze-batch',
    persona: 'orgiq/admin',
    safe: '`findUnproposedDocumentFindings` returns [] under the mock providers, so no model runs and nothing is written.',
    bodyFrom: 'routes/work.ts: `limit`/`sweep` both optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/work/findings/:id/dismiss',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered org-findings fixture; reset restores it.',
    bodyFrom: 'routes/work.ts: no body.',
  },
  {
    route: 'POST /api/work/jobs/:id/review',
    persona: 'orgiq/admin',
    safe: 'Mutates one job row in the in-memory queue and enqueues nothing new; the dispatcher has nothing extra to claim.',
    bodyFrom: "routes/work.ts: `decision` ∈ {'accept','reject'}; the job must be awaiting_review.",
    build: ok({ decision: 'accept' }),
  },
  {
    route: 'POST /api/work/proposals',
    persona: 'orgiq/admin',
    safe: '`proposeGraphChange` is mock-branched and returns null, so the route answers 503 without writing.',
    bodyFrom: 'routes/work.ts: `kind` + `targetId`, neither validated at run time.',
    build: async () =>
      unsynthesisable(
        '`kind` is a ProposalKind union with no run-time validation, and no GET route enumerates its members — ' +
        'inventing one is exactly the fiction this harness exists to stop.',
      ),
  },
  {
    route: 'POST /api/work/proposals/:id/decide',
    persona: 'orgiq/admin',
    safe: '`decideProposal` is mock-branched and returns null, so the route answers 404 without writing.',
    bodyFrom: "routes/work.ts: `decision` ∈ {'approve','reject'}.",
    build: ok({ decision: 'approve' }),
  },

  // ── bots ──────────────────────────────────────────────────────────────────
  {
    route: 'POST /api/bots',
    persona: 'orgiq/admin',
    safe: "Appends a bot; `trigger: 'manual'` means the registerBot call that follows arms no cron. Nothing seeded moves.",
    bodyFrom: "routes/bots.ts: `name`, `template` ∈ TEMPLATES ('epic'|'story'|'bug'), `prompt`, `model`, `trigger` ∈ TRIGGERS ('manual'|'cron'|'pr_watch'); the model id is read off GET /api/bots.",
    build: async (ctx) => {
      const model = str(objectsWith(await ctx.get('/api/bots'), 'id', 'model')[0]?.['model']);
      if (model === null) return unsynthesisable('GET /api/bots listed no bot to copy a model id from');
      return { name: ctx.label(), template: 'epic', prompt: ctx.label(), model, trigger: 'manual' };
    },
  },
  {
    route: 'POST /api/bots/:id/pause',
    persona: 'orgiq/admin',
    safe: 'Pause only DISARMS: it sets a paused reason and unregisters the cron. Its mirror, resume, is refused because it arms one.',
    bodyFrom: 'routes/bots.ts: `reason` optional.',
    build: ok({}),
  },

  // ── sdlc, designs, connections ────────────────────────────────────────────
  {
    route: 'POST /api/sdlc/policies',
    persona: 'orgiq/admin',
    safe: 'Appends a policy row to the registered `sdlc` fixture; reset restores it. Nothing seeded moves.',
    bodyFrom: "routes/sdlc.ts: `name` non-blank, `kind` ∈ {'require_review','protected_paths','max_files','model_allowlist','max_cost'}.",
    build: async (ctx) => ({ name: ctx.label(), kind: 'require_review' }),
  },
  {
    route: 'POST /api/sdlc/changes/:id/decide',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `sdlc` fixture; reset restores the change row. No AWS, no model, no fs.',
    bodyFrom: "routes/sdlc.ts: `decision` ∈ {'approve','reject'}; the change must be in DECIDABLE.",
    build: ok({ decision: 'approve' }),
  },
  {
    route: 'POST /api/designs/:id/answer',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `design-reviews` fixture; reset restores the thread. No AWS, no model.',
    bodyFrom: 'routes/designs.ts: `questionPostId` from GET /api/designs/:id where kind is question and resolvedBy is null; `body` non-empty.',
    build: async (ctx) => {
      const thread = await ctx.get(ctx.path.replace(/\/answer$/, ''));
      const post = objectsWith(thread, 'id', 'kind', 'resolvedBy')
        .find((p) => p['kind'] === 'question' && p['resolvedBy'] === null);
      const questionPostId = str(post?.['id']);
      if (questionPostId === null) return unsynthesisable('the thread carries no open question post to answer');
      return { questionPostId, body: ctx.label() };
    },
  },
  {
    route: 'POST /api/designs/:id/signoff',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `design-reviews` fixture; reset restores the thread. Under the mock providers the KB write on approval is not taken.',
    bodyFrom: "routes/designs.ts: `decision` ∈ {'approve','reject'}.",
    build: ok({ decision: 'reject' }),
  },
  {
    route: 'POST /api/connections',
    persona: 'orgiq/admin',
    safe: 'Under MOCK_AGENTCORE the key is dropped on the floor and a row is appended to the registered `connected-sources` fixture; no AgentCore credential provider is created and api.github.com is never called.',
    bodyFrom: "routes/connections.ts: `kind` ∈ KINDS ('github'|'confluence'|'jira'), `label` and `apiKey` non-blank (the key is never stored).",
    build: async (ctx) => ({ kind: 'github', label: ctx.label(), apiKey: ctx.label() }),
  },

  // ── lab, rediscovery, distillation, library ───────────────────────────────
  {
    route: 'POST /api/lab/signals',
    persona: 'orgiq/admin',
    safe: 'Appends to (or dedupes into) the registered `org-findings` fixture.',
    bodyFrom: "routes/lab.ts: `title` non-blank; `severity` ∈ {'critical','warning','info'} is optional.",
    build: async (ctx) => ({ title: ctx.label(), severity: 'info' }),
  },
  {
    route: 'POST /api/lab/experiences',
    persona: 'orgiq/admin',
    safe: 'Appends a row to providers/lab.ts MOCK_EXPERIENCES. Nothing seeded moves, so the missing fixture only means the row outlives a reset.',
    bodyFrom: "routes/lab.ts: `title` non-blank; `kind` ∈ {'worked','failed','gotcha','decision','convention'} optional.",
    build: async (ctx) => ({ title: ctx.label(), kind: 'gotcha' }),
  },
  {
    route: 'POST /api/lab/consults',
    persona: 'orgiq/admin',
    safe: 'Appends a row to providers/lab.ts MOCK_CONSULTS. Nothing seeded moves.',
    bodyFrom: 'routes/lab.ts: `question` non-blank.',
    build: async (ctx) => ({ question: `${ctx.label()}?` }),
  },
  {
    route: 'POST /api/lab/consults/:id/answer',
    persona: 'orgiq/admin',
    safe: 'MOCK_CONSULTS ships empty, so there is no seeded consult to flip; only a row this capture created could be answered.',
    bodyFrom: 'routes/lab.ts: `answer` non-blank; the consult must still be pending.',
    build: async (ctx) => ({ answer: ctx.label() }),
  },
  {
    route: 'POST /api/rediscovery/check',
    persona: 'orgiq/admin',
    safe: 'A pure ranking over the in-memory experience corpus. It writes nothing and calls no embedding model.',
    bodyFrom: 'routes/rediscovery.ts: `problem` non-blank.',
    build: async (ctx) => ({ problem: ctx.label() }),
  },
  {
    route: 'POST /api/rediscovery/outcome',
    persona: 'orgiq/admin',
    safe: 'Appends to the in-memory OUTCOMES array. Nothing seeded moves.',
    bodyFrom: "routes/rediscovery.ts: `experienceId` off GET /api/lab/experiences, `action` ∈ {'used','dismissed'}.",
    build: async (ctx) => {
      const experienceId = await ctx.pick('/api/lab/experiences', 'id');
      if (experienceId === null) return unsynthesisable('GET /api/lab/experiences listed no experience to record an outcome against');
      return { experienceId, action: 'used' };
    },
  },
  {
    route: 'POST /api/distillation/review/:id',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `distillation` fixture; reset restores the review sample. No AWS, no model, no timer.',
    bodyFrom: "routes/distillation.ts: `verdict` ∈ {'agree','disagree'}; the sample must still be pending.",
    build: ok({ verdict: 'agree' }),
  },
  {
    route: 'POST /api/library/evals/:assetId/run',
    persona: 'orgiq/admin',
    safe: 'Scoring is a local deterministic simulation — no model. The one Aurora write is best-effort and swallowed. The run row is appended, never a seeded one changed.',
    bodyFrom: 'routes/prompt-evals.ts: `version` is any non-empty string (free text, not a wire value).',
    build: async (ctx) => ({ version: ctx.label() }),
  },
  {
    route: 'POST /api/scores/analysis',
    persona: 'orgiq/admin',
    safe: '`analyzeScores` short-circuits on `config.mock.aurora` before it reads Aurora or opens a Code Interpreter session.',
    bodyFrom: 'routes/scores.ts: body ignored.',
    build: ok({}),
  },

  // ── identity ──────────────────────────────────────────────────────────────
  {
    route: 'POST /api/identity/tenants',
    persona: 'orgiq/admin',
    safe: '`createTenant` checks `auroraConfigured()` and throws before any SQL, so nothing is provisioned; this pins the refusal shape.',
    bodyFrom: 'routes/identity.ts: `id` matching /^[a-z][a-z0-9-]{1,30}$/.',
    build: async (ctx) => ({ id: ctx.label(), displayName: ctx.label() }),
  },
  {
    route: 'POST /api/identity/users',
    persona: 'orgiq/admin',
    safe: '`createUser` checks `auroraConfigured()` and throws before any SQL.',
    bodyFrom: 'routes/identity.ts: `id` and `displayName` strings.',
    build: async (ctx) => ({ id: ctx.label(), displayName: ctx.label() }),
  },
  {
    route: 'PUT /api/identity/users/:id/grants',
    persona: 'orgiq/admin',
    safe: '`setGrants` checks `auroraConfigured()` and throws before any SQL.',
    bodyFrom: 'routes/identity.ts: `grants` keyed by tenant; both the tenant and the role name are read off GET /api/identity/roles.',
    build: async (ctx) => {
      const role = objectsWith(await ctx.get('/api/identity/roles'), 'id', 'tenant')
        .find((r) => r['tenant'] === 'orgiq');
      const id = str(role?.['id']);
      const tenant = str(role?.['tenant']);
      if (id === null || tenant === null) return unsynthesisable('GET /api/identity/roles listed no orgiq role to grant');
      return { grants: { [tenant]: [id] } };
    },
  },
  {
    route: 'PUT /api/identity/users/:id/person',
    persona: 'orgiq/admin',
    safe: 'The handler returns 503 before any SQL when Aurora is unconfigured, and `null` is the documented clear-the-link value.',
    bodyFrom: 'routes/identity.ts: `personId` is a person id or null.',
    build: ok({ personId: null }),
  },
  {
    route: 'POST /api/identity/policies/test',
    persona: 'orgiq/admin',
    safe: '`ensureStore` answers 503 before the Verified Permissions call, and the route evaluates rather than writes in any case.',
    bodyFrom: 'routes/identity.ts: `role` off GET /api/identity/roles, `action` off GET /api/session/capabilities.',
    build: async (ctx) => {
      const role = await ctx.pick('/api/identity/roles', 'id');
      const actions = objectsWith(await ctx.get('/api/session/capabilities'), 'actions')[0]?.['actions'];
      const action = actions !== null && typeof actions === 'object' && !Array.isArray(actions)
        ? Object.keys(actions)[0] : undefined;
      if (role === null || action === undefined) {
        return unsynthesisable('no role or capability name was readable off the server');
      }
      return { role, action };
    },
  },
  {
    route: 'POST /api/identity/policies',
    persona: 'orgiq/admin',
    safe: 'The handler answers 503 before the Verified Permissions write when no policy store is configured.',
    bodyFrom: 'routes/identity.ts: `statement` is Cedar policy source.',
    build: async () =>
      unsynthesisable(
        '`statement` is Cedar policy source. GET /api/identity/policies needs a live policy store, so no real ' +
        'statement is readable offline, and writing one from memory is the invention this harness forbids.',
      ),
  },
  {
    route: 'PUT /api/identity/policies/:id',
    persona: 'orgiq/admin',
    safe: 'The handler answers 503 before the Verified Permissions write when no policy store is configured.',
    bodyFrom: 'routes/identity.ts: `statement` is Cedar policy source.',
    build: async () => unsynthesisable('same as POST /api/identity/policies: no Cedar statement is readable offline.'),
  },
  {
    route: 'PUT /api/identity/schema',
    persona: 'orgiq/admin',
    safe: 'The handler answers 503 before the Verified Permissions write when no policy store is configured.',
    bodyFrom: 'routes/identity.ts: `schema` is a Cedar JSON schema.',
    build: async () =>
      unsynthesisable('`schema` is a Cedar JSON schema; GET /api/identity/schema needs a live policy store, so none is readable offline.'),
  },

  // ── ingest / knowledge base (the mock-branched two) ───────────────────────
  {
    route: 'POST /api/ingest/start',
    persona: 'orgiq/admin',
    safe: '`startIngestionJob` takes its MOCK_AGENTCORE branch and appends a job row to the registered knowledge-base fixture; no Bedrock call is made.',
    bodyFrom: 'routes/ingest.ts: `dataSourceId` off GET /api/ingest/data-sources.',
    build: async (ctx) => {
      const dataSourceId = await ctx.pick('/api/ingest/data-sources', 'id');
      if (dataSourceId === null) return unsynthesisable('GET /api/ingest/data-sources listed no data source');
      return { dataSourceId };
    },
  },
  {
    route: 'POST /api/ingest/crawl/:id/sync',
    persona: 'orgiq/admin',
    safe: '`triggerKbSyncForCrawl` returns null immediately when no knowledge base is configured, so the route answers 502 before any AWS call.',
    bodyFrom: 'routes/ingest.ts: no body.',
  },
  {
    route: 'POST /api/assessment/knowledge/doc/publish',
    persona: 'assessment/admin',
    safe: 'Adds a page node to the REGISTERED knowledge-sections fixture (reset restores it) and makes no Confluence or AWS call. It also bumps a module-level version counter that reset cannot lower — a monotonic integer, not a seeded row, and `version` is not a wire-shaped field, so no snapshot value churns on it.',
    bodyFrom: 'routes/assessment.ts: `id` is an editable local doc id from GET /api/assessment/knowledge/tree.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      return { id };
    },
  },
  {
    route: 'POST /api/knowledge-base/sync',
    persona: 'orgiq/admin',
    safe: '`startSync` short-circuits to the mock job under MOCK_AGENTCORE and unshifts a row into the registered knowledge-base fixture.',
    bodyFrom: 'routes/knowledge-base.ts: `dataSourceId` off GET /api/knowledge-base/data-sources.',
    build: async (ctx) => {
      const dataSourceId = await ctx.pick('/api/knowledge-base/data-sources', 'id');
      if (dataSourceId === null) return unsynthesisable('GET /api/knowledge-base/data-sources listed no data source');
      return { dataSourceId };
    },
  },
  {
    route: 'PATCH /api/admin/kb-registry/:id',
    persona: 'orgiq/admin',
    safe: 'Both fields are optional and `updateKbEntry` returns before building a statement when the patch is empty, so no RDS Data API call is made.',
    bodyFrom: 'routes/kb-admin.ts: `name`/`description` both optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/admin/kb-registry/reconcile/adopt',
    persona: 'orgiq/admin',
    safe: '`adoptKnowledgeBase` refuses under `config.mock.aurora` before any Bedrock or Aurora call.',
    bodyFrom: 'routes/kb-admin.ts: `slug` off GET /api/admin/kb-registry, `kbId` is a live Bedrock knowledge-base id.',
    build: async () =>
      unsynthesisable(
        '`kbId` is a live Bedrock knowledge-base id. Nothing offline enumerates one — GET /reconcile does not surface ' +
        'live AWS ids under the mock providers — and a made-up id would prove nothing.',
      ),
  },
  {
    route: 'PATCH /api/environments/:id',
    persona: 'orgiq/admin',
    safe: 'An empty patch short-circuits to the mock read before the UPDATE, so no RDS Data API call is made.',
    bodyFrom: 'routes/environments.ts: every field optional; `{}` is accepted.',
    build: ok({}),
  },

  // ── observability (the mock-branched subset) ──────────────────────────────
  {
    route: 'POST /api/observability/harness/cases',
    persona: 'orgiq/admin',
    safe: 'Upserts into the registered `harness` fixture under MOCK_AURORA; no model, no AWS.',
    bodyFrom: 'routes/harness.ts: `agentId` and `prompt` non-empty; the agent id is read off GET /api/agents.',
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, prompt: ctx.label() };
    },
  },
  {
    route: 'PATCH /api/observability/harness/cases/:id',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `harness` fixture under MOCK_AURORA; no model, no AWS, and reset restores the case.',
    bodyFrom: 'routes/harness.ts: every field optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/observability/harness/runs',
    persona: 'orgiq/admin',
    safe: "Inserts into the registered `harness` fixture under MOCK_AURORA. `mode` is left unset so it collapses to 'sim' — 'live' is the one that would drive the fleet.",
    bodyFrom: "routes/harness.ts: `{}` is valid; `mode` must be the literal 'live' to mean anything.",
    build: ok({}),
  },
  {
    route: 'PATCH /api/observability/harness/runs/:id',
    persona: 'orgiq/admin',
    safe: 'An empty patch returns `{ ok, changed: 0 }` without touching the RDS Data API, so nothing is written at all.',
    bodyFrom: 'routes/harness.ts: every field optional; `{}` short-circuits.',
    build: ok({}),
  },
  {
    route: 'PATCH /api/observability/calibration/cases/:id',
    persona: 'orgiq/admin',
    safe: 'An empty patch returns `{ ok, changed: 0 }` without touching the RDS Data API.',
    bodyFrom: 'routes/calibration.ts: every field optional; `{}` short-circuits.',
    build: ok({}),
  },
  {
    route: 'POST /api/observability/prompt-versions',
    persona: 'orgiq/admin',
    safe: 'Fully in-memory under MOCK_AURORA (`mockRegisterPromptVersion`); appends a version, moves nothing.',
    bodyFrom: 'routes/prompt-versions.ts: `agentId` and `content` non-empty; the agent id is read off GET /api/agents.',
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, content: ctx.label() };
    },
  },
  {
    route: 'PUT /api/observability/canary/weight',
    persona: 'orgiq/admin',
    safe: "An echo-back write: it sets the weight to the value GET /api/observability/canary/weight just reported, and the canary weight is a registered fixture besides.",
    bodyFrom: 'routes/canary.ts: `weight_b` an integer 0..100, read off GET /api/observability/canary/weight.',
    build: async (ctx) => {
      const current = objectsWith(await ctx.get('/api/observability/canary/weight'), 'weight_b')[0]?.['weight_b'];
      if (typeof current !== 'number') return unsynthesisable('GET /api/observability/canary/weight reported no weight_b to echo back');
      return { weight_b: current };
    },
  },
  {
    route: 'POST /api/observability/canary/halt',
    persona: 'orgiq/admin',
    safe: 'Sets the registered canary-weight fixture to halted; reset restores it. No SSM write — that is `start`, which is refused.',
    bodyFrom: 'routes/canary.ts: no body.',
  },
  {
    route: 'POST /api/observability/canary/reset',
    persona: 'orgiq/admin',
    safe: 'Resets the registered canary-weight fixture and the in-process controller. No SSM write.',
    bodyFrom: 'routes/canary.ts: no body.',
  },
  {
    route: 'POST /api/observability/approvals/request',
    persona: 'orgiq/admin',
    safe: 'The approvals surface runs entirely on its in-memory mock store under these flags, and the store ships empty — this appends, it moves nothing seeded.',
    bodyFrom: 'routes/approvals.ts: `txId` and `agentId` non-empty; the agent id is read off GET /api/agents.',
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { txId: ctx.label(), agentId };
    },
  },
  {
    route: 'POST /api/observability/approvals/:id/decision',
    persona: 'orgiq/admin',
    safe: 'Decides an approval in the in-memory mock store, which ships empty — only a row this capture created is reachable.',
    bodyFrom: "routes/approvals.ts: `decision` ∈ {'APPROVED','REJECTED'}.",
    build: ok({ decision: 'APPROVED' }),
  },
];

/**
 * The first editable document the knowledge tree lists. The tree says which
 * node that is — `editable: true`, `is_dir: false` — so nothing is guessed
 * from the shape of an id. An earlier version matched "id contains a colon"
 * and picked the FOLDER `ec:standards`, which 404s on every doc route: the
 * lesson being that a heuristic over an id is a guess, and the server's own
 * flag is a fact.
 */
async function editableDocId(ctx: BodyContext): Promise<string | null> {
  const tree = await ctx.get('/api/assessment/knowledge/tree');
  const node = objectsWith(tree, 'id', 'editable', 'is_dir')
    .find((n) => n['editable'] === true && n['is_dir'] === false);
  return str(node?.['id']);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Classification =
  | { kind: 'replay'; spec: WriteSpec }
  | { kind: 'refused'; rule: string; reason: string };

const byRoute = new Map<string, WriteSpec>(WRITE_SPECS.map((s) => [s.route, s]));

/** The one decision. Refusals win; an unlisted route is refused, never replayed. */
export function classifyWrite(route: string): Classification {
  for (const rule of REFUSAL_RULES) {
    if (rule.id === 'unclassified') break;
    if (!rule.applies(route)) continue;
    const extra = rule.detail?.(route);
    return { kind: 'refused', rule: rule.id, reason: extra ? `${rule.because} Here: ${extra}.` : rule.because };
  }
  const spec = byRoute.get(route);
  if (spec) return { kind: 'replay', spec };
  const last = REFUSAL_RULES[REFUSAL_RULES.length - 1]!;
  return { kind: 'refused', rule: last.id, reason: last.because };
}

/** Exported for the test that proves every spec is reachable and reasoned. */
export function specFor(route: string): WriteSpec | undefined {
  return byRoute.get(route);
}
