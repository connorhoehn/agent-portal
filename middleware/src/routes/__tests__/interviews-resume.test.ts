// A candidate's résumé (routes/interviews/resume.ts; docs/interviews-tenant-plan.md row I1.6), mounted as index.ts mounts the tenant.
//
//   recruiter       uploads, replaces, reads, deletes
//   hiring-manager  reads the résumés of their own opening's candidates; every write refused (403)
//   interviewer     reads the résumé of a candidate they have a round on; every write refused (403)
//   anyone else     the tenant's refusal at the mount, or not-found outside their scope
// The seed gives each candidate with an interview a résumé; Chloe (no interview, on the iOS opening that has no hiring manager) has none.

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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import { setResumeStores } from '../../lib/interviews/resume/service.js';
import { MemoryResumeBytes, UnavailableResumeBytes } from '../../lib/interviews/resume/bytes-store.js';
import { RESUME_MAX_BYTES } from '../../lib/interviews/resume/rules.js';
import { buildSimplePdf } from '../../mock/interviews-resumes.js';
import { interviewCandidatesFixture } from '../../mock/interviews.js';
import { browserOrigin } from '../../lib/browser-origin.js';
import { readResume } from '../../lib/interviews/resume/service.js';
import { sha256Hex } from '../../lib/interviews/resume/rules.js';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
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


const PDF = buildSimplePdf(['Test Person', 'Fictional headline', 'A line of fictional experience.']);
const API = '/api/interviews';
type Req = ReturnType<ReturnType<typeof request>['get']>;
const who = (id: string, tenant = 'interviews', role?: string) => {
  const set = (r: Req) => { r.set('x-user', id).set('x-tenant', tenant); return role ? r.set('x-role', role) : r; };
  return {
    get: (p: string) => set(request(app).get(`${API}${p}`)),
    del: (p: string) => set(request(app).delete(`${API}${p}`)),
    put: (p: string, body: Buffer | string, type = 'application/pdf', name?: string) => {
      const r = set(request(app).put(`${API}${p}`)).set('Content-Type', type);
      return (name === undefined ? r : r.set('X-File-Name', name)).send(body as never);
    },
  };
};
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const AMARA = who('u-amara');
const OUTSIDER = who('u-priya', 'access');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  setResumeStores({ rows: null, bytes: new MemoryResumeBytes() });
});
afterAll(() => setResumeStores({ rows: null, bytes: null }));

const R = (id: string) => `/candidates/${id}/resume`;
const pointer = (id: string) => interviewCandidatesFixture.rows().find((c) => c.id === id)!.resumeFileId;

