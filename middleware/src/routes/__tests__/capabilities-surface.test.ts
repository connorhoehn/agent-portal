// Capabilities — /api/capabilities (routes/capabilities.ts), the seventeen
// routes the gate suite (capabilities-mutation-gate.test.ts) does not reach:
// code-interpreter sessions, browser microVM sessions, the journey ring, the
// vision Q&A, the doc-discovery crawler and the id reconciler.
//
// That sibling file pins WHICH Cedar action each mutation asks for. This one
// pins what the routes DO — every one of them spends real AWS money, so the
// "did it actually happen" assertions matter:
//
//   * the wire envelopes the capabilities dashboard reads (`{sessions}`,
//     `{steps}`, `{crawls}`, `{crawl}`, `{ok, session, imageDataUrl}`),
//   * that launching a browser session with a URL actually NAVIGATES to it.
//     createBrowserSession used to echo the URL back without visiting it, so
//     the user had to retype it in the Navigate panel — and that a failed
//     auto-navigate still returns the session rather than 500ing,
//   * that a capability event is RECORDED for every billable action, with the
//     ok/error flag matching what happened — the capability-events feed is the
//     only record that a microVM was started,
//   * `/reconcile` — the route that exists because after a stack rebuild every
//     id in .env.aws pointed at a resource that no longer existed and each one
//     failed somewhere far from the cause,
//   * the refusal branches: 400 for empty code / missing url+question, 404 for
//     a dead session or crawl, 502 for a navigate that failed inside web-qa.

const gateActions: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', guardrail: { id: 'gr-test' } },
}));

const converseSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { send(cmd: unknown) { return converseSend(cmd); } },
  ConverseCommand: class { constructor(public readonly input: unknown) {} },
}));

