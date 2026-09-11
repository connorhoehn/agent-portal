// KB registry admin — /api/admin/kb-registry (routes/kb-admin.ts), the fifteen
// routes the mock/delete suites do not reach: create, patch, provision, sync,
// the job + document lists, the landing zone, upload links and the reconcile
// adoption.
//
// What is pinned:
//   * ROUTE ORDER. Five literal paths (`/check`, `/reconcile`,
//     `/reconcile/adopt`, `/upload-links`, `/upload-links/:linkId/...`) sit
//     above `/:id`, and the landing-zone pair sits above it too. If any of
//     them slipped below, `/:id` would swallow it and answer "Knowledge base
//     not found" for a route that has nothing to do with an id,
//   * the create path's 409s: a duplicate slug or name is refused with a
//     READABLE message rather than letting the unique constraint surface as a
//     500, and nothing is provisioned when it is refused,
//   * that provisioning is FIRE-AND-FORGET — the route answers 201/202 without
//     awaiting it, and a background failure does not fail the request,
//   * `total` on /docs counts the documents shipped beside it,
//   * the two "not provisioned yet" branches, which differ on purpose: /sync
//     400s (you asked for something impossible) while /jobs answers an empty
//     list (there is simply nothing to list yet),
//   * the upload-link contract: the token is returned ONCE (only its hash is
//     stored) and an unlabelled link is refused rather than defaulted, because
//     an unlabelled link is untraceable exactly when you need to trace it,
//   * the SSE /status stream's terminal branches, which must close rather than
//     poll for six minutes.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: false, agentcore: false },
    // `knowledgeBase.id` is the env-pinned default the provider falls back to
    // when a caller names no kbId. Every call from this router names one — the
    // registry entry's own `bedrockKbId`, which is the point of the registry —
    // but the provider reads the default before it branches, so leaving the key
    // off made the read a TypeError rather than a fallback.
    knowledgeBase: { id: '', serviceRoleArn: '' },
  },
}));

const agentSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send(cmd: unknown) { return agentSend(cmd); } },
  GetKnowledgeBaseCommand: class { constructor(public readonly input: unknown) {} },
  ListDataSourcesCommand: class { constructor(public readonly input: unknown) {} },
  StartIngestionJobCommand: class { constructor(public readonly input: unknown) {} },
  ListIngestionJobsCommand: class { constructor(public readonly input: unknown) {} },
}));

jest.mock('../../providers/kb-registry.js', () => ({
  listKbs: jest.fn(), getKb: jest.fn(), getKbBySlug: jest.fn(),
  createKbEntry: jest.fn(), updateKbEntry: jest.fn(), deleteKbEntry: jest.fn(),
  provisionKb: jest.fn(), deprovisionKb: jest.fn(),
}));
jest.mock('../../providers/kb-reconcile.js', () => ({
  reconcileKnowledgeBases: jest.fn(), adoptKnowledgeBase: jest.fn(),
}));
jest.mock('../../providers/upload-links.js', () => ({
  createUploadLink: jest.fn(), listUploadLinks: jest.fn(),
  revokeUploadLink: jest.fn(), listLinkFiles: jest.fn(),
}));
jest.mock('../../providers/landing-zones.js', () => ({
  listLandingZoneFiles: jest.fn(), uploadToLandingZone: jest.fn(),
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/provisioning-broker.js', () => {
  const { EventEmitter } = jest.requireActual<typeof import('node:events')>('node:events');
  return { provisioningBroker: new EventEmitter() };
});

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { kbAdminRouter } from '../kb-admin.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listKbs, getKb, getKbBySlug, createKbEntry, updateKbEntry, provisionKb,
} from '../../providers/kb-registry.js';
import { adoptKnowledgeBase } from '../../providers/kb-reconcile.js';
import {
  createUploadLink, listUploadLinks, revokeUploadLink, listLinkFiles,
} from '../../providers/upload-links.js';
import { listLandingZoneFiles, uploadToLandingZone } from '../../providers/landing-zones.js';
import { exec } from '../../providers/aurora.js';
import { config } from '../../config.js';
import { fixtureRegistry } from '../../mock/core/index.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const KB = {
  id: 'kb-row-1', slug: 'orgiq-default', name: 'OrgIQ Default', tenant: 'orgiq',
  purpose: 'org docs', s3Prefix: 'orgiq/', status: 'ACTIVE',
  bedrockKbId: 'KB123', dataSourceId: 'DS123', errorMessage: null,
};

