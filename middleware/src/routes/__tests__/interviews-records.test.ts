jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn() }));

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-records-test-key';

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { sessionMiddleware, type Session } from '../../lib/session.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { registerExportSection, clearExportSections } from '../../lib/interviews/export/registry.js';
import { exportNotices, exportSuggestions } from '../../lib/interviews/export/sections.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-root', 'Root Admin', { interviews: ['admin'] }),
];

const app = express();
app.use(express.json());
app.use(sessionMiddleware());
app.use((req, _res, next) => {
  const me = USERS.find((x) => x.id === String(req.headers['x-user'] ?? ''));
  if (me) {
    const tenant = Object.keys(me.grants)[0]!;
    req.session = { sub: me.id, name: me.displayName, tenant, role: me.grants[tenant]![0], grants: me.grants, iat: 0, epoch: 0 } as Session;
    req.sessionInvalid = false;
  }
  next();
});
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

const consents = (user: string, cand: string) => request(app).get(`/api/interviews/candidates/${cand}/consents`).set('x-user', user);
const exportOf = (user: string, id: string) => request(app).get(`/api/interviews/interviews/${id}/milo-export`).set('x-user', user);

let CAND = '';
beforeEach(async () => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  if (!CAND) {
    const list = await request(app).get('/api/interviews/candidates').set('x-user', 'u-greta');
    const row = (list.body.items as { candidate: { id: string; name: string } }[]).find((c) => /ingrid/i.test(c.candidate.name));
    CAND = row!.candidate.id;
  }
});

describe('consent records on the profile', () => {
  it('the recruiter reads the answers with their times and the export flag', async () => {
    const res = await consents('u-greta', CAND);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.reads).toBe('answers');
    const item = res.body.items.find((i: { interviewId: string }) => i.interviewId === 'iv-d7q4n9xe');
    expect(item).toMatchObject({ answered: true, noticeVersion: CONSENT_NOTICE.version, exportable: true });
    expect(item.answers.milo).toEqual({ answer: expect.any(Boolean), at: expect.any(String) });
    expect(Object.keys(item.answers)).toEqual(['recording', 'transcription', 'milo']);
  });

  it('the admin reads the answers, without the export', async () => {
    const res = await consents('u-root', CAND);
    expect(res.status).toBe(200);
    expect(res.body.items[0].answers).toBeDefined();
    expect(res.body.items[0].exportable).toBeUndefined();
  });

  it('the hiring manager reads that a notice was given, never the answers', async () => {
    const res = await consents('u-amara', CAND);
    expect(res.status).toBe(200);
    expect(res.body.reads).toBe('notice');
    for (const i of res.body.items) {
      expect(i.answers).toBeUndefined();
      expect(i.exportable).toBeUndefined();
    }
    expect(res.body.items.some((i: { noticeVersion: string | null }) => i.noticeVersion === CONSENT_NOTICE.version)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/recording|transcription|milo"/);
  });

  it('an interviewer is answered not-found, as is a missing candidate', async () => {
    expect((await consents('u-hugo', CAND)).status).toBe(404);
    expect((await consents('u-greta', 'cand-nobody')).status).toBe(404);
  });
});

describe('the export of what Milo showed', () => {
  it('gives the recruiter the interview, the seeded suggestions whole and the notice, as an attachment', async () => {
    const res = await exportOf('u-greta', 'iv-f2b6t5zh');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    const doc = JSON.parse(res.text);
    expect(Object.keys(doc.sections).sort()).toEqual(['milo-for-you', 'notices', 'panel-notices', 'recap', 'said-aloud', 'suggestions']);
    expect(doc.interview).toMatchObject({ id: 'iv-f2b6t5zh', candidateId: CAND, state: 'scored' });
    expect(JSON.stringify(doc.interview)).not.toMatch(/Ingrid/);
    expect(doc.sections['said-aloud']).toEqual({ lines: [] });
    const { suggestions } = doc.sections.suggestions;
    expect(suggestions.map((s: { id: string }) => s.id)).toEqual(['sg-mhzk2q4a7c1e93b05d', 'sg-mhzk2r0b2f6a18c44e']);
    expect(suggestions[0]).toEqual(expect.objectContaining({
      text: expect.any(String), basedOn: expect.anything(), madeAt: expect.any(String), shownAt: expect.anything(),
      answer: 'ask', answeredAt: expect.any(String), spoken: expect.any(Boolean), modelId: expect.any(String), promptVersion: expect.any(String),
    }));
    expect(doc.sections.notices.notice).toMatchObject({ version: CONSENT_NOTICE.version, title: CONSENT_NOTICE.title, paragraphs: CONSENT_NOTICE.paragraphs });
    expect(Object.keys(doc.sections.notices.answers)).toEqual(['recording', 'transcription', 'milo']);
  });

  it('counts the dropped attempts by code and gives no text for them', async () => {
    const all = await Promise.all(['iv-d7q4n9xe', 'iv-f2b6t5zh', 'iv-j6x2d9sb', 'iv-g9r1y8lp'].map((id) => exportSuggestions(id) as Promise<{ dropped: Record<string, number> }>));
    expect(all.some((a) => Object.keys(a.dropped).length > 0)).toBe(true);
  });

  it('a section that throws keeps its key with an error code and the export still succeeds', async () => {
    registerExportSection({ key: 'broken', read: async () => { throw new Error('boom'); } });
    try {
      const res = await exportOf('u-greta', 'iv-f2b6t5zh');
      expect(res.status).toBe(200);
      const doc = JSON.parse(res.text);
      expect(doc.sections.broken).toEqual({ error: 'unavailable' });
      expect(doc.sections.suggestions.suggestions.length).toBe(2);
    } finally {
      clearExportSections();
      registerExportSection({ key: 'suggestions', read: exportSuggestions });
      registerExportSection({ key: 'notices', read: exportNotices });
    }
  });

  it('is not-found for everyone who is not the recruiter, and for an unknown interview', async () => {
    for (const who of ['u-hugo', 'u-amara', 'u-root']) expect((await exportOf(who, 'iv-f2b6t5zh')).status).toBe(404);
    expect((await exportOf('u-greta', 'iv-nobody')).status).toBe(404);
  });
});

// Lane H5 (OWED O-163): the opening's hiring manager reads notices, and only for their own openings.
describe('a hiring manager of another opening', () => {
  it('gets not-found on the consents of a candidate on an opening that is not theirs, and on that round\'s export', async () => {
    // Amara manages the Backend and Engineering Manager openings; Ravi applied to iOS.
    const res = await consents('u-amara', 'cand-w4pvy8m9');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/Ravi|Coding|noticeVersion/);
    expect((await consents('u-greta', 'cand-w4pvy8m9')).status).toBe(200);
    expect((await exportOf('u-amara', 'iv-p2v7j4ye')).status).toBe(404);
    // Her own opening's candidate answers as the notice reading.
    expect((await consents('u-amara', CAND)).body.reads).toBe('notice');
  });
});