jest.mock('../../lib/crawler.js', () => ({
  startCrawl: jest.fn(), getCrawl: jest.fn(), listCrawls: jest.fn(),
  cancelCrawl: jest.fn(), subscribeCrawl: jest.fn(),
}));
jest.mock('../../lib/invocations.js', () => ({
  recordCapabilityEvent: jest.fn(), snippet: (s: string, n: number) => String(s).slice(0, n),
  appendJourneyStep: jest.fn(), getJourney: jest.fn(), clearJourney: jest.fn(),
}));
// A minimal real SSE so the stream routes actually terminate under supertest
// (the shipped initSSE installs a 25s heartbeat interval).
jest.mock('../../lib/sse.js', () => ({
  initSSE: (res: { writeHead: (n: number, h: Record<string, string>) => void }) =>
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }),
  writeSSE: (res: { writableEnded: boolean; write: (s: string) => void }, data: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  },
  endSSE: (res: { writableEnded: boolean; end: () => void }) => { if (!res.writableEnded) res.end(); },
}));
jest.mock('../../providers/capability-reconcile.js', () => ({ reconcileCapabilities: jest.fn() }));
jest.mock('../../providers/index.js', () => ({
  guardrails: {
    getGuardrail: jest.fn(), togglePiiFilter: jest.fn(), updateDeniedTopic: jest.fn(),
    addDeniedTopic: jest.fn(), removeDeniedTopic: jest.fn(),
  },
  agentcore: {
    listCodeSessions: jest.fn(), terminateCodeSession: jest.fn(), executeCode: jest.fn(),
    listBrowserSessions: jest.fn(), createBrowserSession: jest.fn(),
    closeBrowserSession: jest.fn(), navigateBrowser: jest.fn(), screenshotBrowser: jest.fn(),
  },
  cloudwatch: { getGuardrailMetrics: jest.fn() },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { capabilitiesRouter } from '../capabilities.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore, cloudwatch } from '../../providers/index.js';
import { recordCapabilityEvent, getJourney, clearJourney, appendJourneyStep } from '../../lib/invocations.js';
import { startCrawl, getCrawl, listCrawls, cancelCrawl, subscribeCrawl } from '../../lib/crawler.js';
import { reconcileCapabilities } from '../../providers/capability-reconcile.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;
const ac = agentcore as unknown as Record<string, jest.Mock>;
const events = () => m(recordCapabilityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

const PNG = 'data:image/png;base64,aGVsbG8=';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/capabilities', capabilitiesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(getJourney).mockReturnValue([]);
  m(listCrawls).mockReturnValue([]);
  m(subscribeCrawl).mockReturnValue(() => {});
});

// ── Guardrail metrics ──────────────────────────────────────────────────────

describe('GET /guardrail/metrics', () => {
  it('asks CloudWatch about the CONFIGURED guardrail with a 24h default', async () => {
    m(cloudwatch.getGuardrailMetrics).mockResolvedValue({ invocations: 12, interventions: 3 });
    const res = await request(buildApp()).get('/api/capabilities/guardrail/metrics');
    expect(res.status).toBe(200);
    expect(cloudwatch.getGuardrailMetrics).toHaveBeenCalledWith('gr-test', 24);
    expect(res.body.interventions).toBe(3);
  });

  it('clamps hours into 1..168 and falls back to 24 on junk', async () => {
    m(cloudwatch.getGuardrailMetrics).mockResolvedValue({});
    const app = buildApp();
    await request(app).get('/api/capabilities/guardrail/metrics?hours=1');
    await request(app).get('/api/capabilities/guardrail/metrics?hours=99999');
    await request(app).get('/api/capabilities/guardrail/metrics?hours=abc');
    expect(m(cloudwatch.getGuardrailMetrics).mock.calls.map((c) => c[1])).toEqual([1, 168, 24]);
  });
});

// ── Code interpreter ───────────────────────────────────────────────────────

describe('code interpreter', () => {
  it('GET /code-sessions wraps the live sessions', async () => {
    ac['listCodeSessions']!.mockResolvedValue([{ sessionId: 'ci-1', status: 'READY' }]);
    const res = await request(buildApp()).get('/api/capabilities/code-sessions');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['sessions']);
    expect(res.body.sessions[0].sessionId).toBe('ci-1');
  });

  it('POST /code-interpreter/execute 400s empty code BEFORE spending a session', async () => {
    const app = buildApp();
    for (const body of [{}, { code: '' }, { code: '   ' }, { code: 42 }]) {
      const res = await request(app).post('/api/capabilities/code-interpreter/execute').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/code \(string\)/);
    }
    expect(ac['executeCode']).not.toHaveBeenCalled();
    expect(recordCapabilityEvent).not.toHaveBeenCalled();
  });

  it('executes, defaults the language to python, and records a successful event', async () => {
    ac['executeCode']!.mockResolvedValue({
      sessionId: 'ci-2', output: '42\n', durationMs: 310, error: null,
    });
    const res = await request(buildApp()).post('/api/capabilities/code-interpreter/execute')
      .send({ code: 'print(6*7)' });
    expect(res.status).toBe(200);
    expect(res.body.output).toBe('42\n');
    expect(ac['executeCode']).toHaveBeenCalledWith('print(6*7)', 'python');

    const ev = events()[0]!;
    expect(ev['kind']).toBe('code_execute');
    expect(ev['ok']).toBe(true);
    expect(ev['sessionId']).toBe('ci-2');
    expect(ev['durationMs']).toBe(310);
    expect((ev['detail'] as Record<string, unknown>)['language']).toBe('python');
  });

  it('records ok:false with the reason when the execution errored', async () => {
    ac['executeCode']!.mockResolvedValue({
      sessionId: 'ci-3', output: '', durationMs: 12, error: 'NameError: x',
    });
    const res = await request(buildApp()).post('/api/capabilities/code-interpreter/execute')
      .send({ code: 'x' });
    // The HTTP call succeeded; the CODE failed. Those are different things and
    // the event is where the second one is recorded.
    expect(res.status).toBe(200);
    expect(events()[0]!['ok']).toBe(false);
    expect(events()[0]!['error']).toBe('NameError: x');
  });
});

// ── Browser sessions ───────────────────────────────────────────────────────

