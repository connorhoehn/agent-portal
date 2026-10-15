// Signed service envelopes on the machine callbacks (lane C4).
//
// The four agent/devbox callbacks (approvals, harness trace, assessment
// run-complete, lab) verify service-runtime's `verifyServiceRequest` envelope,
// keyed by the callback's existing secret, with a nonce bound into the
// audience. This suite is the judge for that contract:
//
//   1. CROSS-LANGUAGE — fixed vectors signed by service-runtime's TS signer and
//      by agents/_shared/callbacks.py verify here and re-sign byte for byte
//      (the Python suite test_service_envelope.py checks the same file), and
//      the devbox `lab` CLI's inline signer is verified live against a real
//      listening guard.
//   2. GUARD — valid envelope accepted; tampered body / method / target /
//      audience refused; replayed nonce refused; expired timestamp refused;
//      the legacy header accepted only while SERVICE_AUTH_LEGACY_HEADERS
//      allows it; unset-secret behaviour (open in dev, 503 in production,
//      serviceAuthOr never opens) unchanged.

import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signServiceRequest, verifyServiceRequest } from '@connorhoehn/service-runtime';
import {
  APPROVALS_SERVICE_AUTH,
  ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH,
  HARNESS_RUNNER_SERVICE_AUTH,
  HARNESS_TRACE_SERVICE_AUTH,
  LAB_CALLBACK_SERVICE_AUTH,
  LEGACY_HEADERS_ENV,
  SERVICE_NONCE_HEADER,
  captureRawBody,
  requireServiceAuth,
  resetServiceNonceCache,
  serviceAuthOr,
  type ServiceAuthSpec,
} from '../service-auth.js';

const REPO = join(__dirname, '../../../..');
const VECTORS = (JSON.parse(readFileSync(join(__dirname, 'fixtures/service-envelope-vectors.json'), 'utf8')) as {
  vectors: Array<{
    name: string; signedBy: 'ts' | 'py'; method: string; target: string; body: string;
    audience: string; serviceId: string; secret: string; nowSec: number; header: string;
  }>;
}).vectors;

const SECRET = 'shared-secret-value';
const ENV_VARS = [
  APPROVALS_SERVICE_AUTH, HARNESS_TRACE_SERVICE_AUTH, ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH,
  LAB_CALLBACK_SERVICE_AUTH, HARNESS_RUNNER_SERVICE_AUTH,
].map((s) => s.envVar);
const savedNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
  delete process.env[LEGACY_HEADERS_ENV];
  process.env['NODE_ENV'] = savedNodeEnv;
  resetServiceNonceCache();
  jest.restoreAllMocks();
});

function appFor(spec: ServiceAuthSpec, guard: RequestHandler = requireServiceAuth(spec)) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.all('/callback', guard, (_req, res) => { res.json({ ok: true }); });
  return app;
}

const nonce = () => randomBytes(18).toString('base64url');

interface Signed { headers: Record<string, string>; nonce: string }

function sign(
  spec: ServiceAuthSpec,
  req: { method: string; target: string; body?: string },
  over: { nonce?: string; audience?: string; serviceId?: string; secret?: string; nowMs?: number } = {},
): Signed {
  const n = over.nonce ?? nonce();
  if (over.nowMs !== undefined) jest.spyOn(Date, 'now').mockReturnValueOnce(over.nowMs);
  const header = signServiceRequest(req, {
    secret: over.secret ?? SECRET,
    serviceId: over.serviceId ?? spec.signed!.allowedServices[0]!,
    audience: over.audience ?? `${spec.signed!.audience}#${n}`,
  });
  return { headers: { [SERVICE_AUTH_HEADER]: header, [SERVICE_NONCE_HEADER]: n }, nonce: n };
}

const BODY = JSON.stringify({ agentId: 'orgiq-search', note: 'café ✓', n: 1 });

function post(app: express.Express, path: string, body: string, headers: Record<string, string>) {
  return request(app).post(path).set('content-type', 'application/json').set(headers).send(body);
}

// ── 1. cross-language contract ───────────────────────────────────────────────

