// The DE-44 matrix: every write route on the routers that act on an
// initiative, codebase, box, job, change or sprint is either SCOPED (its
// handler calls one of the scope checks) or OPEN with the reason recorded.
//
// What this catches: a NEW write route on these routers that nobody
// classified, a SCOPED route that lost its check, and an OPEN route that
// gained one (move it to SCOPED so the list stays honest). It reads the route
// sources rather than the mounted stack because asyncHandler hides the handler
// body from the router. docs/deployment-enhancements/DE-44-scope-checks.md
// has the row numbers; docs/deploy-hardening-goal-2026-10-27.md the state.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTES = resolve(__dirname, '..');
const FILES = ['bots', 'work', 'agent-projects', 'sdlc', 'internal-devbox', 'work-items', 'work-documents',
  'budgets', 'grants', 'lab', 'designs', 'initiative-decks', 'devbox', 'sprints', 'prompt-pointers', 'user-budgets',
  'ops-switches', 'projects', 'runbooks', 'local-compute'];
// `sprintMoveAllowed` is deliberately NOT a scope check here (sweep 11, M1): it
// runs only when a write moves an item into a sprint, so a route that named it
// passed this matrix while every other field was open to anyone with the action.
const SCOPE_CHECK = /requireInitiativeScope|requireBoxAccess|userReachesBox|requireInitiativeSteward|userStewardsInitiative|stewardsInitiative|grantScopedDispatchVerdict|canSee\(|runAttribution\(|itemInScope\(|designInScope\(|requireBudgetScope\(|mayReviewRunbook\(|decidable\(|fencedJob\(|localBoxId\(node\.id\)|ownedNode\(/;
// The direct checks a handler can make itself, for the top-level test below.
const DIRECT_CHECK = /requireInitiativeScope\(|itemInScope\(|stewardsInitiative\(/;
// Files whose SCOPED routes must make that check unconditionally, at the
// handler's own top level rather than inside a branch.
const TOP_LEVEL_FILES = ['work-items', 'projects'];

const SCOPED = [
  'agent-projects DELETE /:id', 'agent-projects POST /', 'agent-projects POST /:id/clone-command',
  'agent-projects POST /:id/cloned', 'agent-projects POST /:id/runs', 'agent-projects POST /runs/:runId/finish',
  'bots DELETE /:id', 'bots PATCH /:id', 'bots POST /', 'bots POST /:id/pause', 'bots POST /:id/resume',
  'bots POST /:id/run', 'bots POST /dispatch-work',
  'devbox DELETE /:sessionId', 'devbox DELETE /boxes/:boxId', 'devbox PATCH /boxes/:boxId', 'devbox POST /:sessionId/command', 'devbox POST /:sessionId/shell-url',
  'devbox POST /:sessionId/task', 'devbox POST /boxes',
  'internal-devbox DELETE /:sessionId', 'internal-devbox POST /:sessionId/shell-url',
  'internal-devbox POST /:sessionId/task', 'internal-devbox POST /sessions',
  'sdlc POST /changes/:id/address', 'sdlc POST /changes/:id/decide', 'sdlc POST /changes/:id/deliver',
  'sdlc POST /changes/:id/rereview',
  // DE-46: an initiative's policy set is edited by its stewards. The check is
  // stewardsInitiative inside lib/sdlc-policy-governance.ts; the route body
  // names it where it hands over.
  'sdlc PUT /policy-sets/:scope', 'sdlc POST /policy-proposals/:id/decide',
  'lab POST /signals', 'lab POST /experiences', 'lab POST /consults', 'lab POST /consults/:id/answer',
  'bots POST /work-items/:id/estimate', 'bots POST /work-items/:id/review-estimate',
  // The dispatch drawer's saved-for-later setup (2026-10-28): the item's stewards' call, like its estimate.
  'bots PUT /work-items/:id/job-draft', 'bots DELETE /work-items/:id/job-draft', 'designs POST /:id/answer', 'designs POST /:id/signoff', 'work POST /findings/:id/dismiss', 'work-items POST /work-items/:id/criteria', 'work-items PATCH /work-items/:id/criteria/:criterionId', 'work-items DELETE /work-items/:id/criteria/:criterionId', 'work-items PUT /work-items/:id/decisions/:decisionId', 'work-items DELETE /work-items/:id/decisions/:decisionId', 'work-documents PUT /work-items/:id/documents/:documentId', 'work-documents DELETE /work-items/:id/documents/:documentId',
  'sprints DELETE /:sprintId/items/:itemId', 'sprints PATCH /:sprintId/items', 'sprints POST /',
  'work DELETE /jobs/:id', 'work POST /findings/:id/promote', 'work POST /jobs', 'work POST /jobs/:id/requeue',
  'work POST /jobs/:id/review', 'work POST /sweeps/run',
  // Sweep 11 (M1): every field of a work item, and creating one, is the
  // initiative's own people's call, checked at the handler's top level.
  'work-items PATCH /work-items/:id', 'work-items POST /work-items',
  // The learning loop (stage 4): which runbooks a run on the item is given first is the item's people's call.
  'work-items PUT /work-items/:id/runbook-pins',
  // Sweep 11: who runs an initiative and its contributors' roles are its own
  // people's call (naming the owner also needs the owner or an org-wide role).
  'projects PATCH /:id', 'projects PATCH /:id/contributors/:personId', 'projects PATCH /:id/devbox-profile',
  // Sweep 11: an initiative's deck is built and saved by its own people
  // (lib/deck-shared/authority.ts asks stewardsInitiative for orgiq).
  'initiative-decks POST /projects/:projectId', 'initiative-decks POST /:id/revisions', 'initiative-decks POST /:id/revise',
  // DE-50: an initiative pause is its stewards' (ManageBudgets + requireInitiativeScope);
  // the fleet scope needs an org-wide role instead.
  'ops-switches PUT /switches/:scope',
  // docs/next-steps.md §9 item 8a: a program-owner allocates only on
  // initiatives they own (lib/budget-scope.ts requireBudgetScope); org-leader,
  // hr-admin and admin stay program-wide.
  'budgets PUT /:orgProjectId', 'budgets DELETE /:orgProjectId', 'budgets PUT /:orgProjectId/limits',
  'grants POST /', 'grants PATCH /:id', 'grants DELETE /:id',
  // §9 item 8d: a comment needs ViewWorkItems plus membership of the item's
  // initiative (requireInitiativeScope), not the DispatchAgentRun write gate.
  'work-items POST /projects/:id/discussion/comments', 'work-items POST /work-items/:id/comments',
  // A workspace document is edited and created by members of its initiative (requireInitiativeScope).
  'work-documents PUT /documents/:documentId', 'work-documents POST /projects/:projectId/workspace-documents',
  // The runbook library (learning loop): deciding a proposal or retiring a runbook needs review
  // rights on the runbook's own scope (its owner, or an SME of its initiative; org-leader and admin
  // override), through lib/runbook-review.ts mayReviewRunbook — `decidable` is the shared door for
  // accept, reject and merge. Merge needs it on the target AND the proposal's own runbook.
  'runbooks POST /proposals/:pid/accept', 'runbooks POST /proposals/:pid/reject', 'runbooks POST /proposals/:pid/merge', 'runbooks POST /:id/retire',
  // Local compute: a machine's work loop is bound to the machine. The claim takes only jobs queued
  // for the authenticated node (the box id and node id come from the node token, never the body),
  // and every call after it is fenced to a job that box holds. Initiative authority was checked
  // when the job was handed to the machine (POST /nodes/:nodeId/work: ownedNode + grantScopedDispatchVerdict).
  'local-compute POST /claim', 'local-compute POST /jobs/:jobId/start', 'local-compute POST /jobs/:jobId/heartbeat',
  'local-compute POST /jobs/:jobId/skills', 'local-compute POST /jobs/:jobId/complete', 'local-compute POST /jobs/:jobId/debrief',
  'local-compute POST /jobs/:jobId/log', 'local-compute POST /nodes/:nodeId/work',
];

/** Not scoped yet, each with why. Fixing one moves it to SCOPED. */
const OPEN: Record<string, string> = {
  'runbooks POST /proposals': 'anyone signed in may suggest a runbook edit (SuggestRunbook), and a proposal changes nothing until a person with review rights decides it; a person\'s is attributed to their own session, a machine\'s only to the run its run token names (lib/run-token.ts) and its frozen brief',
  'runbooks POST /proposals/:pid/withdraw': 'identity-bound, not scope-bound: only the proposer may withdraw their own open proposal (NOT_PROPOSER otherwise), and a run cannot',
  'runbooks POST /:id/applications': 'a box reports on a run (service auth plus the run token for exactly that run_ref); a person does not call it, and the run must have been given the runbook (NOT_GIVEN otherwise)',
  // Machine presence and pairing: keyed by the authenticated node (or the pairing code), with no initiative in the request.
  'local-compute POST /pair/start': 'mints a pairing code for the caller (ConnectLocalCompute); the owner is the session, never the request, and no initiative is involved',
  'local-compute POST /pair/claim': 'the pairing code is the whole credential (rate-limited); it mints a machine for the code\'s owner and touches no initiative',
  'local-compute POST /announce': 'the node token names the machine; presence rows are keyed by that node id and carry no initiative',
  'local-compute POST /heartbeat': 'same as /announce: the authenticated node\'s own last-seen stamp',
  'local-compute POST /sessions/:sessionId/end': 'the authenticated node ends a session in its own presence rows; another node\'s session id removes nothing',
  'local-compute POST /register': 'the authenticated node states its own capabilities; only narrows (kinds intersected with the closed set, concurrency capped), and never sets accept-jobs, which is the owner\'s',
  'local-compute POST /log': 'the authenticated node appends to its own machine log; keyed by node id',
  'local-compute PATCH /nodes/:id': 'owner-bound, not initiative-bound: the machine\'s owner (session.sub) is in the UPDATE\'s WHERE, so another person\'s machine answers 404',
  'local-compute DELETE /nodes/:id': 'same as PATCH: a soft revoke carrying the owner\'s id, so only the owner revokes it',
  'budgets PUT /learning': 'learning loop: the learning cap is the whole organisation\'s, with no initiative; ManageBudgets plus an org-wide role (a program-owner is refused in the handler)',
  'prompt-pointers POST /:agent/candidate': 'DE-4: prompts are org-wide, keyed by agent, with no initiative; ManageCanary (org-leader / hr-admin) is the gate',
  'prompt-pointers POST /:agent/promote': 'DE-4: same as candidate: org-wide, ManageCanary',
  'prompt-pointers POST /:agent/rollback': 'DE-4: same as candidate: org-wide, ManageCanary',
  // DE-54: a user budget spans every initiative the user spends on, so there is
  // no initiative to scope to; ManageBudgets plus the self-set refusal (a user
  // never sets or removes their own row) are the gate.
  'user-budgets PUT /:userId': 'DE-54: a user budget spans initiatives (no initiative to scope); ManageBudgets and never on your own row',
  'user-budgets DELETE /:userId': 'DE-54: same as PUT /:userId',
  // DE-55: which bots are funded first is the release manager's money call,
  // gated like budgets PUT (same program-owner decision, DE-44 row 20).
  'bots PUT /:id/essential': 'DE-55: ManageBudgets marks a bot essential; not in §9 item 8a (budgets and grants only), so program-owner is still program-wide here',
  'initiative-decks POST /:id/preview': 'renders a caller-supplied spec for a deck the caller can read and saves nothing (readGate)',
  'sdlc POST /policies': 'the org set only (no initiative); ManageSdlcPolicies + org-wide role + self-gate + two-person rule in lib/sdlc-policy-governance.ts (DE-43/DE-46)',
  'sdlc DELETE /policies/:id': 'same as POST /policies: the org set only',
  'devbox POST /sessions': 'mints a fresh session id for the caller; nothing to scope until a box is registered',
  'work POST /dispatch': 'operator kick of the dispatcher; no initiative in the request',
  'work POST /findings/:id/analyze': 'DE-44 row 9-adjacent (low): analysis only, no spend on an initiative budget',
  'work POST /findings/analyze-batch': 'same as /findings/:id/analyze',
  'work POST /proposals': 'ManageDevbox-gated; not yet assessed for initiative scope (not in the DE-44 table)',
  'work POST /proposals/:id/decide': 'ManageDevbox-gated; not yet assessed for initiative scope (not in the DE-44 table)',
};

function writeRoutes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of FILES) {
    const src = readFileSync(resolve(ROUTES, `${file}.ts`), 'utf8');
    const hits = [...src.matchAll(/\b(?:\w+Router|router)\.(post|patch|put|delete)\(\s*'([^']+)'/g)];
    // A handler's source ends at the next write route, or at the next function declaration, so a
    // scope check named in a helper declared between two routes (runbooks.ts and local-compute.ts
    // declare several) is not read as the earlier route's own.
    const fnStarts = [...src.matchAll(/^[ \t]*(?:export )?(?:async )?function \w+/gm)].map((m) => m.index!);
    hits.forEach((m, i) => {
      const nextRoute = i + 1 < hits.length ? hits[i + 1]!.index! : src.length;
      const nextFn = fnStarts.find((at) => at > m.index!) ?? src.length;
      out.set(`${file} ${m[1]!.toUpperCase()} ${m[2]}`, src.slice(m.index, Math.min(nextRoute, nextFn)));
    });
  }
  return out;
}

describe('DE-44 initiative-scope matrix', () => {
  const routes = writeRoutes();

  it('classifies every write route on these routers', () => {
    const unlisted = [...routes.keys()].filter((r) => !SCOPED.includes(r) && !(r in OPEN));
    expect(unlisted).toEqual([]);
    const stale = [...SCOPED, ...Object.keys(OPEN)].filter((r) => !routes.has(r));
    expect(stale).toEqual([]);
  });

  it('every SCOPED route still calls a scope check', () => {
    expect(SCOPED.filter((r) => !SCOPE_CHECK.test(routes.get(r) ?? ''))).toEqual([]);
  });

  it('an OPEN route that gained a scope check is moved to SCOPED', () => {
    expect(Object.keys(OPEN).filter((r) => SCOPE_CHECK.test(routes.get(r) ?? ''))).toEqual([]);
  });

  it('work-item and initiative writes check scope at the handler top level, never only in a branch', () => {
    const conditional = SCOPED.filter((r) => TOP_LEVEL_FILES.includes(r.split(' ')[0]!)).filter((r) => {
      const src = routes.get(r) ?? '';
      const body = src.slice(src.indexOf('=> {') + 4).split('\n');
      const first = body.find((l) => l.trim() && !l.trim().startsWith('//'));
      if (!first) return true;
      const top = first.length - first.trimStart().length;
      return !body.some((l) => l.length - l.trimStart().length === top && DIRECT_CHECK.test(l) && !/sprint/i.test(l));
    });
    expect(conditional).toEqual([]);
  });

  // Sweep 12, U2: a work-item or initiative write has no OPEN form at all. A
  // new route there fails this whichever list it is added to, until its handler
  // makes a direct check (requireInitiativeScope, or itemInScope over it) at
  // its own top level; and a write form the route regex above would not see
  // (`.all`, `.route`, `.use` with a handler) fails it too.
  it('every write route on the work-item and initiative routers checks scope directly, with no OPEN escape', () => {
    const top = [...routes.keys()].filter((r) => TOP_LEVEL_FILES.includes(r.split(' ')[0]!));
    expect(top.filter((r) => r in OPEN)).toEqual([]);
    expect(top.filter((r) => !SCOPED.includes(r))).toEqual([]);
    expect(top.filter((r) => !DIRECT_CHECK.test(routes.get(r) ?? ''))).toEqual([]);
    for (const file of TOP_LEVEL_FILES) {
      const src = readFileSync(resolve(ROUTES, `${file}.ts`), 'utf8');
      expect(src.match(/\b\w+Router\.(all|route|use)\(/g) ?? []).toEqual([]);
    }
  });

  it('every OPEN route says why', () => {
    expect(Object.entries(OPEN).filter(([, why]) => !why.trim())).toEqual([]);
  });
});