describe('browser sessions', () => {
  it('GET /browser-sessions wraps the live microVMs', async () => {
    ac['listBrowserSessions']!.mockResolvedValue([{ sessionId: 'br-1', currentUrl: 'about:blank' }]);
    const res = await request(buildApp()).get('/api/capabilities/browser-sessions');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['sessions']);
  });

  it('POST /browser-sessions AUTO-NAVIGATES when a start URL is given', async () => {
    // The provider used to echo the URL back without visiting it, leaving the
    // user to retype it in the Navigate panel.
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-2', currentUrl: 'about:blank', pageTitle: '' });
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions')
      .send({ agentName: 'ops', url: 'https://docs.example.com' });
    expect(res.status).toBe(201);
    expect(ac['navigateBrowser']).toHaveBeenCalledWith('br-2', 'https://docs.example.com');
    expect(res.body.session.currentUrl).toBe('https://docs.example.com');
    expect(res.body.session.pageTitle).toBe('Docs');
    expect(events()[0]!['kind']).toBe('browser_launch');
  });

  it('does NOT navigate for a blank or about:blank launch', async () => {
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-3', currentUrl: 'about:blank', pageTitle: '' });
    const app = buildApp();
    await request(app).post('/api/capabilities/browser-sessions').send({ agentName: 'ops' });
    await request(app).post('/api/capabilities/browser-sessions')
      .send({ agentName: 'ops', url: 'about:blank' });
    await request(app).post('/api/capabilities/browser-sessions')
      .send({ agentName: 'ops', url: '   ' });
    expect(ac['navigateBrowser']).not.toHaveBeenCalled();
  });

  it('still returns the session when the auto-navigate throws', async () => {
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-4', currentUrl: 'about:blank', pageTitle: '' });
    ac['navigateBrowser']!.mockRejectedValue(new Error('Browser profile not found'));
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions')
      .send({ agentName: 'ops', url: 'https://x.example.com' });
    expect(res.status).toBe(201);
    expect(res.body.session.sessionId).toBe('br-4');
    expect(res.body.session.pageTitle).toBe('');
  });

  it('DELETE /browser-sessions/:id closes and records; 404s a dead session', async () => {
    ac['closeBrowserSession']!.mockResolvedValue(true);
    const ok = await request(buildApp()).delete('/api/capabilities/browser-sessions/br-2');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(events()[0]!['kind']).toBe('browser_close');

    jest.clearAllMocks();
    ac['closeBrowserSession']!.mockResolvedValue(false);
    const missing = await request(buildApp()).delete('/api/capabilities/browser-sessions/br-x');
    expect(missing.status).toBe(404);
    // Nothing was closed, so nothing is recorded as closed.
    expect(recordCapabilityEvent).not.toHaveBeenCalled();
  });
});

describe('POST /browser-sessions/:id/navigate', () => {
  it('returns the session with a null image when no capture was asked for', async () => {
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions/br-1/navigate')
      .send({ url: 'https://docs.example.com' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['imageDataUrl', 'ok', 'session']);
    expect(res.body.imageDataUrl).toBeNull();
    expect(ac['screenshotBrowser']).not.toHaveBeenCalled();
    expect(appendJourneyStep).not.toHaveBeenCalled();
  });

  it('captures a journey step with the screenshot when asked', async () => {
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    ac['screenshotBrowser']!.mockResolvedValue({ imageDataUrl: PNG });
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions/br-1/navigate')
      .send({ url: 'https://docs.example.com', captureScreenshot: true });
    expect(res.body.imageDataUrl).toBe(PNG);
    const [sessionId, step] = m(appendJourneyStep).mock.calls[0]!;
    expect(sessionId).toBe('br-1');
    expect(step).toMatchObject({ url: 'https://docs.example.com', pageTitle: 'Docs', imageDataUrl: PNG });
  });

  it('still records the journey step when the screenshot fails', async () => {
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    ac['screenshotBrowser']!.mockRejectedValue(new Error('capture timeout'));
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions/br-1/navigate')
      .send({ url: 'https://docs.example.com', captureScreenshot: true });
    expect(res.status).toBe(200);
    expect(res.body.imageDataUrl).toBeNull();
    expect(appendJourneyStep).toHaveBeenCalled();
  });

  it('404s a dead session and records the failure as ok:false', async () => {
    ac['navigateBrowser']!.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions/br-x/navigate')
      .send({ url: 'https://docs.example.com' });
    expect(res.status).toBe(404);
    expect(events()[0]!['ok']).toBe(false);
    expect(events()[0]!['error']).toBe('navigate failed');
  });
});

describe('the journey ring', () => {
  it('GET /browser-sessions/:id/journey wraps the ordered steps for THAT session', async () => {
    m(getJourney).mockReturnValue([{ url: 'https://a', pageTitle: 'A', startedAt: 't' }]);
    const res = await request(buildApp()).get('/api/capabilities/browser-sessions/br-1/journey');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['steps']);
    expect(getJourney).toHaveBeenCalledWith('br-1');
    expect(res.body.steps[0].url).toBe('https://a');
  });

  it('GET returns an empty step list for a session with no history', async () => {
    m(getJourney).mockReturnValue([]);
    const res = await request(buildApp()).get('/api/capabilities/browser-sessions/br-9/journey');
    expect(res.body).toEqual({ steps: [] });
  });

  it('DELETE clears only the named session\'s ring', async () => {
    const res = await request(buildApp()).delete('/api/capabilities/browser-sessions/br-1/journey');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(clearJourney).toHaveBeenCalledWith('br-1');
  });
});

