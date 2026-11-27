// An interviewer's private notes and their server-side scorecard draft (routes/interviews/private-notes.ts; gap audit
// 2026-11-20 §5), mounted as index.ts mounts the tenant, with the actions decided from the REAL seeds/roles/*/*.cedar files.
//
//   the author (lead or panel)    reads and writes their own notes and draft, nobody else's
//   the lead, for the panel's     reads only their own: there is no way to name another person's
//   recruiter, hiring manager, admin, another interviewer   not found (404); another tenant's role: 403 at the mount
//   the window                    notes from accepted until the author's scorecard is in; a cancelled round stays readable
//   lifecycle                     a deletion request leaves none; the export carries none; a submit deletes the draft

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
  // The role → action matrix the open-mode authz derives from the Cedar seeds, read from every
  // tenant's actual files (role-registry.ts itself cannot load under jest: import.meta.url).
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const root = path.join(__dirname, '..', '..', '..', 'seeds', 'roles');
  const roles = fs.readdirSync(root, { withFileTypes: true }).filter((d: import('node:fs').Dirent) => d.isDirectory()).flatMap((d: import('node:fs').Dirent) =>
    fs.readdirSync(path.join(root, d.name)).filter((f: string) => f.endsWith('.cedar')).map((f: string) => {
      const cedar = fs.readFileSync(path.join(root, d.name, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      const caps = new Set<string>();
      for (const block of cedar.split(/\bpermit\b/).slice(1)) {
        for (const m of (block.split(';')[0] ?? '').matchAll(/OrgIQ::Action::"([^"]+)"/g)) caps.add(m[1]!);
      }
      return { id: f.replace(/\.cedar$/, ''), tenant: d.name, label: '', summary: '', capabilities: [...caps] };
    }));
  return { roleRegistry: () => [...roles, { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] }] };
});
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../lib/social-notify.js', () => ({ ...jest.requireActual('../../lib/social-notify.js'), notifyInterviewCancelled: jest.fn(async () => []), notifyInterviewScorecardIn: jest.fn(async () => []) }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { interviewPrivateNotesFixture, interviewScorecardDraftsFixture } from '../../mock/interviews-private-notes.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
  u('u-operator', 'Platform Operator', { orgiq: ['admin'], interviews: ['admin'] }),
];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers['x-user'] ?? '');
  const me = USERS.find((x) => x.id === id);
  if (me) {
    const tenant = String(req.headers['x-tenant'] ?? 'interviews');
    const role = String(req.headers['x-role'] ?? me.grants[tenant]?.[0] ?? 'none');
    req.session = { sub: id, tenant, role, grants: me.grants, iat: 0, epoch: 0 } as Session;
  }
  next();
});
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

const API = '/api/interviews';
const who = (id: string, tenant = 'interviews', role?: string) => {
  const set = (r: ReturnType<ReturnType<typeof request>['get']>) => { r.set('x-user', id).set('x-tenant', tenant); return role ? r.set('x-role', role) : r; };
  return {
    get: (p: string) => set(request(app).get(`${API}${p}`)),
    post: (p: string, body: unknown) => set(request(app).post(`${API}${p}`)).send(body as object),
    put: (p: string, body: unknown) => set(request(app).put(`${API}${p}`)).send(body as object),
  };
};
type Who = ReturnType<typeof who>;
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const THIRD = who('u-third');
const AMARA = who('u-amara');
const OPERATOR = who('u-operator');
const PRIYA = who('u-priya', 'access');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

// Kwame's coding round is live now (Hugo lead, Wen panel); his design round is assigned (Hugo, nobody has accepted).
// Nadia's leadership round is accepted (Wen lead, Hugo panel). Wen's leadership round with Daniel ended yesterday and
// her scorecard is due. Hugo's coding round with Ingrid is scored (his scorecard is in).
const LIVE = 'iv-s4e8u2zk';
const KWAME_DESIGN = 'iv-h4m7c3vu';
const KWAME = 'cand-nx59ftdv';
const NADIA = 'iv-n5z9f2cq';
const ENDED = 'iv-g9r1y8lp';
const HELD = 'iv-d7q4n9xe';
const SECRET = 'Hesitated on the retry budget; strong on the trade-off.';

const notes = (as: Who, id: string) => as.get(`/interviews/${id}/my-notes`);
const save = (as: Who, id: string, body: string, revision: number) => as.put(`/interviews/${id}/my-notes`, { body, revision });