describe('who may read', () => {
  it('the recruiter reads any record, without its storage key', async () => {
    const res = await GRETA.get(R('cand-mateo'));
    expect(res.status).toBe(200);
    expect(res.body.resume).toMatchObject({ id: 'rf-mateo', candidateId: 'cand-mateo', contentType: 'application/pdf', uploadedBy: { id: 'u-greta', name: 'Greta Lindqvist' } });
    expect(res.body.resume.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toContain('storageKey');
    expect(JSON.stringify(res.body)).not.toContain('interviews/resumes');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the hiring manager reads their own opening\'s candidates and no one else', async () => {
    expect((await AMARA.get(R('cand-mateo'))).status).toBe(200);
    expect((await AMARA.get(`${R('cand-mateo')}/file`)).status).toBe(200);
    expect((await AMARA.get(R('cand-aiko'))).status).toBe(404);
    expect((await AMARA.get(`${R('cand-aiko')}/file`)).status).toBe(404);
  });

  it('an interviewer reads the candidates they have a round on and no one else', async () => {
    expect((await HUGO.get(R('cand-mateo'))).status).toBe(200);
    expect((await HUGO.get(`${R('cand-mateo')}/file`)).status).toBe(200);
    expect((await HUGO.get(R('cand-aiko'))).status).toBe(404);
    expect((await WEN.get(R('cand-aiko'))).status).toBe(200);
    expect((await WEN.get(`${R('cand-mateo')}/file`)).status).toBe(404);
  });

  it('a role from another tenant is refused at the mount on every route', async () => {
    expect((await OUTSIDER.get(R('cand-mateo'))).status).toBe(403);
    expect((await OUTSIDER.get(`${R('cand-mateo')}/file`)).status).toBe(403);
    expect((await OUTSIDER.put(R('cand-mateo'), PDF)).status).toBe(403);
    expect((await OUTSIDER.del(R('cand-mateo'))).status).toBe(403);
  });

  it('a candidate with no résumé, and a candidate that does not exist, are not found', async () => {
    expect((await GRETA.get(R('cand-chloe'))).status).toBe(404);
    expect((await GRETA.get(`${R('cand-chloe')}/file`)).status).toBe(404);
    expect((await GRETA.del(R('cand-chloe'))).status).toBe(404);
    expect((await GRETA.get(R('cand-nobody'))).status).toBe(404);
    expect((await GRETA.put(R('cand-nobody'), PDF)).status).toBe(404);
    expect((await GRETA.get(R('cand-chloe'))).body.error).toBe('This candidate has no résumé attached.');
  });

  it('the candidate\'s record carries the summary, or null', async () => {
    const withIt = (await GRETA.get('/candidates/cand-mateo')).body.candidate;
    expect(withIt.resume).toMatchObject({ fileName: expect.stringMatching(/\.pdf$/), uploadedBy: { id: 'u-greta', name: 'Greta Lindqvist' } });
    expect(Object.keys(withIt.resume).sort()).toEqual(['fileName', 'sizeBytes', 'uploadedAt', 'uploadedBy']);
    expect((await GRETA.get('/candidates/cand-chloe')).body.candidate.resume).toBeNull();
    expect((await AMARA.get('/candidates/cand-mateo')).body.candidate.resume).toMatchObject({ fileName: expect.any(String) });
  });
});

describe('the file read', () => {
  it('answers the bytes with the safe headers', async () => {
    const res = await GRETA.get(`${R('cand-ingrid')}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="[^"]+\.pdf"; filename\*=UTF-8''[^ ]+\.pdf$/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(Buffer.from(res.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('the recruiter uploads', () => {
  it('attaches a first résumé: the record, the pointer, and the same bytes back', async () => {
    const res = await GRETA.put(R('cand-chloe'), PDF, 'application/pdf', encodeURIComponent('Chloé Martin résumé.pdf'));
    expect(res.status).toBe(200);
    expect(res.body.resume).toMatchObject({ candidateId: 'cand-chloe', fileName: 'Chloé Martin résumé.pdf', sizeBytes: PDF.length, contentType: 'application/pdf', uploadedBy: { id: 'u-greta' } });
    expect(res.body.resume.id).toMatch(/^rf-/);
    expect(JSON.stringify(res.body)).not.toContain('storageKey');
    expect(pointer('cand-chloe')).toBe(res.body.resume.id);
    const file = await GRETA.get(`${R('cand-chloe')}/file`);
    expect(Buffer.from(file.body).equals(PDF)).toBe(true);
    expect(file.headers['content-disposition']).toContain("filename*=UTF-8''Chlo%C3%A9%20Martin%20r%C3%A9sum%C3%A9.pdf");
  });

  it('a new upload replaces the old: one record, the old bytes removed', async () => {
    const bytes = new MemoryResumeBytes();
    const removed: string[] = [];
    const spy = { put: bytes.put.bind(bytes), get: bytes.get.bind(bytes), remove: async (k: string) => { removed.push(k); await bytes.remove(k); } };
    setResumeStores({ bytes: spy });
    const first = (await GRETA.put(R('cand-chloe'), PDF)).body.resume;
    const second = (await GRETA.put(R('cand-chloe'), buildSimplePdf(['Second']))).body.resume;
    expect(second.id).not.toBe(first.id);
    expect(removed).toEqual([`interviews/resumes/cand-chloe/${first.id}.pdf`]);
    expect((await GRETA.get(R('cand-chloe'))).body.resume.id).toBe(second.id);
    expect(pointer('cand-chloe')).toBe(second.id);
    // a seeded one: the seeded file's row and pointer go too
    const seeded = (await GRETA.put(R('cand-mateo'), PDF)).body.resume;
    expect(removed).toContain('interviews/resumes/cand-mateo/rf-mateo.pdf');
    expect(pointer('cand-mateo')).toBe(seeded.id);
  });

  it('the shown name is cleaned and never builds the key', async () => {
    const res = await GRETA.put(R('cand-chloe'), PDF, 'application/pdf', encodeURIComponent('../../evil/\u0000x'));
    expect(res.body.resume.fileName).toBe('x.pdf');
    const none = await GRETA.put(R('cand-chloe'), PDF);
    expect(none.body.resume.fileName).toBe('resume.pdf');
  });

  it('refuses a file that is not a PDF by content, whatever its name or declared type', async () => {
    const res = await GRETA.put(R('cand-chloe'), Buffer.from('MZ\x90\x00 not a pdf at all'), 'application/pdf', 'resume.pdf');
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('Only PDF files can be attached as a résumé.');
    expect((await GRETA.get(R('cand-chloe'))).status).toBe(404);
    expect(pointer('cand-chloe')).toBeNull();
  });

  it('refuses another declared type, even for PDF bytes', async () => {
    expect((await GRETA.put(R('cand-chloe'), PDF, 'application/octet-stream')).status).toBe(415);
    expect((await GRETA.put(R('cand-chloe'), PDF, 'text/plain')).status).toBe(415);
    expect((await GRETA.put(R('cand-chloe'), JSON.stringify({ a: 1 }), 'application/json')).status).toBe(415);
  });

  it('refuses an empty body', async () => {
    const res = await GRETA.put(R('cand-chloe'), Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The file is empty. Choose the résumé again.');
  });

  it('refuses a body over the limit, and keeps the old résumé', async () => {
    const big = Buffer.alloc(RESUME_MAX_BYTES + 10, 0x20);
    Buffer.from('%PDF-1.4').copy(big);
    const res = await GRETA.put(R('cand-mateo'), big);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('That file is larger than 10 MB. Choose a smaller PDF.');
    expect((await GRETA.get(R('cand-mateo'))).body.resume.id).toBe('rf-mateo');
  });

  it('says so plainly when no storage is set up', async () => {
    setResumeStores({ bytes: new UnavailableResumeBytes() });
    const res = await GRETA.put(R('cand-chloe'), PDF);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Résumés cannot be stored here yet, so this file was not saved.');
    expect((await GRETA.get(R('cand-chloe'))).status).toBe(404);
    expect((await GRETA.get(`${R('cand-mateo')}/file`)).status).toBe(404);
  });
});

describe('only the recruiter writes', () => {
  it.each([['hiring manager', AMARA], ['interviewer', HUGO], ['other interviewer', WEN]])('%s is refused on a candidate they can open and on one they cannot', async (_n, who_) => {
    for (const id of ['cand-mateo', 'cand-aiko']) {
      expect((await who_.put(R(id), PDF)).status).toBe(403);
      expect((await who_.del(R(id))).status).toBe(403);
    }
    expect((await GRETA.get(R('cand-mateo'))).body.resume.id).toBe('rf-mateo');
  });
});

describe('delete', () => {
  it('removes the bytes and the row, clears the pointer, and a second delete is not found', async () => {
    const bytes = new MemoryResumeBytes();
    setResumeStores({ bytes });
    const up = (await GRETA.put(R('cand-chloe'), PDF)).body.resume;
    expect(await bytes.get(`interviews/resumes/cand-chloe/${up.id}.pdf`)).not.toBeNull();
    expect((await GRETA.del(R('cand-chloe'))).status).toBe(200);
    expect(await bytes.get(`interviews/resumes/cand-chloe/${up.id}.pdf`)).toBeNull();
    expect((await GRETA.get(R('cand-chloe'))).status).toBe(404);
    expect(pointer('cand-chloe')).toBeNull();
    expect((await GRETA.del(R('cand-chloe'))).status).toBe(404);
  });
});

describe('the flag', () => {
  it('with INTERVIEWS_ENABLED off every route is not found', async () => {
    process.env['INTERVIEWS_ENABLED'] = '0';
    expect((await GRETA.get(R('cand-mateo'))).status).toBe(404);
    expect((await GRETA.get(`${R('cand-mateo')}/file`)).status).toBe(404);
    expect((await GRETA.put(R('cand-mateo'), PDF)).status).toBe(404);
    expect((await GRETA.del(R('cand-mateo'))).status).toBe(404);
  });
});

// Hardening (H1, O-030 and O-031): uploads at their edges, and the browser-origin check as index.ts orders it.
describe('uploads at their edges', () => {
  it('two uploads at once leave one record, and the stored bytes are the ones that record names (O-030)', async () => {
    const a = buildSimplePdf(['First Person', 'Fictional headline', 'One line.']);
    const b = buildSimplePdf(['Second Person', 'Fictional headline', 'Another line.']);
    const both = await Promise.all([GRETA.put(R('cand-chloe'), a, 'application/pdf', 'a.pdf'), GRETA.put(R('cand-chloe'), b, 'application/pdf', 'b.pdf')]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const held = await readResume('cand-chloe');
    expect(held).not.toBeNull();
    expect(held!.resume.sha256).toBe(sha256Hex(held!.bytes));
    expect([sha256Hex(a), sha256Hex(b)]).toContain(held!.resume.sha256);
    expect(pointer('cand-chloe')).toBe(held!.resume.id);
    expect((await GRETA.get(`${R('cand-chloe')}/file`)).status).toBe(200);
  });

  // A request written by hand, so the declared length and the bytes actually sent can disagree.
  const raw = async (declared: number, sent: string): Promise<string> => {
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      return await new Promise<string>((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        let got = '';
        const finish = () => { sock.destroy(); resolve(got); };
        sock.on('data', (d) => { got += d.toString(); if (/\r\n\r\n/.test(got)) setTimeout(finish, 50); });
        sock.on('close', () => resolve(got));
        sock.on('error', () => resolve(got));
        sock.write(`PUT ${API}${R('cand-mateo')} HTTP/1.1\r\nHost: x\r\nx-user: u-greta\r\nx-tenant: interviews\r\nContent-Type: application/pdf\r\nContent-Length: ${declared}\r\n\r\n${sent}`);
        setTimeout(() => sock.end(), 150);
        setTimeout(finish, 2000);
      });
    } finally { server.close(); }
  };

  it('a Content-Length over the limit is refused before the body is read, whatever follows (O-030)', async () => {
    const answer = await raw(RESUME_MAX_BYTES + 1, '%PDF-1.4 tiny');
    expect(answer).toMatch(/^HTTP\/1\.1 413/);
    expect(answer).toContain('That file is larger than 10 MB. Choose a smaller PDF.');
    expect((await GRETA.get(R('cand-mateo'))).body.resume.id).toBe('rf-mateo');
  });

  it('a body cut short of its Content-Length never replaces the old résumé (O-030)', async () => {
    const answer = await raw(5000, '%PDF-1.4 only a few bytes');
    // The server either never answers a cut request or says the file could not be read; it does not store it.
    if (answer) expect(answer).toMatch(/^HTTP\/1\.1 (400|413)/);
    expect((await GRETA.get(R('cand-mateo'))).body.resume.id).toBe('rf-mateo');
  });

  it('a PDF by its first bytes that is corrupt inside is stored and read back as it came; the page says it cannot be shown (O-030)', async () => {
    const corrupt = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not a pdf body, only a header that looks like one')]);
    const put = await GRETA.put(R('cand-chloe'), corrupt, 'application/pdf', 'broken.pdf');
    expect(put.status).toBe(200);
    const file = await GRETA.get(`${R('cand-chloe')}/file`);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body as Buffer).equals(corrupt)).toBe(true);
    expect(file.headers['content-security-policy']).toBe('sandbox');
  });
});

describe('the browser-origin check, in the order index.ts mounts it (O-031)', () => {
  const guarded = express();
  guarded.use(browserOrigin);
  guarded.use(app);
  const put = (headers: Record<string, string>) => {
    let r = request(guarded).put(`${API}${R('cand-chloe')}`).set('x-user', 'u-greta').set('x-tenant', 'interviews').set('Content-Type', 'application/pdf');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(PDF as never);
  };

  it('refuses a PUT from another origin before the route runs, and stores nothing', async () => {
    const res = await put({ Origin: 'https://evil.example', Host: 'portal.test' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Browser origin is not allowed' });
    expect((await GRETA.get(R('cand-chloe'))).status).toBe(404);
  });

  it('lets the API\'s own origin and a caller with no Origin through', async () => {
    expect((await put({ Origin: 'http://portal.test', Host: 'portal.test' })).status).toBe(200);
    expect((await put({})).status).toBe(200);
  });
});