describe('POST /browser-sessions/:id/screenshot', () => {
  it('returns the capture and records its byte length', async () => {
    ac['screenshotBrowser']!.mockResolvedValue({ imageDataUrl: PNG });
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions/br-1/screenshot').send({});
    expect(res.status).toBe(200);
    expect(res.body.imageDataUrl).toBe(PNG);
    expect(events()[0]!['kind']).toBe('browser_screenshot');
    expect((events()[0]!['detail'] as Record<string, unknown>)['bytes']).toBe(PNG.length);
  });

  it('404s when the capture failed, recording bytes 0 and ok:false', async () => {
    ac['screenshotBrowser']!.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/capabilities/browser-sessions/br-x/screenshot').send({});
    expect(res.status).toBe(404);
    expect(events()[0]!['ok']).toBe(false);
    expect((events()[0]!['detail'] as Record<string, unknown>)['bytes']).toBe(0);
  });
});

// ── Web Q&A ────────────────────────────────────────────────────────────────

describe('POST /browser/web-qa', () => {
  function visionAnswers(text: string) {
    converseSend.mockResolvedValue({ output: { message: { content: [{ text }] } } });
  }

  it('400s without both a url and a question', async () => {
    const app = buildApp();
    for (const body of [{}, { url: 'https://a' }, { question: 'what?' }]) {
      const res = await request(app).post('/api/capabilities/browser/web-qa').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/url and question/);
    }
    expect(ac['createBrowserSession']).not.toHaveBeenCalled();
  });

  it('launches its own session, answers from the screenshot, and says it created one', async () => {
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-qa' });
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    ac['screenshotBrowser']!.mockResolvedValue({ imageDataUrl: PNG });
    visionAnswers('The page documents the deploy order.');

    const res = await request(buildApp()).post('/api/capabilities/browser/web-qa')
      .send({ url: 'https://docs.example.com', question: 'what does it say?' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort())
      .toEqual(['answer', 'createdHere', 'imageDataUrl', 'pageTitle', 'sessionId', 'url']);
    expect(res.body.createdHere).toBe(true);
    expect(res.body.sessionId).toBe('br-qa');
    expect(res.body.answer).toBe('The page documents the deploy order.');
    expect(appendJourneyStep).toHaveBeenCalled();
  });

  it('reuses a supplied session and reports createdHere false', async () => {
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    ac['screenshotBrowser']!.mockResolvedValue({ imageDataUrl: PNG });
    visionAnswers('yes');
    const res = await request(buildApp()).post('/api/capabilities/browser/web-qa')
      .send({ url: 'https://a.example.com', question: 'q', sessionId: 'br-existing' });
    expect(res.body.createdHere).toBe(false);
    expect(res.body.sessionId).toBe('br-existing');
    expect(ac['createBrowserSession']).not.toHaveBeenCalled();
  });

  it('502s when the navigation failed — before paying for a vision call', async () => {
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-qa' });
    ac['navigateBrowser']!.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/capabilities/browser/web-qa')
      .send({ url: 'https://a.example.com', question: 'q' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('navigate failed');
    expect(converseSend).not.toHaveBeenCalled();
  });

  it('says so, rather than inventing an answer, when no screenshot was captured', async () => {
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-qa' });
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    ac['screenshotBrowser']!.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/capabilities/browser/web-qa')
      .send({ url: 'https://a.example.com', question: 'q' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('(no screenshot captured — cannot answer)');
    expect(converseSend).not.toHaveBeenCalled();
  });

  it('surfaces a vision-model failure in the answer instead of 500ing the page', async () => {
    ac['createBrowserSession']!.mockResolvedValue({ sessionId: 'br-qa' });
    ac['navigateBrowser']!.mockResolvedValue({ pageTitle: 'Docs' });
    ac['screenshotBrowser']!.mockResolvedValue({ imageDataUrl: PNG });
    converseSend.mockRejectedValue(new Error('ThrottlingException'));
    const res = await request(buildApp()).post('/api/capabilities/browser/web-qa')
      .send({ url: 'https://a.example.com', question: 'q' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/vision call failed: ThrottlingException/);
  });

  it('500s with the reason when the session itself could not be created', async () => {
    ac['createBrowserSession']!.mockRejectedValue(new Error('Browser profile not found'));
    const res = await request(buildApp()).post('/api/capabilities/browser/web-qa')
      .send({ url: 'https://a.example.com', question: 'q' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Browser profile not found');
  });
});

// ── Doc-discovery crawler ──────────────────────────────────────────────────

describe('the crawler surface', () => {
  const crawl = { id: 'cr-1', startUrl: 'https://docs.example.com', status: 'running', pages: [] };

  it('POST /browser/crawl refuses a missing or unparseable URL', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/capabilities/browser/crawl').send({})).status).toBe(400);
    const bad = await request(app).post('/api/capabilities/browser/crawl').send({ startUrl: 'docs.example.com' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/valid URL/);
    expect(startCrawl).not.toHaveBeenCalled();
  });

  it('POST /browser/crawl 201s with the new crawl', async () => {
    m(startCrawl).mockResolvedValue(crawl);
    const res = await request(buildApp()).post('/api/capabilities/browser/crawl')
      .send({ startUrl: 'https://docs.example.com', maxPages: 20, sameOriginOnly: true });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['crawl']);
    expect(res.body.crawl.id).toBe('cr-1');
  });

  it('GET /browser/crawl wraps the list; GET /browser/crawl/:id 404s an unknown one', async () => {
    m(listCrawls).mockReturnValue([crawl]);
    const list = await request(buildApp()).get('/api/capabilities/browser/crawl');
    expect(Object.keys(list.body)).toEqual(['crawls']);

    m(getCrawl).mockReturnValue(crawl);
    const one = await request(buildApp()).get('/api/capabilities/browser/crawl/cr-1');
    expect(Object.keys(one.body)).toEqual(['crawl']);

    m(getCrawl).mockReturnValue(undefined);
    expect((await request(buildApp()).get('/api/capabilities/browser/crawl/cr-x')).status).toBe(404);
  });

  it('POST /browser/crawl/:id/cancel 404s when there was nothing running', async () => {
    m(cancelCrawl).mockReturnValue(false);
    const missing = await request(buildApp()).post('/api/capabilities/browser/crawl/cr-x/cancel').send({});
    expect(missing.status).toBe(404);

    m(cancelCrawl).mockReturnValue(true);
    const ok = await request(buildApp()).post('/api/capabilities/browser/crawl/cr-1/cancel').send({});
    expect(ok.body).toEqual({ ok: true });
  });

  it('GET /browser/crawl/:id/stream 404s an unknown crawl as JSON', async () => {
    m(getCrawl).mockReturnValue(undefined);
    const res = await request(buildApp()).get('/api/capabilities/browser/crawl/cr-x/stream');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(subscribeCrawl).not.toHaveBeenCalled();
  });

  it('GET /browser/crawl/:id/stream opens with a SNAPSHOT so a late subscriber catches up', async () => {
    m(getCrawl).mockReturnValue({ ...crawl, status: 'completed' });
    const res = await request(buildApp()).get('/api/capabilities/browser/crawl/cr-1/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/"type":"snapshot"/);
    // …and closes immediately when the crawl is already over.
    expect(res.text).toMatch(/"type":"completed"/);
  });
});

// ── Reconcile ──────────────────────────────────────────────────────────────

describe('GET /reconcile', () => {
  it('reports each configured id and whether it still exists', async () => {
    // The failure this exists for: after a stack rebuild every id in .env.aws
    // pointed at a deleted resource and each failed far from the cause.
    m(reconcileCapabilities).mockResolvedValue({
      browser: { configuredId: 'br-old', exists: false, problem: 'not found' },
      codeInterpreter: { configuredId: 'ci-1', exists: true, problem: null },
      memory: { configuredId: null, exists: false, problem: 'MEMORY_ID unset' },
    });
    const res = await request(buildApp()).get('/api/capabilities/reconcile');
    expect(res.status).toBe(200);
    expect(res.body.browser.exists).toBe(false);
    expect(res.body.browser.problem).toBe('not found');
    expect(res.body.codeInterpreter.exists).toBe(true);
  });

  it('is a READ — it must not sit behind the mutation gate', async () => {
    m(reconcileCapabilities).mockResolvedValue({});
    const res = await request(buildApp()).get('/api/capabilities/reconcile');
    expect(res.status).toBe(200);
    // The blanket gate only applies to non-GET verbs; ManageDevbox is
    // constructed once at module load and this GET never runs it.
    expect(gateActions).toContain('ManageDevbox');
  });
});