describe('my notes: only the author', () => {
  it('the panel member writes and reads their own; the lead reads only their own, empty', async () => {
    expect((await notes(WEN, LIVE)).body.notes).toMatchObject({ body: '', revision: 0, updatedAt: null, canWrite: true, refusal: null, limits: { chars: 10000 } });
    const saved = await save(WEN, LIVE, SECRET, 0);
    expect(saved.status).toBe(200);
    expect(saved.body.notes).toMatchObject({ body: SECRET, revision: 1, canWrite: true });
    expect((await notes(WEN, LIVE)).body.notes.body).toBe(SECRET);
    const lead = await notes(HUGO, LIVE);
    expect(lead.status).toBe(200);
    expect(lead.body.notes.body).toBe('');
    expect(JSON.stringify(lead.body)).not.toContain('retry budget');
    // The lead's own save is their own row; Wen's stays as it was.
    expect((await save(HUGO, LIVE, 'Lead notes.', 0)).status).toBe(200);
    expect((await notes(WEN, LIVE)).body.notes).toMatchObject({ body: SECRET, revision: 1 });
    // No query or body names another person.
    expect((await HUGO.get(`/interviews/${LIVE}/my-notes?authorId=u-wen`)).body.notes.body).toBe('Lead notes.');
    expect(interviewPrivateNotesFixture.rows().map((r) => r.authorId).sort()).toEqual(['u-hugo', 'u-wen']);
  });

  it.each([
    ['the recruiter', GRETA, 404],
    ['the hiring manager', AMARA, 404],
    ['the admin', OPERATOR, 404],
    ['an interviewer without a seat on the round', THIRD, 404],
    ['another tenant\'s role', PRIYA, 403],
  ])('%s neither reads nor writes anyone\'s notes or draft', async (_label, as, status) => {
    await save(WEN, LIVE, SECRET, 0);
    for (const res of [
      await notes(as, LIVE), await save(as, LIVE, 'x', 0), await save(as, LIVE, 'x', 1),
      await as.get(`/interviews/${LIVE}/scorecard-draft`), await as.put(`/interviews/${LIVE}/scorecard-draft`, { draft: {}, basedOn: 0, revision: 0 }),
    ]) {
      expect(res.status).toBe(status);
      expect(JSON.stringify(res.body)).not.toContain('retry budget');
    }
    expect(interviewPrivateNotesFixture.rows()).toHaveLength(1);
    expect(interviewScorecardDraftsFixture.rows()).toHaveLength(0);
  });

  it('a second tab saving against an older revision is 409 with the notes as they now are, and writes nothing', async () => {
    await save(WEN, LIVE, 'first', 0);
    await save(WEN, LIVE, 'second', 1);
    const stale = await save(WEN, LIVE, 'from the old tab', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.notes).toMatchObject({ body: 'second', revision: 2 });
    expect((await save(WEN, LIVE, 'also old', 0)).status).toBe(409);
    expect((await notes(WEN, LIVE)).body.notes.body).toBe('second');
  });

  it('plain text up to 10,000 characters; anything else is 400', async () => {
    expect((await save(WEN, LIVE, 'x'.repeat(10000), 0)).status).toBe(200);
    expect((await save(WEN, LIVE, 'x'.repeat(10001), 1)).status).toBe(400);
    expect((await WEN.put(`/interviews/${LIVE}/my-notes`, { body: { html: '<b>' }, revision: 1 })).status).toBe(400);
    expect((await WEN.put(`/interviews/${LIVE}/my-notes`, { body: 'x' })).status).toBe(400);
  });
});

describe('my notes: the write window', () => {
  it('not before the round is accepted; from accepted on', async () => {
    const before = await notes(HUGO, KWAME_DESIGN);
    expect(before.body.notes).toMatchObject({ canWrite: false, refusal: expect.stringContaining('accepted') });
    expect((await save(HUGO, KWAME_DESIGN, 'early', 0)).status).toBe(409);
    expect((await save(HUGO, NADIA, 'Ask about the reorg.', 0)).status).toBe(200);
    expect((await save(WEN, ENDED, 'After the call.', 0)).status).toBe(200);
  });

  it('read only once the author\'s scorecard is in', async () => {
    const held = await notes(HUGO, HELD);
    expect(held.body.notes).toMatchObject({ canWrite: false, refusal: expect.stringContaining('scorecard') });
    expect((await save(HUGO, HELD, 'late', 0)).status).toBe(409);
  });

  it('a cancelled round keeps the notes readable to their author and takes no more writes', async () => {
    await save(HUGO, NADIA, 'Ask about the reorg.', 0);
    const rev = interviewsFixture.rows().find((i) => i.id === NADIA)!.revision;
    expect((await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev, reason: 'rescheduling' })).status).toBe(200);
    const after = await notes(HUGO, NADIA);
    expect(after.body.notes).toMatchObject({ body: 'Ask about the reorg.', revision: 1, canWrite: false, refusal: expect.stringContaining('did not go ahead') });
    const refused = await save(HUGO, NADIA, 'changed', 1);
    expect(refused.status).toBe(409);
    expect(refused.body.notes.body).toBe('Ask about the reorg.');
  });
});

