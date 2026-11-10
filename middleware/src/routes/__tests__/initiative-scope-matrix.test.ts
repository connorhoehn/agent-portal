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
  'ops-switches', 'projects'];
// `sprintMoveAllowed` is deliberately NOT a scope check here (sweep 11, M1): it
// runs only when a write moves an item into a sprint, so a route that named it
// passed this matrix while every other field was open to anyone with the action.
const SCOPE_CHECK = /requireInitiativeScope|requireBoxAccess|userReachesBox|requireInitiativeSteward|userStewardsInitiative|stewardsInitiative|grantScopedDispatchVerdict|canSee\(|runAttribution\(|itemInScope\(|designInScope\(|requireBudgetScope\(/;
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
];

/** Not scoped yet, each with why. Fixing one moves it to SCOPED. */
const OPEN: Record<string, string> = {
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
    const hits = [...src.matchAll(/\b\w+Router\.(post|patch|put|delete)\(\s*'([^']+)'/g)];
    hits.forEach((m, i) => {
      out.set(`${file} ${m[1]!.toUpperCase()} ${m[2]}`, src.slice(m.index, i + 1 < hits.length ? hits[i + 1]!.index : undefined));
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

  it('every OPEN route says why', () => {
    expect(Object.entries(OPEN).filter(([, why]) => !why.trim())).toEqual([]);
  });
});