const SESSION = { sub: 'u-admin', role: 'hr-admin', tenant: 'orgiq' };

function buildApp(session: Record<string, unknown> | null = SESSION) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/admin/kb-registry', kbAdminRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(listKbs).mockResolvedValue([]);
  m(getKbBySlug).mockResolvedValue(null);
  m(provisionKb).mockResolvedValue(undefined);
});

// ── GET /check ─────────────────────────────────────────────────────────────

describe('GET /check', () => {
  it('resolves ABOVE /:id and reports both availabilities without creating anything', async () => {
    const res = await request(buildApp()).get('/api/admin/kb-registry/check?slug=new-kb&name=New%20KB');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort())
      .toEqual(['nameAvailable', 'nameConflict', 'slugAvailable', 'slugConflict']);
    expect(res.body.slugAvailable).toBe(true);
    expect(res.body.nameAvailable).toBe(true);
    // If /:id had swallowed it, getKb would have been asked for "check".
    expect(getKb).not.toHaveBeenCalled();
    expect(createKbEntry).not.toHaveBeenCalled();
  });

  it('names WHICH knowledge base is holding a taken slug or name', async () => {
    m(getKbBySlug).mockResolvedValue({ ...KB, name: 'OrgIQ Default' });
    m(listKbs).mockResolvedValue([{ ...KB, name: 'OrgIQ Default', slug: 'orgiq-default' }]);
    const res = await request(buildApp())
      .get('/api/admin/kb-registry/check?slug=orgiq-default&name=orgiq%20default');
    expect(res.body.slugAvailable).toBe(false);
    expect(res.body.slugConflict).toBe('OrgIQ Default');
    // Name matching is case-insensitive, and the conflict names the SLUG.
    expect(res.body.nameAvailable).toBe(false);
    expect(res.body.nameConflict).toBe('orgiq-default');
  });

  it('does not look anything up for an empty check', async () => {
    const res = await request(buildApp()).get('/api/admin/kb-registry/check');
    expect(res.body).toEqual({
      slugAvailable: true, nameAvailable: true, slugConflict: null, nameConflict: null,
    });
    expect(getKbBySlug).not.toHaveBeenCalled();
    expect(listKbs).not.toHaveBeenCalled();
  });
});

// ── POST / ─────────────────────────────────────────────────────────────────

describe('POST /', () => {
  const VALID = {
    name: 'Onboarding', slug: 'orgiq-onboarding', tenant: 'orgiq',
    purpose: 'new hire docs', s3Prefix: 'onboarding/',
  };

  it('validates every required field, and the slug\'s shape', async () => {
    const app = buildApp();
    const cases: Array<[Partial<typeof VALID>, RegExp]> = [
      [{ ...VALID, name: '  ' }, /name/],
      [{ ...VALID, slug: 'Not A Slug' }, /\^\[a-z0-9-\]\+\$/],
      [{ ...VALID, tenant: '' }, /tenant/],
      [{ ...VALID, purpose: '' }, /purpose/],
      [{ ...VALID, s3Prefix: '' }, /s3Prefix/],
    ];
    for (const [body, pattern] of cases) {
      const res = await request(app).post('/api/admin/kb-registry').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(pattern);
    }
    expect(createKbEntry).not.toHaveBeenCalled();
  });

  it('409s a duplicate slug with a readable message, provisioning nothing', async () => {
    m(getKbBySlug).mockResolvedValue({ ...KB, name: 'OrgIQ Default' });
    const res = await request(buildApp()).post('/api/admin/kb-registry').send(VALID);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already used by knowledge base "OrgIQ Default"/);
    expect(createKbEntry).not.toHaveBeenCalled();
    expect(provisionKb).not.toHaveBeenCalled();
  });

  it('409s a duplicate name case-insensitively', async () => {
    m(listKbs).mockResolvedValue([{ ...KB, name: 'ONBOARDING' }]);
    const res = await request(buildApp()).post('/api/admin/kb-registry').send(VALID);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Name "Onboarding" is already taken/);
    expect(createKbEntry).not.toHaveBeenCalled();
  });

  it('creates, trims, and kicks off provisioning WITHOUT awaiting it', async () => {
    m(createKbEntry).mockResolvedValue({ ...KB, id: 'kb-row-2', status: 'PENDING' });
    // A provisioning run that never settles must not hold the response.
    m(provisionKb).mockReturnValue(new Promise(() => {}));
    const res = await request(buildApp()).post('/api/admin/kb-registry')
      .send({ ...VALID, name: '  Onboarding  ', purpose: '  new hire docs  ' });
    expect(res.status).toBe(201);
    expect(res.body.kb.status).toBe('PENDING');
    expect(m(createKbEntry).mock.calls[0]![0]).toMatchObject({
      name: 'Onboarding', purpose: 'new hire docs', slug: 'orgiq-onboarding',
    });
    expect(provisionKb).toHaveBeenCalledWith('kb-row-2');
  });

  it('still answers 201 when the background provisioning rejects', async () => {
    m(createKbEntry).mockResolvedValue({ ...KB, id: 'kb-row-3', status: 'PENDING' });
    m(provisionKb).mockRejectedValue(new Error('OpenSearch collection quota'));
    const res = await request(buildApp()).post('/api/admin/kb-registry').send(VALID);
    expect(res.status).toBe(201);
  });
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────