describe('the scorecard draft on the server', () => {
  const draftOf = (as: Who, id: string) => as.get(`/interviews/${id}/scorecard-draft`);
  const putDraft = (as: Who, id: string, draft: object, revision: number, basedOn = 0) => as.put(`/interviews/${id}/scorecard-draft`, { draft, basedOn, revision });

  it('none until saved; saved per author with the same compare-and-set; nobody else reads it', async () => {
    expect((await draftOf(WEN, ENDED)).body.draft).toMatchObject({ draft: null, canWrite: true });
    const first = await putDraft(WEN, ENDED, { summary: 'Calm under the outage question.' }, 0);
    expect(first.status).toBe(200);
    expect(first.body.draft.draft).toMatchObject({ draft: { summary: 'Calm under the outage question.' }, basedOn: 0, revision: 1 });
    // An upload of a local draft when the server already has one is stale: the page keeps the server's.
    const upload = await putDraft(WEN, ENDED, { summary: 'older local copy' }, 0);
    expect(upload.status).toBe(409);
    expect(upload.body.draft.draft.draft.summary).toBe('Calm under the outage question.');
    expect((await putDraft(WEN, ENDED, { summary: 'Second pass.' }, 1)).body.draft.draft.revision).toBe(2);
    expect((await draftOf(GRETA, ENDED)).status).toBe(404);
    expect((await draftOf(AMARA, ENDED)).status).toBe(404);
  });

  it('only while the author may submit: not on a round that has not ended', async () => {
    expect((await draftOf(WEN, LIVE)).body.draft.canWrite).toBe(false);
    expect((await putDraft(WEN, LIVE, { summary: 'x' }, 0)).status).toBe(409);
  });

  it('a draft too large or not an object is 400', async () => {
    expect((await putDraft(WEN, ENDED, { summary: 'x'.repeat(70_000) }, 0)).status).toBe(400);
    expect((await WEN.put(`/interviews/${ENDED}/scorecard-draft`, { draft: ['a'], basedOn: 0, revision: 0 })).status).toBe(400);
  });

  it('is deleted when its author submits the scorecard', async () => {
    await putDraft(WEN, ENDED, { summary: 'draft' }, 0);
    const page = (await WEN.get(`/interviews/${ENDED}/scorecard`)).body.scorecard;
    const body = {
      ratings: page.competencies.map((c: { id: string }) => ({ competencyId: c.id, rating: 3, note: '' })),
      recommendation: 'yes', summary: 'Clear examples throughout.', basedOn: 0,
    };
    expect((await WEN.post(`/interviews/${ENDED}/scorecard`, body)).status).toBe(201);
    expect(interviewScorecardDraftsFixture.rows()).toEqual([]);
    expect((await draftOf(WEN, ENDED)).body.draft.draft).toBeNull();
    // And the notes on that round are read only from now on.
    expect((await notes(WEN, ENDED)).body.notes.canWrite).toBe(false);
  });
});

describe('lifecycle', () => {
  it('a candidate\'s personal-data request leaves no notes and no drafts on their interviews, and keeps everyone else\'s', async () => {
    await save(WEN, LIVE, SECRET, 0);
    await save(HUGO, LIVE, 'Lead notes.', 0);
    await save(WEN, ENDED, 'Another candidate.', 0);
    interviewScorecardDraftsFixture.rows().push({ interviewId: LIVE, authorId: 'u-wen', basedOn: 0, draft: { summary: 'x' }, revision: 1, updatedAt: '2026-11-16T10:00:00.000Z' });
    const res = await GRETA.post(`/candidates/${KWAME}/deletion`, { confirm: true, scope: 'personal' });
    expect(res.status).toBe(200);
    expect(interviewPrivateNotesFixture.rows().filter((r) => r.interviewId === LIVE || r.interviewId === KWAME_DESIGN)).toEqual([]);
    expect(interviewScorecardDraftsFixture.rows()).toEqual([]);
    expect(interviewPrivateNotesFixture.rows().map((r) => r.interviewId)).toEqual([ENDED]);
    // The deletion log names the kinds and counts, never the words.
    expect(JSON.stringify(res.body)).not.toContain('retry budget');
  });

  it('a whole deletion request (no scope) takes them with the media too', async () => {
    await save(WEN, LIVE, SECRET, 0);
    interviewScorecardDraftsFixture.rows().push({ interviewId: KWAME_DESIGN, authorId: 'u-hugo', basedOn: 0, draft: { summary: 'x' }, revision: 1, updatedAt: '2026-11-16T10:00:00.000Z' });
    expect((await GRETA.post(`/candidates/${KWAME}/deletion`, { confirm: true })).status).toBe(200);
    expect(interviewPrivateNotesFixture.rows()).toEqual([]);
    expect(interviewScorecardDraftsFixture.rows()).toEqual([]);
  });

  it('the export of what Milo showed carries no private notes and no draft', async () => {
    await save(HUGO, HELD, 'never', 0); // refused: Hugo's scorecard is in
    interviewPrivateNotesFixture.rows().push({ interviewId: HELD, authorId: 'u-hugo', body: SECRET, revision: 1, updatedAt: '2026-11-16T10:00:00.000Z' });
    interviewScorecardDraftsFixture.rows().push({ interviewId: HELD, authorId: 'u-hugo', basedOn: 1, draft: { summary: 'A draft correction about the retry budget.' }, revision: 1, updatedAt: '2026-11-16T10:00:00.000Z' });
    const res = await GRETA.get(`/interviews/${HELD}/milo-export`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('retry budget');
  });
});
