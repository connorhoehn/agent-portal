// Public drop — /api/drop (routes/drop.ts). The ONLY unauthenticated write
// surface in the app: the token in the URL is the entire authority, so the
// two properties worth pinning are what it refuses to reveal and what it
// refuses to accept.
//
// What is pinned:
//   * NO LEAKAGE. The description a recipient gets names the link's purpose
//     and its remaining allowance — never a bucket, a prefix, a knowledge-base
//     id, or a way to list what is already there. Someone holding a drop link
//     has no reason to learn the storage layout,
//   * the refusal→status map, which is the difference between "you can fix
//     this" and "you cannot": 404 unknown, 410 gone (revoked/expired), 409
//     exhausted, 413 too large, 415 wrong type, 400 empty,
//   * the same answer for a malformed, unknown and deleted token — a
//     distinguishable 404 is an oracle for guessing tokens,
//   * that the throttle runs BEFORE the body parser, so a flood is refused
//     without first buffering up to 50 MB into heap,
//   * the success envelope: filename and byte count echoed, and nothing about
//     where the file went.

jest.mock('../../providers/upload-links.js', () => ({
  describeLinkForRecipient: jest.fn(), uploadViaLink: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { dropRouter } from '../drop.js';
import { errorHandler } from '../../lib/async-handler.js';
import { describeLinkForRecipient, uploadViaLink } from '../../providers/upload-links.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const VIEW = {
  label: 'Vendor A onboarding docs',
  destination: 'orgiq-onboarding',
  status: 'live',
  expiresAt: '2026-09-01T00:00:00Z',
  filesRemaining: 4,
  maxBytes: 10_000_000,
  allowedExtensions: ['.md', '.pdf', '.txt'],
};

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/drop', dropRouter);
  app.use(errorHandler);
  return app;
}

// Each test uses its own client ip so the in-process throttle (60/min, keyed
// on the proxy-verified client address) never bleeds between cases.
let ipCounter = 0;
const nextIp = () => `10.0.0.${(ipCounter += 1) % 250}`;

beforeEach(() => { jest.clearAllMocks(); });

describe('GET /api/drop/:token', () => {
  it('describes the link WITHOUT naming any storage location', async () => {
    m(describeLinkForRecipient).mockResolvedValue(VIEW);
    const res = await request(buildApp()).get('/api/drop/tok-1')
      .set('x-forwarded-for', nextIp());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'allowedExtensions', 'destination', 'expiresAt', 'filesRemaining', 'label', 'maxBytes', 'status',
    ]);
    // `destination` is the registry slug, deliberately not an S3 path.
    expect(res.body.destination).toBe('orgiq-onboarding');
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['s3://', 'bucket', 'prefix', 'knowledgeBase', 'arn:']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('tells the recipient what they may still send', async () => {
    m(describeLinkForRecipient).mockResolvedValue({ ...VIEW, filesRemaining: 0 });
    const res = await request(buildApp()).get('/api/drop/tok-1')
      .set('x-forwarded-for', nextIp());
    // An exhausted link says so up front rather than only on the failed upload.
    expect(res.body.filesRemaining).toBe(0);
    expect(res.body.allowedExtensions).toContain('.md');
  });

  it('gives the SAME answer for a malformed, unknown and deleted token', async () => {
    m(describeLinkForRecipient).mockResolvedValue(null);
    const app = buildApp();
    const bodies: unknown[] = [];
    for (const token of ['not-a-token', 'a'.repeat(64), '../etc/passwd']) {
      const res = await request(app).get(`/api/drop/${encodeURIComponent(token)}`)
        .set('x-forwarded-for', nextIp());
      expect(res.status).toBe(404);
      bodies.push(res.body);
    }
    // A distinguishable response would be an oracle for guessing tokens.
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: 'This upload link is not valid.' });
  });
});