describe('PATCH /:id', () => {
  it('404s an unknown row before validating anything', async () => {
    m(getKb).mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/admin/kb-registry/kb-x').send({ name: '' });
    expect(res.status).toBe(404);
    expect(updateKbEntry).not.toHaveBeenCalled();
  });

  it('refuses a blank name and a non-string description', async () => {
    m(getKb).mockResolvedValue(KB);
    const app = buildApp();
    const blankName = await request(app).patch('/api/admin/kb-registry/kb-row-1').send({ name: '   ' });
    expect(blankName.status).toBe(400);
    const badDesc = await request(app).patch('/api/admin/kb-registry/kb-row-1').send({ description: 7 });
    expect(badDesc.status).toBe(400);
    expect(badDesc.body.error).toMatch(/string or null/);
    expect(updateKbEntry).not.toHaveBeenCalled();
  });

  it('patches only the fields present, trimming the name', async () => {
    m(getKb).mockResolvedValue(KB);
    const res = await request(buildApp()).patch('/api/admin/kb-registry/kb-row-1')
      .send({ name: '  Renamed  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(updateKbEntry).toHaveBeenCalledWith('kb-row-1', { name: 'Renamed' });
  });

  it('reads null description as CLEAR, sending undefined rather than the null', async () => {
    m(getKb).mockResolvedValue(KB);
    await request(buildApp()).patch('/api/admin/kb-registry/kb-row-1').send({ description: null });
    expect(updateKbEntry).toHaveBeenCalledWith('kb-row-1', { description: undefined });
  });
});

// ── /reconcile/adopt ───────────────────────────────────────────────────────

describe('POST /reconcile/adopt', () => {
  it('requires both a slug and a kbId', async () => {
    const app = buildApp();
    for (const body of [{}, { slug: 'orgiq-default' }, { kbId: 'KB999' }]) {
      const res = await request(app).post('/api/admin/kb-registry/reconcile/adopt').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/slug and kbId/);
    }
    expect(adoptKnowledgeBase).not.toHaveBeenCalled();
  });

  it('repoints the row, and 502s when the adoption itself failed', async () => {
    m(adoptKnowledgeBase).mockResolvedValue({ ok: true, slug: 'orgiq-default', kbId: 'KB999', dataSourceId: 'DS999' });
    const ok = await request(buildApp()).post('/api/admin/kb-registry/reconcile/adopt')
      .send({ slug: 'orgiq-default', kbId: 'KB999' });
    expect(ok.status).toBe(200);
    // Adoption must capture the data source id too — repointing bedrockKbId
    // alone leaves a row that still rejects every sync.
    expect(ok.body.dataSourceId).toBe('DS999');

    m(adoptKnowledgeBase).mockResolvedValue({ ok: false, error: 'KB999 does not exist' });
    const failed = await request(buildApp()).post('/api/admin/kb-registry/reconcile/adopt')
      .send({ slug: 'orgiq-default', kbId: 'KB999' });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('KB999 does not exist');
  });
});

// ── Upload links ───────────────────────────────────────────────────────────

describe('upload links', () => {
  it('GET /upload-links resolves above /:id and filters by kbSlug', async () => {
    m(listUploadLinks).mockResolvedValue([{ id: 'ul-1', label: 'Vendor A' }]);
    const app = buildApp();
    await request(app).get('/api/admin/kb-registry/upload-links');
    await request(app).get('/api/admin/kb-registry/upload-links?kbSlug=orgiq-default');
    expect(m(listUploadLinks).mock.calls.map((c) => c[0])).toEqual([undefined, 'orgiq-default']);
    expect(getKb).not.toHaveBeenCalled();
  });

  it('POST /upload-links refuses an unlabelled link rather than defaulting one', async () => {
    // An unlabelled link is untraceable the moment there is more than one,
    // which is exactly when you need to know which one let something in.
    const app = buildApp();
    const noSlug = await request(app).post('/api/admin/kb-registry/upload-links').send({});
    expect(noSlug.status).toBe(400);
    expect(noSlug.body.error).toMatch(/kbSlug is required/);

    const noLabel = await request(app).post('/api/admin/kb-registry/upload-links')
      .send({ kbSlug: 'orgiq-default', label: '   ' });
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.error).toMatch(/name who this link is for/);
    expect(createUploadLink).not.toHaveBeenCalled();
  });

  it('POST /upload-links 404s a slug no knowledge base is registered under', async () => {
    m(getKbBySlug).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/admin/kb-registry/upload-links')
      .send({ kbSlug: 'ghost', label: 'Vendor A' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No knowledge base registered as "ghost"/);
    expect(createUploadLink).not.toHaveBeenCalled();
  });

  it('POST /upload-links records the session as creator and returns the token ONCE', async () => {
    m(getKbBySlug).mockResolvedValue(KB);
    m(createUploadLink).mockResolvedValue({
      link: { id: 'ul-2', label: 'Vendor A' }, token: 'raw-token-shown-once',
    });
    const res = await request(buildApp()).post('/api/admin/kb-registry/upload-links')
      .send({ kbSlug: 'orgiq-default', label: '  Vendor A  ', expiresInHours: 48, maxFiles: 5 });
    expect(res.status).toBe(201);
    expect(res.body.token).toBe('raw-token-shown-once');
    expect(m(createUploadLink).mock.calls[0]![0]).toEqual({
      kbSlug: 'orgiq-default', label: 'Vendor A', createdBy: 'u-admin',
      expiresInHours: 48, maxFiles: 5,
    });
  });

  it('POST /upload-links records a null creator for an unauthenticated caller', async () => {
    m(getKbBySlug).mockResolvedValue(KB);
    m(createUploadLink).mockResolvedValue({ link: {}, token: 't' });
    await request(buildApp(null)).post('/api/admin/kb-registry/upload-links')
      .send({ kbSlug: 'orgiq-default', label: 'Vendor A' });
    expect((m(createUploadLink).mock.calls[0]![0] as { createdBy: null }).createdBy).toBeNull();
  });

  it('GET /upload-links/:id/files wraps the files for THAT link', async () => {
    m(listLinkFiles).mockResolvedValue([{ key: 'orgiq/a.pdf', size: 12 }]);
    const res = await request(buildApp()).get('/api/admin/kb-registry/upload-links/ul-1/files');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['files']);
    expect(listLinkFiles).toHaveBeenCalledWith('ul-1');
  });

  it('DELETE /upload-links/:id 404s a link that was already revoked', async () => {
    m(revokeUploadLink).mockResolvedValue(false);
    const gone = await request(buildApp()).delete('/api/admin/kb-registry/upload-links/ul-x');
    expect(gone.status).toBe(404);
    expect(gone.body.error).toMatch(/No live upload link/);

    m(revokeUploadLink).mockResolvedValue(true);
    const ok = await request(buildApp()).delete('/api/admin/kb-registry/upload-links/ul-1');
    expect(ok.body).toEqual({ ok: true });
  });
});

