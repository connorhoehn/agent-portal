// PUT/DELETE /api/graph/work-items/:id/decisions/:decisionId — the Brief's
// "Add context" write (routes/work-items.ts, providers/work-items.ts).
//
// Deliberately NOT mocked: work-items, decisions and projects all run their
// real `config.mock.aurora` paths, so a link is a real mutation of the
// registered `graph-decisions` fixture and is read back through the same
// Decisions-tab GET the portal uses. Only Cedar is stubbed — and the stub
// decides from the real role seeds (middleware/seeds/roles/<tenant>/<role>.cedar),
// so "member cannot link" is the seed's answer, not this file's.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } },
}));

jest.mock('../../lib/authz.js', () => {
  // lib/role-registry.ts uses import.meta and cannot load under jest, so the
  // stub reads the same seed file it would: does the role's .cedar permit the
  // action (comments stripped, so member.cedar's prose mention does not count).
  const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
  const { join } = jest.requireActual('node:path') as typeof import('node:path');
  const permits = (tenant: string, role: string, action: string): boolean => {
    try {
      const text = readFileSync(join(__dirname, '../../../seeds/roles', tenant, `${role}.cedar`), 'utf8')
        .replace(/\/\/[^\n]*/g, '');
      return text.includes(`Action::"${action}"`);
    } catch {
      return false;
    }
  };
  type Sess = { role: string; tenant: string } | null;
  return {
    resolveSession: (req: { session?: unknown }) => req.session ?? null,
    requireAction: (action: string) =>
      (req: { session?: Sess }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
        const session = req.session ?? null;
        if (!session) { res.status(401).json({ error: 'Unauthenticated' }); return; }
        if (permits(session.tenant, session.role, action)) { next(); return; }
        res.status(403).json({ error: 'Forbidden', action });
      },
  };
});

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workItemsRouter } from '../work-items.js';
import { errorHandler } from '../../lib/async-handler.js';
import { decisionRows } from '../../mock/decisions.js';
import { decideDecisionLink } from '../../providers/work-items.js';

function buildApp(session: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/graph', workItemsRouter);
  app.use(errorHandler);
  return app;
}

const nora = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
const theo = { sub: 'u-theo', role: 'member', tenant: 'orgiq' };

// wi-obs-e2-b4 is the blocked bug the Brief mockup opens; d-otel is a
// p-observability decision (schema/seed.sql) that no work item names yet.
const ITEM = 'wi-obs-e2-b4';
const LINK = `/api/graph/work-items/${ITEM}/decisions/d-otel`;

interface DecisionView { id: string; workItemId: string | null; workItemTitle: string | null }

async function obsDecision(id: string): Promise<DecisionView | undefined> {
  const res = await request(buildApp(nora)).get('/api/graph/projects/p-observability/decisions');
  expect(res.status).toBe(200);
  return (res.body as DecisionView[]).find((d) => d.id === id);
}

beforeEach(() => decisionRows.reset());

describe('PUT /api/graph/work-items/:id/decisions/:decisionId', () => {
  it('401s without a session', async () => {
    const res = await request(buildApp(null)).put(LINK);
    expect(res.status).toBe(401);
    expect(decisionRows.rows().find((d) => d.id === 'd-otel')?.workItemId).toBeNull();
  });

  it('403s a member — linking is a board write, gated like every other', async () => {
    const res = await request(buildApp(theo)).put(LINK);
    expect(res.status).toBe(403);
    expect(decisionRows.rows().find((d) => d.id === 'd-otel')?.workItemId).toBeNull();
  });

  it('links a decision to work on its own initiative, and the Decisions tab reads it back', async () => {
    const res = await request(buildApp(nora)).put(LINK);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'd-otel',
      workItemId: ITEM,
      workItemTitle: 'Stop duplicate alerts during a dependency outage',
    });
    expect(await obsDecision('d-otel')).toMatchObject({ workItemId: ITEM });

    // Idempotent: linking to the item it already names is not a conflict.
    const again = await request(buildApp(nora)).put(LINK);
    expect(again.status).toBe(200);
    expect(again.body.workItemId).toBe(ITEM);
  });

  it('the fixture reset puts the seeded link state back', async () => {
    await request(buildApp(nora)).put(LINK);
    decisionRows.reset();
    expect(await obsDecision('d-otel')).toMatchObject({ workItemId: null });
  });

  it('404s an unknown work item and an unknown decision', async () => {
    const noItem = await request(buildApp(nora)).put('/api/graph/work-items/wi-nope/decisions/d-otel');
    expect(noItem.status).toBe(404);
    expect(noItem.body.error).toMatch(/work item/i);

    const noDecision = await request(buildApp(nora)).put(`/api/graph/work-items/${ITEM}/decisions/d-nope`);
    expect(noDecision.status).toBe(404);
    expect(noDecision.body.error).toMatch(/decision/i);
  });

  it('409s a decision from another initiative, and writes nothing', async () => {
    // d-nova is p-llm-platform's; the item is p-observability's.
    const res = await request(buildApp(nora)).put(`/api/graph/work-items/${ITEM}/decisions/d-nova`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/p-llm-platform/);
    expect(decisionRows.rows().find((d) => d.id === 'd-nova')?.workItemId).toBeNull();
  });

  it('409s an org-wide decision — it has no initiative to match', async () => {
    const res = await request(buildApp(nora)).put(`/api/graph/work-items/${ITEM}/decisions/d-aurora`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/org-wide/);
  });

  it('409s a decision already linked to other work, rather than silently re-pointing it', async () => {
    // d-otel-vendor is seeded against wi-obs-e1 (seed_program.sql).
    const res = await request(buildApp(nora)).put(`/api/graph/work-items/${ITEM}/decisions/d-otel-vendor`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/wi-obs-e1/);
    expect(decisionRows.rows().find((d) => d.id === 'd-otel-vendor')?.workItemId).toBe('wi-obs-e1');
  });

  it('400s a body — the link is the whole request', async () => {
    const res = await request(buildApp(nora)).put(LINK).send({ workItemId: 'wi-obs-e1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workItemId/);
  });
});