describe('POST /api/drop/:token/upload', () => {
  it('requires a filename before anything is stored', async () => {
    const res = await request(buildApp()).post('/api/drop/tok-1/upload')
      .set('x-forwarded-for', nextIp())
      .set('Content-Type', 'text/markdown').send('# hi');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filename query parameter/);
    expect(uploadViaLink).not.toHaveBeenCalled();
  });

  it('passes the raw bytes and the declared type to the provider, trimming the name', async () => {
    m(uploadViaLink).mockResolvedValue({ ok: true, key: 'orgiq-onboarding/a.md', bytes: 4 });
    const res = await request(buildApp())
      .post('/api/drop/tok-1/upload?filename=%20a.md%20')
      .set('x-forwarded-for', nextIp())
      .set('Content-Type', 'text/markdown').send('# hi');
    expect(res.status).toBe(200);
    const [token, filename, body, contentType] = m(uploadViaLink).mock.calls[0]!;
    expect(token).toBe('tok-1');
    expect(filename).toBe('a.md');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(contentType).toMatch(/text\/markdown/);
  });

  it('echoes the filename and byte count, and NOT where the file went', async () => {
    m(uploadViaLink).mockResolvedValue({ ok: true, key: 'orgiq-onboarding/a.md', bytes: 4 });
    const res = await request(buildApp())
      .post('/api/drop/tok-1/upload?filename=a.md')
      .set('x-forwarded-for', nextIp())
      .set('Content-Type', 'text/markdown').send('# hi');
    expect(res.body).toEqual({ ok: true, filename: 'a.md', bytes: 4 });
    expect(JSON.stringify(res.body)).not.toContain('orgiq-onboarding/a.md');
  });

  it('maps each refusal onto the status that says whether the sender can act', async () => {
    const app = buildApp();
    const expected: Array<[string, number]> = [
      ['unknown-link', 404],
      ['revoked', 410],
      ['expired', 410],
      ['exhausted', 409],
      ['too-large', 413],
      ['bad-type', 415],
      ['empty', 400],
    ];
    for (const [refusal, status] of expected) {
      m(uploadViaLink).mockResolvedValue({ ok: false, refusal, detail: `refused: ${refusal}` });
      const res = await request(app).post('/api/drop/tok-1/upload?filename=a.md')
        .set('x-forwarded-for', nextIp())
        .set('Content-Type', 'text/markdown').send('x');
      expect([refusal, res.status]).toEqual([refusal, status]);
      // The reason travels with the code so the sender knows what to change.
      expect(res.body).toEqual({ error: `refused: ${refusal}`, refusal });
    }
  });

  it('falls back to 400 for a refusal the map does not know', async () => {
    m(uploadViaLink).mockResolvedValue({ ok: false, refusal: 'something-new', detail: 'nope' });
    const res = await request(buildApp()).post('/api/drop/tok-1/upload?filename=a.md')
      .set('x-forwarded-for', nextIp())
      .set('Content-Type', 'text/markdown').send('x');
    expect(res.status).toBe(400);
  });

  it('throttles a flood at 429 BEFORE the body is buffered or the link is read', async () => {
    // Checking inside the handler meant express.raw had already buffered up to
    // 50 MB before the request was refused.
    m(uploadViaLink).mockResolvedValue({ ok: true, key: 'k', bytes: 1 });
    const app = buildApp();
    const ip = nextIp();
    let limited: { status: number; body: { error?: string } } | null = null;
    for (let i = 0; i < 70; i += 1) {
      const res = await request(app).post('/api/drop/tok-1/upload?filename=a.md')
        .set('x-forwarded-for', ip)
        .set('Content-Type', 'text/markdown').send('x');
      if (res.status === 429) { limited = res; break; }
    }
    expect(limited).not.toBeNull();
    expect(limited!.body.error).toMatch(/Too many requests/);
    // At most the 60 permitted uploads reached the provider.
    expect(m(uploadViaLink).mock.calls.length).toBeLessThanOrEqual(60);
  });

  it('throttles per client, so one flooder does not lock everyone else out', async () => {
    m(describeLinkForRecipient).mockResolvedValue(VIEW);
    const app = buildApp();
    const noisy = nextIp();
    for (let i = 0; i < 70; i += 1) {
      await request(app).get('/api/drop/tok-1').set('x-forwarded-for', noisy);
    }
    const quiet = await request(app).get('/api/drop/tok-1').set('x-forwarded-for', nextIp());
    expect(quiet.status).toBe(200);
  });
});