// ── Landing zone ───────────────────────────────────────────────────────────

describe('landing zone', () => {
  it('GET /:id/landing-zone/files lists under the KB\'s OWN prefix, clamping the limit', async () => {
    m(getKb).mockResolvedValue(KB);
    m(listLandingZoneFiles).mockResolvedValue({ files: [], nextToken: null });
    const app = buildApp();
    await request(app).get('/api/admin/kb-registry/kb-row-1/landing-zone/files');
    await request(app).get('/api/admin/kb-registry/kb-row-1/landing-zone/files?limit=9999');
    await request(app).get('/api/admin/kb-registry/kb-row-1/landing-zone/files?limit=abc&nextToken=t1');
    expect(m(listLandingZoneFiles).mock.calls.map((c) => [c[0], (c[1] as { limit: number }).limit]))
      .toEqual([['orgiq/', 50], ['orgiq/', 200], ['orgiq/', 50]]);
    expect((m(listLandingZoneFiles).mock.calls[2]![1] as { continuationToken?: string })
      .continuationToken).toBe('t1');
    // No token means the key is absent, not undefined-valued.
    expect(Object.prototype.hasOwnProperty.call(
      m(listLandingZoneFiles).mock.calls[0]![1], 'continuationToken')).toBe(false);
  });

  it('404s the landing zone of an unknown KB', async () => {
    m(getKb).mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-x/landing-zone/files');
    expect(res.status).toBe(404);
    expect(listLandingZoneFiles).not.toHaveBeenCalled();
  });

  it('POST /:id/landing-zone/upload requires a filename and a non-empty body', async () => {
    m(getKb).mockResolvedValue(KB);
    const app = buildApp();
    const noName = await request(app).post('/api/admin/kb-registry/kb-row-1/landing-zone/upload')
      .set('Content-Type', 'text/markdown').send('x');
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/filename query parameter/);

    const empty = await request(app)
      .post('/api/admin/kb-registry/kb-row-1/landing-zone/upload?filename=a.md')
      .set('Content-Type', 'text/markdown').send('');
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/Empty file/);
    expect(uploadToLandingZone).not.toHaveBeenCalled();
  });

  it('uploads under the KB SLUG and echoes the stored key', async () => {
    m(getKb).mockResolvedValue(KB);
    m(uploadToLandingZone).mockResolvedValue({ key: 'orgiq/a.md', size: 7 });
    const res = await request(buildApp())
      .post('/api/admin/kb-registry/kb-row-1/landing-zone/upload?filename=%20a.md%20')
      .set('Content-Type', 'text/markdown').send('# hello');
    expect(res.status).toBe(200);
    expect(res.body.file).toEqual({ key: 'orgiq/a.md', size: 7, filename: 'a.md' });
    const [slug, filename, body, contentType] = m(uploadToLandingZone).mock.calls[0]!;
    expect(slug).toBe('orgiq-default');
    expect(filename).toBe('a.md');
    expect(String(body)).toBe('# hello');
    expect(contentType).toMatch(/text\/markdown/);
  });
});

