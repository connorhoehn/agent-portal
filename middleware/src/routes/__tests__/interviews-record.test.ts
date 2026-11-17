// The interview record (routes/interviews/record.ts; docs/interviews-tenant-plan.md row I5.1, contract E2), mounted as
// index.ts mounts the tenant, with actions decided from the REAL seeds/roles/*/*.cedar files.
//
//   the lead, a panel member, a recruiter, the opening's hiring manager   200, once the interview has ended
//   another round's interviewer, another opening's hiring manager, the admin, a guest   404
//   another tenant's role   the tenant's usual refusal at the mount
//   every state before `ended`   404
//   each part: available, declined, deleted, none

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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { interviewRecordLinesFixture, interviewRecordingsFixture } from '../../mock/interviews-records.js';
import type { Session } from '../../lib/session.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-other-hm', 'Sol Ferreira', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
  u('u-operator', 'Platform Operator', { orgiq: ['admin'], interviews: ['admin'] }),
  u('guest:inv-1', 'Guest', { interviews: ['recruiter'] }), // a guest identity even with a recruiter's grant
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

import { interviewConsentsFixture } from '../../mock/interviews-consents.js';
import { interviewDeletionsFixture } from '../../mock/interviews-deletions.js';
import type { InterviewState } from '../../lib/interviews/types.js';

const API = '/api/interviews';
const as = (id: string, tenant = 'interviews') => (p: string) => request(app).get(`${API}${p}`).set('x-user', id).set('x-tenant', tenant);
const GRETA = as('u-greta');
const HUGO = as('u-hugo');
const WEN = as('u-wen');
const AMARA = as('u-amara');
const OTHER_HM = as('u-other-hm');
const OPERATOR = as('u-operator');
const GUEST = as('guest:inv-1');
const PRIYA = as('u-priya', 'access');

const MATEO = 'iv-j6x2d9sb'; // Hugo leads, scored, recording stand-in and transcript seeded
const NADIA = 'iv-n5z9f2cq'; // Wen leads, Hugo on the panel; ended in this world
const JONAH = 'iv-g9r1y8lp'; // Wen leads, ended, recording stand-in and transcript seeded

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  for (const i of interviewsFixture.rows()) if (i.id === NADIA) { i.state = 'ended'; i.endedAt = '2026-11-16T10:00:00.000Z'; }
});

const record = (path: string) => `/interviews/${path}/record`;

describe('who reads the record', () => {
  it.each([['the lead', HUGO, MATEO], ['a panel member', HUGO, NADIA], ['the lead of a behavioural round', WEN, NADIA], ['a recruiter', GRETA, MATEO], ["the opening's hiring manager", AMARA, MATEO]])(
    '%s: 200, never cached', async (_label, who, id) => {
      const res = await who(record(id));
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.record.interview.id).toBe(id);
    });

  it.each([["another round's interviewer", WEN, MATEO], ["another opening's hiring manager", OTHER_HM, MATEO], ['the admin', OPERATOR, MATEO], ['a guest', GUEST, MATEO]])(
    '%s: the tenant\'s not-found', async (_label, who, id) => {
      const res = await who(record(id));
      expect(res.status).toBe(404);
      expect(res.body.record).toBeUndefined();
    });

  it('another tenant is refused at the mount', async () => {
    const res = await PRIYA(record(MATEO));
    expect([403, 404]).toContain(res.status);
    expect(res.body.record).toBeUndefined();
  });

  it.each<InterviewState>(['assigned', 'accepted', 'ready', 'live', 'declined', 'cancelled'])('not yet ended (%s): not found, even for the lead', async (state) => {
    for (const i of interviewsFixture.rows()) if (i.id === MATEO) i.state = state;
    expect((await HUGO(record(MATEO))).status).toBe(404);
    expect((await GRETA(record(MATEO))).status).toBe(404);
  });

  it('an unknown interview: not found', async () => { expect((await GRETA(record('iv-nope'))).status).toBe(404); });
});