describe('DELETE /api/graph/work-items/:id/decisions/:decisionId', () => {
  it('401s without a session and 403s a member', async () => {
    await request(buildApp(nora)).put(LINK);
    expect((await request(buildApp(null)).delete(LINK)).status).toBe(401);
    expect((await request(buildApp(theo)).delete(LINK)).status).toBe(403);
    expect(await obsDecision('d-otel')).toMatchObject({ workItemId: ITEM });
  });

  it('unlinks, and a second unlink is a 404', async () => {
    await request(buildApp(nora)).put(LINK);
    const res = await request(buildApp(nora)).delete(LINK);
    expect(res.status).toBe(204);
    expect(await obsDecision('d-otel')).toMatchObject({ workItemId: null, workItemTitle: null });

    const again = await request(buildApp(nora)).delete(LINK);
    expect(again.status).toBe(404);
  });

  it('never unlinks a decision from a DIFFERENT item it names', async () => {
    const res = await request(buildApp(nora)).delete(`/api/graph/work-items/${ITEM}/decisions/d-otel-vendor`);
    expect(res.status).toBe(404);
    expect(decisionRows.rows().find((d) => d.id === 'd-otel-vendor')?.workItemId).toBe('wi-obs-e1');
  });

  // What RESTORABLE_DELETES in mock/core/wire/write-policy.ts leans on: the
  // unlink clears a column on a registered-fixture row, and reset restores a
  // SEEDED link, not just one this test made.
  it('the fixture reset puts back a seeded link the unlink cleared', async () => {
    const res = await request(buildApp(nora)).delete('/api/graph/work-items/wi-obs-e1/decisions/d-otel-vendor');
    expect(res.status).toBe(204);
    expect(decisionRows.rows().find((d) => d.id === 'd-otel-vendor')?.workItemId).toBeNull();
    decisionRows.reset();
    expect(decisionRows.rows().find((d) => d.id === 'd-otel-vendor')?.workItemId).toBe('wi-obs-e1');
  });

  it('404s an unknown work item', async () => {
    const res = await request(buildApp(nora)).delete('/api/graph/work-items/wi-nope/decisions/d-otel');
    expect(res.status).toBe(404);
  });
});

describe('decideDecisionLink', () => {
  const item = { id: 'wi-a', projectId: 'p-x' };
  it('allows an unlinked decision on the same initiative, and a re-link to the same item', () => {
    expect(decideDecisionLink(item, { id: 'd', projectId: 'p-x', workItemId: null }).kind).toBe('allow');
    expect(decideDecisionLink(item, { id: 'd', projectId: 'p-x', workItemId: 'wi-a' }).kind).toBe('allow');
  });
  it('refuses another initiative, an org-wide decision, and one linked elsewhere', () => {
    expect(decideDecisionLink(item, { id: 'd', projectId: 'p-y', workItemId: null })).toMatchObject({ kind: 'refuse', status: 409 });
    expect(decideDecisionLink(item, { id: 'd', projectId: null, workItemId: null })).toMatchObject({ kind: 'refuse', status: 409 });
    expect(decideDecisionLink(item, { id: 'd', projectId: 'p-x', workItemId: 'wi-b' })).toMatchObject({ kind: 'refuse', status: 409 });
  });
});