// ── Provision / status / sync ──────────────────────────────────────────────

describe('POST /:id/provision', () => {
  it('404s an unknown KB and 409s one that is not PENDING or FAILED', async () => {
    m(getKb).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/admin/kb-registry/kb-x/provision').send({})).status).toBe(404);

    m(getKb).mockResolvedValue({ ...KB, status: 'ACTIVE' });
    const conflict = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/provision').send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/Cannot provision a KB in status "ACTIVE"/);
    expect(provisionKb).not.toHaveBeenCalled();
  });

  it('answers 202 ACCEPTED for a PENDING or FAILED row without awaiting the work', async () => {
    m(provisionKb).mockReturnValue(new Promise(() => {}));
    for (const status of ['PENDING', 'FAILED']) {
      jest.clearAllMocks();
      m(provisionKb).mockReturnValue(new Promise(() => {}));
      m(getKb).mockResolvedValue({ ...KB, status });
      const res = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/provision').send({});
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true, message: 'provisioning started', id: 'kb-row-1' });
      expect(provisionKb).toHaveBeenCalledWith('kb-row-1');
    }
  });
});

describe('GET /:id/status (SSE)', () => {
  it('emits a poll then completes and CLOSES for an ACTIVE row', async () => {
    m(getKb).mockResolvedValue(KB);
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/"type":"poll","status":"ACTIVE"/);
    expect(res.text).toMatch(/"type":"complete","kbId":"KB123"/);
  });

  it('reports the stored error message and closes for a FAILED row', async () => {
    m(getKb).mockResolvedValue({ ...KB, status: 'FAILED', errorMessage: 'OpenSearch quota exceeded' });
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/status');
    expect(res.text).toMatch(/"type":"failed"/);
    expect(res.text).toMatch(/OpenSearch quota exceeded/);
  });

  it('closes with an error for a row that is not in the registry', async () => {
    m(getKb).mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-x/status');
    expect(res.text).toMatch(/"type":"error"/);
    expect(res.text).toMatch(/KB registry entry not found/);
  });
});