describe('the parts', () => {
  it('the seeded stand-in: header, recording facts, the transcript with names, the markers', async () => {
    const r = (await HUGO(record(MATEO))).body.record;
    expect(r.interview).toMatchObject({ state: 'scored', round: { name: 'Coding', type: 'technical', minutes: 60 }, candidate: { id: 'cand-mateo', name: 'Mateo Álvarez' },
      opening: { id: 'op-backend' } });
    expect(r.recording).toEqual({ state: 'available', playbackUrl: null, durationSeconds: 3500, standIn: true });
    expect(r.transcript.state).toBe('available');
    expect(r.transcript.lines[0]).toEqual({ seq: 1, atMs: 20_000, side: 'panel', speaker: 'Hugo Marchetti', text: expect.stringMatching(/^Hi Mateo/) });
    expect(r.transcript.lines.some((l: { side: string; speaker: string }) => l.side === 'candidate' && l.speaker === 'Mateo Álvarez')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('guest:');
    expect(r.markers).toEqual([{ kind: 'milo-asked', atMs: 18 * 60_000 + 20_000, label: 'What happens to a request that arrives just as the window resets?' }]);
  });

  it('the runs of a technical round ride the record, oldest first, under the same rule, with no guest id and no source', async () => {
    const r = (await HUGO(record(MATEO))).body.record;
    expect(r.runs.map((x: { status: string }) => x.status)).toEqual(['failed', 'succeeded']);
    expect(r.runs[0].startedBy).toEqual({ id: 'candidate', name: 'Mateo', side: 'candidate' });
    expect(r.runs[1].result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('ok') });
    expect(Date.parse(r.runs[0].queuedAt)).toBeLessThan(Date.parse(r.runs[1].queuedAt));
    expect(JSON.stringify(r)).not.toContain('source');
    expect(r.questions.map((q: { id: string }) => q.id)).toEqual(['q-be-ratelimit', 'q-be-retry']);
    // Every reader the record allows reads them; every refusal above refuses them too (the runs ride the record's own route).
    expect((await GRETA(record(MATEO))).body.record.runs).toHaveLength(2);
    expect((await WEN(record(MATEO))).body.record).toBeUndefined();
  });

  it('a behavioural round has no runs and no questions to insert; every finished technical round has a failing and a passing run', async () => {
    const b = (await WEN(record('iv-f2b6t5zh'))).body.record;
    expect(b.runs).toEqual([]);
    expect(b.questions).toEqual([]);
    for (const id of ['iv-d7q4n9xe', 'iv-j6x2d9sb', 'iv-p2v7j4ye']) {
      const who = id === 'iv-p2v7j4ye' ? WEN : HUGO;
      const t = (await who(record(id))).body.record;
      const statuses = t.runs.map((x: { status: string }) => x.status);
      expect(statuses).toContain('failed');
      expect(statuses).toContain('succeeded');
      expect(t.transcript.state).toBe('available');
      expect(t.recording.state).toBe('available');
    }
  });

  it('a finished behavioural round that had no stand-in before now has a full record', async () => {
    const j = (await WEN(record('iv-g9r1y8lp'))).body.record;
    expect(j.transcript.lines.length).toBeGreaterThan(10);
    expect(j.markers.length).toBe(1);
  });

  it('declined: the candidate said no to the recording, then to the transcript; nothing else of the answers shows', async () => {
    const c = interviewConsentsFixture.rows().find((x) => x.interviewId === MATEO)!;
    c.recording = false;
    let r = (await HUGO(record(MATEO))).body.record;
    expect(r.recording).toEqual({ state: 'declined', playbackUrl: null, durationSeconds: null, standIn: false });
    expect(r.transcript.state).toBe('available');
    c.transcription = false;
    r = (await HUGO(record(MATEO))).body.record;
    expect(r.transcript).toEqual({ state: 'declined', lines: [] });
    expect(JSON.stringify(r)).not.toMatch(/consent|noticeVersion|answeredAt/);
  });

  it('deleted: the deletion log removed the recording and the transcript', async () => {
    interviewDeletionsFixture.rows().push({ id: 'del-test', candidateId: 'cand-mateo', interviewIds: [MATEO], reason: 'request', requestedAt: '2026-11-15T09:00:00.000Z',
      requestedBy: 'u-greta', dueBy: '2026-12-15T09:00:00.000Z', doneAt: '2026-11-15T09:05:00.000Z',
      removed: [{ kind: 'recording', count: 1 }, { kind: 'transcript-and-minutes', count: 32 }], left: [], attempts: 1, revision: 1 });
    const r = (await GRETA(record(MATEO))).body.record;
    expect(r.recording.state).toBe('deleted');
    expect(r.transcript).toEqual({ state: 'deleted', lines: [] });
  });

  it('none: a finished interview with nothing kept still has its markers', async () => {
    // The seed gives every finished interview a full record; take Jonah's stand-ins away to see the empty one.
    interviewRecordingsFixture.rows().splice(0, interviewRecordingsFixture.rows().length, ...interviewRecordingsFixture.rows().filter((x) => x.interviewId !== JONAH));
    interviewRecordLinesFixture.rows().splice(0, interviewRecordLinesFixture.rows().length, ...interviewRecordLinesFixture.rows().filter((x) => x.interviewId !== JONAH));
    const r = (await WEN(record(JONAH))).body.record;
    expect(r.recording).toEqual({ state: 'none', playbackUrl: null, durationSeconds: null, standIn: false });
    expect(r.transcript).toEqual({ state: 'none', lines: [] });
    expect(r.markers.map((m: { kind: string }) => m.kind)).toEqual(['question']);
  });
});