describe('cross-language vectors (service-runtime TS ↔ agents/_shared/callbacks.py)', () => {
  it('covers both signers', () => {
    expect(new Set(VECTORS.map((v) => v.signedBy))).toEqual(new Set(['ts', 'py']));
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))('%s verifies in TS and re-signs byte for byte', (_n, v) => {
    const req = { method: v.method, target: v.target, body: v.body };
    expect(verifyServiceRequest(v.header, req, {
      secret: v.secret, allowedServices: [v.serviceId], audience: v.audience, nowMs: v.nowSec * 1000,
    })).toEqual({ ok: true, serviceId: v.serviceId });
    jest.spyOn(Date, 'now').mockReturnValueOnce(v.nowSec * 1000 + 500);
    expect(signServiceRequest(req, { secret: v.secret, serviceId: v.serviceId, audience: v.audience })).toBe(v.header);
  });
});

describe('the devbox lab CLI signs envelopes the guard accepts (live, bash + python3)', () => {
  const LAB = join(REPO, 'agents/devbox/lab');

  function runLab(base: string, args: string[], env: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('bash', [LAB, ...args], {
        env: { PATH: process.env['PATH'] ?? '', LAB_API_BASE: base, LAB_REPO: 'orgiq core', ...env }, timeout: 20_000,
      }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
    });
  }

  it('POST and GET both pass with the legacy header refused, and a replay of the captured POST fails', async () => {
    process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = 'lab-secret';
    process.env[LEGACY_HEADERS_ENV] = 'refuse';
    const seen: Array<{ method: string; headers: Record<string, unknown>; raw: string; status?: number }> = [];
    const app = express();
    app.use(express.json({ verify: captureRawBody }));
    const guard = requireServiceAuth(LAB_CALLBACK_SERVICE_AUTH);
    app.use((req, res, next) => {
      const entry = { method: req.method, headers: { ...req.headers }, raw: ((req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)).toString('utf8') };
      seen.push(entry);
      res.on('finish', () => { (entry as { status?: number }).status = res.statusCode; });
      next();
    });
    app.post('/api/lab/experiences', guard, (_req, res) => { res.status(201).json({ experience: { id: 'x-1' } }); });
    app.get('/api/lab/experiences', guard, (_req, res) => { res.json({ experiences: [] }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await runLab(base, ['remember', 'gotcha', 'tab\there "quoted" ü', 'body ✓'], { LAB_CALLBACK_SECRET: 'lab-secret\n', SERVICE_AUTH_LEGACY_HEADERS: 'refuse' });
      const recall = await runLab(base, ['recall'], { LAB_CALLBACK_SECRET: 'lab-secret', SERVICE_AUTH_LEGACY_HEADERS: 'refuse' });
      expect(recall).toContain('No fleet memory');
      expect(seen.map((s) => [s.method, s.status])).toEqual([['POST', 201], ['GET', 200]]);
      expect(seen[0]!.headers['x-lab-auth']).toBeUndefined();

      // The exact captured POST, replayed: same envelope, same nonce, same bytes.
      const first = seen[0]!;
      const replay = await fetch(`${base}/api/lab/experiences`, {
        method: 'POST', body: first.raw,
        headers: {
          'content-type': 'application/json',
          [SERVICE_AUTH_HEADER]: String(first.headers['x-service-auth']),
          [SERVICE_NONCE_HEADER]: String(first.headers[SERVICE_NONCE_HEADER]),
        },
      });
      expect(replay.status).toBe(401);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

const VENV_PY = join(REPO, '.venv-synth/bin/python');
(existsSync(VENV_PY) ? describe : describe.skip)('agents/_shared/callbacks.py signs envelopes the guard accepts (live)', () => {
  it('post_run_complete passes a locked guard with the legacy header refused', async () => {
    process.env[ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH.envVar] = 'run-secret';
    process.env[LEGACY_HEADERS_ENV] = 'refuse';
    const app = express();
    app.use(express.json({ verify: captureRawBody }));
    app.post('/api/assessment/runs/:runId/complete', requireServiceAuth(ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH),
      (req, res) => { res.json({ id: req.params['runId'], echoed: req.body }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(join(REPO, 'agents'))})`,
      'from _shared import callbacks as cb',
      'r = cb.post_run_complete("run-9", status="failed", error="boom ✗", middleware_url=sys.argv[1])',
      'print(json.dumps(r))',
    ].join('\n');
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(VENV_PY, ['-c', script, base], {
          env: { ASSESSMENT_RUN_COMPLETE_SECRET: 'run-secret', SERVICE_AUTH_LEGACY_HEADERS: 'refuse' }, timeout: 20_000,
        }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
      });
      const result = JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; run: { echoed: { error: string } } };
      expect(result.ok).toBe(true);
      expect(result.run.echoed.error).toBe('boom ✗');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── 2. guard contract ────────────────────────────────────────────────────────

const SIGNED_SPECS: Array<[string, ServiceAuthSpec]> = [
  ['approvals', APPROVALS_SERVICE_AUTH],
  ['harness trace', HARNESS_TRACE_SERVICE_AUTH],
  ['assessment run complete', ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH],
  ['lab', LAB_CALLBACK_SERVICE_AUTH],
];

describe.each(SIGNED_SPECS)('%s — signed envelope', (_name, spec) => {
  beforeEach(() => { process.env[spec.envVar] = SECRET; });

  it('accepts a valid envelope on POST (exact body) and GET (query included)', async () => {
    const app = appFor(spec);
    const p = sign(spec, { method: 'POST', target: '/callback', body: BODY });
    expect((await post(app, '/callback', BODY, p.headers)).status).toBe(200);
    const g = sign(spec, { method: 'GET', target: '/callback?x=1&y=%20' });
    expect((await request(app).get('/callback?x=1&y=%20').set(g.headers)).status).toBe(200);
  });

  it('refuses a tampered body, method, target or audience', async () => {
    const app = appFor(spec);
    const base = { method: 'POST', target: '/callback', body: BODY };
    // body: one byte of whitespace changes nothing JSON-wise but everything MAC-wise
    expect((await post(app, '/callback', `${BODY} `, sign(spec, base).headers)).status).toBe(401);
    // method
    expect((await request(app).put('/callback').set('content-type', 'application/json')
      .set(sign(spec, base).headers).send(BODY)).status).toBe(401);
    // target
    expect((await post(app, '/callback?extra=1', BODY, sign(spec, base).headers)).status).toBe(401);
    // audience: another callback's audience, and a nonce header swapped after signing
    const other = SIGNED_SPECS.find(([, s]) => s !== spec)![1];
    const n = nonce();
    expect((await post(app, '/callback', BODY,
      sign(spec, base, { nonce: n, audience: `${other.signed!.audience}#${n}` }).headers)).status).toBe(401);
    const swapped = sign(spec, base);
    expect((await post(app, '/callback', BODY, { ...swapped.headers, [SERVICE_NONCE_HEADER]: nonce() })).status).toBe(401);
    // a service id this route does not allow, and the wrong secret
    expect((await post(app, '/callback', BODY, sign(spec, base, { serviceId: 'someone-else' }).headers)).status).toBe(401);
    expect((await post(app, '/callback', BODY, sign(spec, base, { secret: 'wrong' }).headers)).status).toBe(401);
  });

  it('refuses a replayed nonce, even within the time window', async () => {
    const app = appFor(spec);
    const s = sign(spec, { method: 'POST', target: '/callback', body: BODY });
    expect((await post(app, '/callback', BODY, s.headers)).status).toBe(200);
    expect((await post(app, '/callback', BODY, s.headers)).status).toBe(401);
  });

  it('a nonce spent by a forged request is still usable by the real one (MAC before nonce)', async () => {
    const app = appFor(spec);
    const n = nonce();
    const real = sign(spec, { method: 'POST', target: '/callback', body: BODY }, { nonce: n });
    const forged = sign(spec, { method: 'POST', target: '/callback', body: BODY }, { nonce: n, secret: 'attacker' });
    expect((await post(app, '/callback', BODY, forged.headers)).status).toBe(401);
    expect((await post(app, '/callback', BODY, real.headers)).status).toBe(200);
  });

  it('refuses an expired timestamp and a far-future one', async () => {
    const app = appFor(spec);
    const req = { method: 'POST', target: '/callback', body: BODY };
    expect((await post(app, '/callback', BODY, sign(spec, req, { nowMs: Date.now() - 61_000 }).headers)).status).toBe(401);
    expect((await post(app, '/callback', BODY, sign(spec, req, { nowMs: Date.now() + 30_000 }).headers)).status).toBe(401);
  });

  it('refuses a missing or malformed nonce', async () => {
    const app = appFor(spec);
    const s = sign(spec, { method: 'POST', target: '/callback', body: BODY }, { nonce: 'short' });
    expect((await post(app, '/callback', BODY, s.headers)).status).toBe(401);
    const t = sign(spec, { method: 'POST', target: '/callback', body: BODY });
    expect((await post(app, '/callback', BODY, { [SERVICE_AUTH_HEADER]: t.headers[SERVICE_AUTH_HEADER]! })).status).toBe(401);
  });

  it('legacy header: accepted by default and with `accept`, refused with `refuse`', async () => {
    const app = appFor(spec);
    expect((await post(app, '/callback', BODY, { [spec.header]: SECRET })).status).toBe(200);
    process.env[LEGACY_HEADERS_ENV] = 'accept';
    expect((await post(app, '/callback', BODY, { [spec.header]: SECRET })).status).toBe(200);
    process.env[LEGACY_HEADERS_ENV] = ' Refuse\n';
    expect((await post(app, '/callback', BODY, { [spec.header]: SECRET })).status).toBe(401);
    // ...while the envelope keeps working.
    expect((await post(app, '/callback', BODY, sign(spec, { method: 'POST', target: '/callback', body: BODY }).headers)).status).toBe(200);
  });

  it('a present envelope decides alone: a bad one is not rescued by a valid legacy header', async () => {
    const app = appFor(spec);
    const bad = sign(spec, { method: 'POST', target: '/callback', body: BODY }, { secret: 'wrong' });
    expect((await post(app, '/callback', BODY, { ...bad.headers, [spec.header]: SECRET })).status).toBe(401);
  });

  it('UNSET secret: still open outside production, still 503 in production', async () => {
    delete process.env[spec.envVar];
    const app = appFor(spec);
    expect((await post(app, '/callback', BODY, {})).status).toBe(200);
    process.env['NODE_ENV'] = 'production';
    const s = sign(spec, { method: 'POST', target: '/callback', body: BODY });
    expect((await post(app, '/callback', BODY, s.headers)).status).toBe(503);
  });
});

describe('serviceAuthOr with a signed spec (approval long-poll)', () => {
  const human: RequestHandler = (_req, res) => { res.status(401).json({ error: 'Unauthenticated' }); };

  it('a valid envelope passes; anything else falls through to the human chain', async () => {
    process.env[APPROVALS_SERVICE_AUTH.envVar] = SECRET;
    const app = appFor(APPROVALS_SERVICE_AUTH, serviceAuthOr(APPROVALS_SERVICE_AUTH, human));
    const g = sign(APPROVALS_SERVICE_AUTH, { method: 'GET', target: '/callback' });
    expect((await request(app).get('/callback').set(g.headers)).status).toBe(200);
    expect((await request(app).get('/callback').set(g.headers)).status).toBe(401); // replay → human → 401
    expect((await request(app).get('/callback')).status).toBe(401);
  });

  it('never opens on an unset secret, envelope or not', async () => {
    const app = appFor(APPROVALS_SERVICE_AUTH, serviceAuthOr(APPROVALS_SERVICE_AUTH, human));
    const g = sign(APPROVALS_SERVICE_AUTH, { method: 'GET', target: '/callback' });
    expect((await request(app).get('/callback').set(g.headers)).status).toBe(401);
  });
});

describe('unsigned specs are untouched by the transition flag', () => {
  it('the harness runner header still passes with SERVICE_AUTH_LEGACY_HEADERS=refuse', async () => {
    process.env[HARNESS_RUNNER_SERVICE_AUTH.envVar] = SECRET;
    process.env[LEGACY_HEADERS_ENV] = 'refuse';
    const app = appFor(HARNESS_RUNNER_SERVICE_AUTH);
    expect((await post(app, '/callback', BODY, { [HARNESS_RUNNER_SERVICE_AUTH.header]: SECRET })).status).toBe(200);
  });
});

describe('constant-time comparisons', () => {
  it('the legacy compare is timingSafeEqual and the envelope goes through service-runtime', () => {
    const src = readFileSync(join(__dirname, '../service-auth.ts'), 'utf8');
    expect(src).toMatch(/timingSafeEqual\(a, b\)/);
    expect(src).toMatch(/verifyServiceRequest\(/);
    // service-runtime's verifier compares MACs with timingSafeEqual; the
    // Python mirror uses hmac.compare_digest.
    const py = readFileSync(join(REPO, 'agents/_shared/callbacks.py'), 'utf8');
    expect(py).toMatch(/hmac\.compare_digest\(/);
  });
});