describe('POST /:id/sync', () => {
  it('400s an unprovisioned KB — a sync needs BOTH ids', async () => {
    m(getKb).mockResolvedValue({ ...KB, dataSourceId: null });
    const res = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/sync').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: 'KB is not yet provisioned — bedrockKbId and dataSourceId are required for sync',
    });
    expect(agentSend).not.toHaveBeenCalled();
  });

  it('starts the job against the row\'s OWN pair and returns its id', async () => {
    m(getKb).mockResolvedValue(KB);
    agentSend.mockResolvedValue({ ingestionJob: { ingestionJobId: 'job-77' } });
    const res = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/sync')
      .send({ description: 'after the fix' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, jobId: 'job-77' });
    const input = (agentSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toEqual({
      knowledgeBaseId: 'KB123', dataSourceId: 'DS123', description: 'after the fix',
    });
  });

  it('500s when StartIngestionJob returned no job id', async () => {
    m(getKb).mockResolvedValue(KB);
    agentSend.mockResolvedValue({ ingestionJob: {} });
    const res = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/sync').send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'StartIngestionJob returned no jobId' });
  });

  it('answers a sync that is ALREADY RUNNING with 409 conflict, not a bare 500', async () => {
    // The reason this route was routed through the provider. It used to build
    // and send its own command, so an unhandled ConflictException reached
    // `asyncHandler`, which does not recognise it and answers 500 "Internal
    // server error" with the message dropped. The most alarming response the
    // platform can give, about the platform working correctly.
    m(getKb).mockResolvedValue(KB);
    agentSend.mockRejectedValue(Object.assign(
      new Error('An ingestion job is already in progress for this data source'),
      { name: 'ConflictException' },
    ));
    const res = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/sync').send({});
    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    // Names the state and the target, so the operator knows to wait rather than
    // to go reading logs.
    expect(res.body.error).toMatch(/already running on KB123\/DS123/);
    expect(res.body.error).not.toMatch(/Internal server error/);
  });

  it('does not name Bedrock as the culprit when the middleware lacks the grant', async () => {
    // 403 rather than 502: a missing IAM action is not a pipeline failure, and
    // the two send an operator to different places.
    m(getKb).mockResolvedValue(KB);
    agentSend.mockRejectedValue(Object.assign(
      new Error('is not authorized to perform: bedrock:StartIngestionJob'),
      { name: 'AccessDeniedException' },
    ));
    const res = await request(buildApp()).post('/api/admin/kb-registry/kb-row-1/sync').send({});
    expect(res.status).toBe(403);
    expect(res.body.conflict).toBe(false);
    expect(res.body.error).toMatch(/bedrock:StartIngestionJob/);
  });
});

