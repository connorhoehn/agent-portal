// Design reviews — /api/designs (routes/designs.ts).
//
// What is pinned:
//   * the auth floor: reads open to the tenant, both HITL writes on
//     DispatchAgentRun (answering intent and ratifying a plan is directing
//     the agents — the router's own claim, previously unenforced),
//   * the `{reviews: [...]}` envelope and the two filters, forwarded only
//     when non-blank so a cleared filter widens instead of emptying,
//   * that BOTH the answering identity and the SIGN-OFF ROLE come from the
//     session — a sign-off attributed from the body would make the two-steward
//     quorum forgeable,
//   * the 409 branches, including the one that carries `blockingId` so the
//     drawer can link the review that is holding this one up, and the 400 that
//     refuses a decision that is neither approve nor reject.

const gateCalls: string[] = [];
let sessionValue: { sub: string; name?: string; role?: string } | null =
  { sub: 'u-1', name: 'Nora Vance', role: 'sme' };

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  resolveSession: () => sessionValue,
}));

const scopeDeny = new Set<string>();
jest.mock('../../lib/initiative-scope.js', () => ({
  requireInitiativeScope: jest.fn(async (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, initiativeId: string | null) => {
    if (initiativeId && scopeDeny.has(initiativeId)) { res.status(403).json({ error: 'not your initiative' }); return false; }
    return true;
  }),
}));
jest.mock('../../providers/design-reviews.js', () => ({
  listDesignReviews: jest.fn(),
  getDesignThread: jest.fn(),
  answerQuestion: jest.fn(),
  signoffDesign: jest.fn(),
}));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/user-avatars.js', () => ({ userAvatars: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { designsRouter } from '../designs.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser } from '../../providers/identity.js';
import { userAvatars } from '../../providers/user-avatars.js';
import {
  listDesignReviews, getDesignThread, answerQuestion, signoffDesign,
} from '../../providers/design-reviews.js';

const listMock = listDesignReviews as unknown as jest.Mock;
const threadMock = getDesignThread as unknown as jest.Mock;
const answerMock = answerQuestion as unknown as jest.Mock;
const signoffMock = signoffDesign as unknown as jest.Mock;

const REVIEW = {
  id: 'dr-1', title: 'Span projection cadence', status: 'blocked',
  orgProjectId: 'p-observability', summary: 'Blocked on one intent question',
  updatedAt: '2026-08-20T10:00:00Z', dependsOn: [], signoffs: [],
};
const THREAD = { ...REVIEW, posts: [{ id: 'po-1', kind: 'question', authorKind: 'agent', authorName: 'orgiq-advisor', body: 'daily or hourly?', resolvedBy: null }] };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/designs', designsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  listMock.mockReset(); threadMock.mockReset(); answerMock.mockReset(); signoffMock.mockReset();
  (getUser as jest.Mock).mockReset().mockResolvedValue({ id: 'u-1', personId: 'p-1' });
  (userAvatars as jest.Mock).mockReset().mockResolvedValue(new Map([['u-1', '/avatars/photos/p-1.jpg']]));
  // Answer and signoff resolve the thread's home initiative first (DE-44 row 30).
  threadMock.mockResolvedValue(THREAD);
  scopeDeny.clear();
  sessionValue = { sub: 'u-1', name: 'Nora Vance', role: 'sme' };
});

describe('auth floor', () => {
  it('gates answer + signoff on DispatchAgentRun and leaves both reads open', () => {
    expect(gateCalls).toEqual(['DispatchAgentRun']);
  });
});

