// POST /api/work/findings/:id/promote — grant-scoped the same as dispatch-work.
//
// sme.md defect #4: "Put a worker on it" on a p-observability finding
// succeeded for an SME with no grant there, while `POST /api/bots/dispatch-work`
// refused the very same person on the very same initiative for lack of one.
// Two dispatch surfaces onto the same spend must agree, so this route now runs
// the identical `grantScopedDispatchVerdict` bots.ts uses (see bot-runner.ts).
//
// Deliberately NOT mocked: org-sweeps, budgets, identity and bot-runner all run
// their real `config.mock.aurora` paths (the same posture work-sme-journey.test.ts
// takes) — the interesting behaviour is the route's ordering and the shared
// decision, not a mock's fidelity to it.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } },
}));

// Cedar is not the subject: DispatchAgentRun is granted to `sme` role-wide
// (program-owner.md defect #4 moved the route off ManageDevbox onto it), and
// the interesting scoping happens after it (same posture as bots-dispatch and
// work-sme-journey).
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => true),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/work', workRouter);
  app.use(errorHandler);
  return app;
}

// Nora DaSilva: u-nora -> p-004, owns p-observability (no grant there — she's
// the accountable owner, not a funded SME on her own initiative), and holds a
// sprint envelope as an SME on p-auth-migration (schema/seed_program.sql /
// providers/budgets.ts MOCK_GRANTS bg-auth-3).
const nora = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
const releaseManager = { sub: 'u-release', role: 'org-leader', tenant: 'orgiq' };

// The seeded mock findings (providers/org-sweeps.ts seedMockFindings), in the
// fixed order they are inserted — ids are assigned sequentially the first
// time any code in this test file's module registry touches the findings
// store, so these are stable within this file.
const FINDING_OBS_NO_GRANT = 'find-mock-1';   // bus_factor, evidence.initiatives: ['p-observability']
const FINDING_NO_INITIATIVE = 'find-mock-2';  // orphan_decisions, no initiative evidence at all
const FINDING_AUTH_CANDIDATE = 'find-mock-5'; // orphan_decisions, evidence.candidateInitiative: 'p-auth-migration'

function promote(session: Record<string, unknown> | null, id: string) {
  return request(buildApp(session)).post(`/api/work/findings/${id}/promote`).send({});
}

describe('POST /api/work/findings/:id/promote — grant-scoped dispatch', () => {
  it('403s an sme with no active grant on the finding\'s initiative', async () => {
    const res = await promote(nora, FINDING_OBS_NO_GRANT);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no active sprint grant on Observability Platform/);
    expect(res.body.error).toMatch(/ask the release manager/);
  });

  it('agrees with dispatch-work\'s wording exactly — same helper, same text', async () => {
    const res = await promote(nora, FINDING_OBS_NO_GRANT);
    // decideGrantScopedDispatch's own wording, not a paraphrase of it.
    expect(res.body.error).toBe(
      'you hold no active sprint grant on Observability Platform, so you cannot dispatch against this initiative — ask the release manager for a grant',
    );
  });

  it('lets an sme promote a finding on an initiative they hold an active grant on', async () => {
    const res = await promote(nora, FINDING_AUTH_CANDIDATE);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.payload.findingId).toBe(FINDING_AUTH_CANDIDATE);
  });

  it('does not brake a finding with no initiative in its evidence — unscoped, not denied', async () => {
    const res = await promote(nora, FINDING_NO_INITIATIVE);
    expect(res.status).toBe(201);
  });

  it('lets an org-leader promote anywhere without a grant — they allocate, they do not spend a sprint envelope', async () => {
    const res = await promote(releaseManager, FINDING_OBS_NO_GRANT);
    expect(res.status).toBe(201);
  });

  it('still 404s an unknown finding before any grant check', async () => {
    const res = await promote(nora, 'find-mock-does-not-exist');
    expect(res.status).toBe(404);
  });
});