describe('offline (MOCK_AGENTCORE), the two Bedrock-backed routes', () => {
  // This pair was the last KB surface with no mock branch, and it failed in the
  // shape docs/mock-floor.md calls the worst one: the page appeared to work.
  // Both handlers sent to Bedrock unconditionally, so under `dev:mock` they
  // reached the real account with whatever credentials the developer had —
  // verified by hand, an honest AccessDeniedException from a live STS role.
  // /sync surfaced it as a red banner and /jobs swallowed it into
  // `degraded({ jobs: [] })`, i.e. "this knowledge base has never synced". Net
  // effect: the Knowledge page's primary button could not be pressed offline,
  // and if it had been, nothing would have shown for it.
  //
  // `agentSend` is the assertion. It is the only way into the SDK from this
  // router, so "not called" is the whole claim.
  beforeEach(() => {
    (config as unknown as { mock: Record<string, boolean> }).mock.agentcore = true;
    // Offline the registry row IS a mock registry row, so it names the pair the
    // ingestion-job fixture is keyed on. `KB`'s KB123/DS123 are stand-ins for
    // the live path and match no fixture row — which is itself correct: a
    // second knowledge base in the registry has its own data source and an
    // honestly empty history, not this one's jobs.
    m(getKb).mockResolvedValue({
      ...KB, bedrockKbId: 'KBMOCK0001AB', dataSourceId: 'DSMOCK0001AB',
    });
  });
  afterEach(() => {
    (config as unknown as { mock: Record<string, boolean> }).mock.agentcore = false;
    fixtureRegistry.resetAll('default');
  });

  it('start a sync and it shows up in the history, with no AWS call either way', async () => {
    const app = buildApp();
    const before = await request(app).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(before.status).toBe(200);
    expect(before.body.jobs.length).toBeGreaterThan(0);
    // Not `degraded` — that flag is how a refused listing used to read, and it
    // is the difference between "Bedrock said no" and "nothing has run".
    expect(before.body.degraded).toBeUndefined();

    const started = await request(app).post('/api/admin/kb-registry/kb-row-1/sync').send({});
    expect(started.status).toBe(200);
    expect(started.body.jobId).toBeTruthy();

    const after = await request(app).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(after.body.jobs.length).toBe(before.body.jobs.length + 1);
    expect(after.body.jobs[0].jobId).toBe(started.body.jobId);
    expect(after.body.jobs[0].status).toBe('STARTING');

    // Pressing it again is the 409, reached by doing it — which is also the only
    // way an operator reaches it.
    const again = await request(app).post('/api/admin/kb-registry/kb-row-1/sync').send({});
    expect(again.status).toBe(409);
    expect(again.body.conflict).toBe(true);

    expect(agentSend).not.toHaveBeenCalled();
  });

  it('lists a job with the same keys the live path emits', async () => {
    // A key that exists offline but not online is how a mock stops being a
    // contract, so the two shapes are pinned against each other rather than
    // each against a hand-typed list.
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(Object.keys(res.body.jobs[0]!).sort()).toEqual([
      'dataSourceId', 'description', 'documentsDeleted', 'documentsFailed',
      'documentsIndexed', 'documentsScanned', 'durationMs', 'failureReasons',
      'jobId', 'startedAt', 'status', 'updatedAt',
    ]);
    expect(agentSend).not.toHaveBeenCalled();
  });
});

// ── Jobs + docs ────────────────────────────────────────────────────────────

describe('GET /:id/jobs', () => {
  it('answers an EMPTY list (not a 400) for a KB that has not provisioned yet', async () => {
    // Deliberately different from /sync: nothing has been asked for that
    // cannot happen, there is simply nothing to list.
    m(getKb).mockResolvedValue({ ...KB, bedrockKbId: null, dataSourceId: null });
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobs: [] });
    expect(agentSend).not.toHaveBeenCalled();
  });

  it('maps a job summary, summing NEW + MODIFIED as documentsIndexed', async () => {
    m(getKb).mockResolvedValue(KB);
    const startedAt = new Date('2026-08-20T09:00:00Z');
    const updatedAt = new Date('2026-08-20T09:02:30Z');
    agentSend.mockResolvedValue({
      ingestionJobSummaries: [{
        ingestionJobId: 'job-1', status: 'COMPLETE', startedAt, updatedAt,
        description: 'nightly',
        statistics: {
          numberOfDocumentsScanned: 163, numberOfNewDocumentsIndexed: 10,
          numberOfModifiedDocumentsIndexed: 5, numberOfDocumentsFailed: 1,
          numberOfDocumentsDeleted: 2,
        },
      }],
    });
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(res.body.jobs[0]).toEqual({
      jobId: 'job-1', dataSourceId: 'DS123', status: 'COMPLETE',
      startedAt: '2026-08-20T09:00:00.000Z', updatedAt: '2026-08-20T09:02:30.000Z',
      description: 'nightly', durationMs: 150_000,
      documentsScanned: 163, documentsIndexed: 15, documentsFailed: 1, documentsDeleted: 2,
      // Present and empty even though this job failed a document: the summary
      // shape Bedrock returns from ListIngestionJobs carries no reasons at all
      // (GetIngestionJob does, which is the portal's "details" button). It is
      // emitted so the mock branch and this path have one shape — a key that
      // exists offline but not online is how a mock stops being a contract —
      // and `toEqual` is doing its job by refusing to ignore it.
      failureReasons: [],
    });
  });

  it('zero-fills a summary with no statistics rather than emitting NaN', async () => {
    m(getKb).mockResolvedValue(KB);
    agentSend.mockResolvedValue({ ingestionJobSummaries: [{ ingestionJobId: 'job-2', status: 'STARTING' }] });
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(res.body.jobs[0].documentsScanned).toBe(0);
    expect(res.body.jobs[0].documentsIndexed).toBe(0);
    // No startedAt means no measurable duration, not a nonsense one.
    expect(res.body.jobs[0].durationMs).toBe(0);
  });

  it('clamps the limit into 1..100 and degrades to an empty list on a Bedrock error', async () => {
    m(getKb).mockResolvedValue(KB);
    agentSend.mockResolvedValue({ ingestionJobSummaries: [] });
    const app = buildApp();
    await request(app).get('/api/admin/kb-registry/kb-row-1/jobs');
    await request(app).get('/api/admin/kb-registry/kb-row-1/jobs?limit=9999');
    expect(agentSend.mock.calls.map((c) => (c[0] as { input: { maxResults: number } }).input.maxResults))
      .toEqual([20, 100]);

    // A KB that has genuinely never synced answers a plain empty list…
    const neverSynced = await request(app).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(neverSynced.body).toEqual({ jobs: [] });

    // …and a Bedrock refusal says so, because "never synced" is the opposite
    // diagnosis and this page exists to tell them apart.
    agentSend.mockRejectedValue(new Error('AccessDeniedException'));
    const degraded = await request(app).get('/api/admin/kb-registry/kb-row-1/jobs');
    expect(degraded.status).toBe(200);
    expect(degraded.body).toEqual({
      jobs: [], degraded: true, error: 'AccessDeniedException',
    });
  });
});