describe('GET /api/designs', () => {
  it('wraps the list in `reviews` and carries the fields the board renders', async () => {
    listMock.mockResolvedValue([REVIEW]);
    const res = await request(buildApp()).get('/api/designs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['reviews']);
    for (const key of ['id', 'title', 'status', 'orgProjectId', 'summary']) {
      expect(res.body.reviews[0]).toHaveProperty(key);
    }
  });

  it('forwards initiative/status filters only when non-blank', async () => {
    listMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/designs');
    await request(app).get('/api/designs?initiative=&status=');
    await request(app).get('/api/designs?initiative=p-observability');
    await request(app).get('/api/designs?status=proposed');
    expect(listMock.mock.calls.map((c) => c[0])).toEqual([
      {}, {}, { orgProjectId: 'p-observability' }, { status: 'proposed' },
    ]);
  });
});

describe('GET /api/designs/:id', () => {
  it('returns the full thread, and 404s an unknown review', async () => {
    threadMock.mockResolvedValue(THREAD);
    const ok = await request(buildApp()).get('/api/designs/dr-1');
    expect(ok.status).toBe(200);
    expect(ok.body.posts[0].kind).toBe('question');

    threadMock.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/designs/dr-x');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/not found/);
  });
});

describe('POST /api/designs/:id/answer', () => {
  it('400s without a questionPostId or with a blank body', async () => {
    for (const body of [{}, { questionPostId: 'po-1' }, { questionPostId: 'po-1', body: '   ' }, { body: 'hi' }]) {
      const res = await request(buildApp()).post('/api/designs/dr-1/answer').send(body);
      expect(res.status).toBe(400);
    }
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('attributes the answer to the SESSION and trims the body', async () => {
    answerMock.mockResolvedValue(THREAD);
    const res = await request(buildApp())
      .post('/api/designs/dr-1/answer')
      .send({ questionPostId: 'po-1', body: '  hourly  ', authorName: 'forged', avatarUrl: '/forged.jpg' });
    expect(res.status).toBe(200);
    expect(getUser).toHaveBeenCalledWith('u-1');
    expect(userAvatars).toHaveBeenCalledWith([{ id: 'u-1', personId: 'p-1' }]);
    expect(answerMock).toHaveBeenCalledWith('dr-1', 'po-1', 'hourly', 'Nora Vance', '/avatars/photos/p-1.jpg');
  });

  it('409s (not 404) when the question is gone or already answered', async () => {
    answerMock.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/designs/dr-1/answer').send({ questionPostId: 'po-1', body: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already answered/);
  });
});

describe('POST /api/designs/:id/signoff', () => {
  it('refuses any decision that is not approve/reject', async () => {
    for (const decision of [undefined, '', 'maybe', 'APPROVE']) {
      const res = await request(buildApp()).post('/api/designs/dr-1/signoff').send({ decision });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/approve.*reject/);
    }
    expect(signoffMock).not.toHaveBeenCalled();
  });

  it('records the signer NAME and ROLE from the session — the quorum rests on it', async () => {
    signoffMock.mockResolvedValue({ thread: { ...THREAD, status: 'approved' } });
    const res = await request(buildApp())
      .post('/api/designs/dr-1/signoff').send({ decision: 'approve', role: 'admin', avatarUrl: '/forged.jpg' });
    expect(res.status).toBe(200);
    expect(signoffMock).toHaveBeenCalledWith('dr-1', 'approve', 'Nora Vance', 'sme', '/avatars/photos/p-1.jpg');
    expect(res.body.status).toBe('approved');
  });

  it('defaults a role-less session to member rather than inheriting the body', async () => {
    sessionValue = { sub: 'u-9' };
    (getUser as jest.Mock).mockResolvedValue(null);
    signoffMock.mockResolvedValue({ thread: THREAD });
    await request(buildApp()).post('/api/designs/dr-1/signoff').send({ decision: 'reject', role: 'admin' });
    expect(userAvatars).toHaveBeenCalledWith([{ id: 'u-9', personId: null }]);
    expect(signoffMock).toHaveBeenCalledWith('dr-1', 'reject', 'u-9', 'member', null);
  });

  it('409s a blocked approval and forwards blockingId so the drawer can link it', async () => {
    signoffMock.mockResolvedValue({ error: 'depends on an unapproved review', blockingId: 'dr-0' });
    const res = await request(buildApp())
      .post('/api/designs/dr-1/signoff').send({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'depends on an unapproved review', blockingId: 'dr-0' });
  });

  it('omits blockingId when the refusal has no blocking review', async () => {
    signoffMock.mockResolvedValue({ error: 'no decision post yet' });
    const res = await request(buildApp())
      .post('/api/designs/dr-1/signoff').send({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no decision post yet' });
  });

  it('404s an unknown review', async () => {
    signoffMock.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/designs/dr-x/signoff').send({ decision: 'approve' });
    expect(res.status).toBe(404);
  });
});

describe('design scope (DE-44 row 30)', () => {
  it('refuses answer and signoff on a design outside the caller\'s initiatives', async () => {
    scopeDeny.add(THREAD.orgProjectId);
    expect((await request(buildApp()).post('/api/designs/dr-1/answer').send({ questionPostId: 'q-1', body: 'yes' })).status).toBe(403);
    expect((await request(buildApp()).post('/api/designs/dr-1/signoff').send({ decision: 'approve' })).status).toBe(403);
    expect(answerMock).not.toHaveBeenCalled();
    expect(signoffMock).not.toHaveBeenCalled();
  });
});
