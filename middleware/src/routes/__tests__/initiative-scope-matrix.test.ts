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
  'budgets', 'grants', 'lab', 'designs', 'initiative-decks', 'devbox', 'sprints'];
const SCOPE_CHECK = /requireInitiativeScope|requireBoxAccess|userReachesBox|requireInitiativeSteward|sprintMoveAllowed|userStewardsInitiative|stewardsInitiative|grantScopedDispatchVerdict|canSee\(|runAttribution\(/;

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
  'lab POST /signals', 'lab POST /experiences', 'lab POST /consults', 'lab POST /consults/:id/answer',
  'sprints DELETE /:sprintId/items/:itemId', 'sprints PATCH /:sprintId/items', 'sprints POST /',
  'work DELETE /jobs/:id', 'work POST /findings/:id/promote', 'work POST /jobs', 'work POST /jobs/:id/requeue',
  'work POST /jobs/:id/review', 'work POST /sweeps/run',
  'work-items PATCH /work-items/:id', 'work-items POST /work-items',
];

/** Not scoped yet, each with why. Fixing one moves it to SCOPED. */
const OPEN: Record<string, string> = {
  'bots POST /work-items/:id/estimate': 'DE-44 row 5 (low): estimate only, spends one model call',
  'bots POST /work-items/:id/review-estimate': 'DE-44 row 5 (low)',
  'budgets PUT /:orgProjectId': 'DE-44 row 20: whether program-owner is program-wide is a user decision',
  'budgets DELETE /:orgProjectId': 'DE-44 row 20: same decision',
  'grants POST /': 'DE-44 row 21: same program-owner decision',
  'grants PATCH /:id': 'DE-44 row 21',
  'grants DELETE /:id': 'DE-44 row 21',
  'designs POST /:id/answer': 'DE-44 row 30 (medium)',
  'designs POST /:id/signoff': 'DE-44 row 30 (medium)',
  'initiative-decks POST /projects/:projectId': 'DE-44 row 31 (low): deckWriteAuthority ignores projectId',
  'initiative-decks POST /:id/revisions': 'DE-44 row 31 (low)',
  'initiative-decks POST /:id/revise': 'DE-44 row 31 (low)',
  'initiative-decks POST /:id/preview': 'DE-44 row 31 (low)',
  'sdlc POST /policies': 'DE-43/DE-46: policy edits move to their own Cedar action and versioned policy',
  'sdlc DELETE /policies/:id': 'DE-43/DE-46',
  'devbox POST /sessions': 'mints a fresh session id for the caller; nothing to scope until a box is registered',
  'work POST /dispatch': 'operator kick of the dispatcher; no initiative in the request',
  'work POST /findings/:id/analyze': 'DE-44 row 9-adjacent (low): analysis only, no spend on an initiative budget',
  'work POST /findings/analyze-batch': 'same as /findings/:id/analyze',
  'work POST /findings/:id/dismiss': 'DE-44 row 9 (low)',
  'work POST /proposals': 'ManageDevbox-gated; not yet assessed for initiative scope (not in the DE-44 table)',
  'work POST /proposals/:id/decide': 'ManageDevbox-gated; not yet assessed for initiative scope (not in the DE-44 table)',
  'work-items POST /projects/:id/discussion/comments': 'DE-44 row 23 (low)',
  'work-items POST /work-items/:id/comments': 'DE-44 row 23 (low)',
  'work-items POST /work-items/:id/criteria': 'DE-44 row 23 (low)',
  'work-items PATCH /work-items/:id/criteria/:criterionId': 'DE-44 row 23 (low)',
  'work-items DELETE /work-items/:id/criteria/:criterionId': 'DE-44 row 23 (low)',
  'work-items PUT /work-items/:id/decisions/:decisionId': 'DE-44 row 23 (low)',
  'work-items DELETE /work-items/:id/decisions/:decisionId': 'DE-44 row 23 (low)',
  'work-documents PUT /work-items/:id/documents/:documentId': 'DE-44 row 23 (low)',
  'work-documents DELETE /work-items/:id/documents/:documentId': 'DE-44 row 23 (low)',
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

  it('every OPEN route says why', () => {
    expect(Object.entries(OPEN).filter(([, why]) => !why.trim())).toEqual([]);
  });
});