describe('GET /:id/docs', () => {
  it('scopes to the KB\'s OWN slug and reports a total that counts the rows', async () => {
    m(getKb).mockResolvedValue(KB);
    m(exec).mockResolvedValue([
      { id: 'd-1', source: 'adr', source_uri: 's3://x/1.md', title: 'ADR 1', ingested_at: '2026-08-20T09:00:00Z' },
      { id: 'd-2', source: null, source_uri: null, title: null, ingested_at: null },
    ]);
    const res = await request(buildApp()).get('/api/admin/kb-registry/kb-row-1/docs');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.documents.length);
    expect(res.body.documents[0]).toEqual({
      id: 'd-1', source: 'adr', sourceUri: 's3://x/1.md', title: 'ADR 1',
      ingestedAt: '2026-08-20T09:00:00Z',
    });
    // An unlabelled document keeps its nulls rather than becoming "null".
    expect(res.body.documents[1].title).toBeNull();
    const params = m(exec).mock.calls[0]![1] as Array<{ name: string; value: Record<string, unknown> }>;
    expect(params.find((p) => p.name === 'slug')!.value['stringValue']).toBe('orgiq-default');
    expect(String(m(exec).mock.calls[0]![0])).toMatch(/kb_registry_slug = :slug/);
  });

  it('clamps the limit into 1..500 and degrades to an empty list', async () => {
    m(getKb).mockResolvedValue(KB);
    m(exec).mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/admin/kb-registry/kb-row-1/docs');
    await request(app).get('/api/admin/kb-registry/kb-row-1/docs?limit=9999');
    const lims = m(exec).mock.calls.map((c) =>
      (c[1] as Array<{ name: string; value: Record<string, unknown> }>)
        .find((p) => p.name === 'lim')!.value['longValue']);
    expect(lims).toEqual([50, 500]);

    // An empty knowledge base is exactly the symptom an operator opens this
    // page to investigate, so `total: 0` must not be able to mean two things.
    const reallyEmpty = await request(app).get('/api/admin/kb-registry/kb-row-1/docs');
    expect(reallyEmpty.body).toEqual({ documents: [], total: 0 });

    m(exec).mockRejectedValue(new Error('column "kb_registry_slug" does not exist'));
    const degraded = await request(app).get('/api/admin/kb-registry/kb-row-1/docs');
    expect(degraded.status).toBe(200);
    expect(degraded.body).toEqual({
      documents: [], total: 0, degraded: true,
      error: 'column "kb_registry_slug" does not exist',
    });
  });

  it('404s the documents of an unknown KB', async () => {
    m(getKb).mockResolvedValue(null);
    expect((await request(buildApp()).get('/api/admin/kb-registry/kb-x/docs')).status).toBe(404);
  });
});
