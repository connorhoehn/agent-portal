import { Router } from 'express';
import { randomUUID } from 'crypto';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import { asyncHandler } from '../lib/async-handler.js';
import { degradedFields } from '../lib/upstream.js';
import { guardrails, agentcore, cloudwatch } from '../providers/index.js';
import { config } from '../config.js';
import {
  recordCapabilityEvent,
  snippet,
  appendJourneyStep,
  getJourney,
  clearJourney,
} from '../lib/invocations.js';
import {
  startCrawl,
  getCrawl,
  listCrawls,
  cancelCrawl,
  subscribeCrawl,
} from '../lib/crawler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { requireAction } from '../lib/authz.js';
import { reconcileCapabilities } from '../providers/capability-reconcile.js';

const _bedrockRt = new BedrockRuntimeClient({ region: config.region });
const VISION_MODEL = 'amazon.nova-lite-v1:0';

export const capabilitiesRouter = Router();

// Code-interpreter executions, browser microVM sessions and crawls spend real
// AWS resources, so every mutation on this surface requires ManageDevbox.
// Guardrail edits are the exception: they spend nothing and carry their own
// action, EditGuardrail, which org-leader, hr-admin and admin hold
// (docs/next-steps.md §9 item 8c); an org-leader holds no ManageDevbox, so the
// floor would hide the editor from the role it is meant for. Reads stay open
// so the capabilities dashboard renders for any role.
const manageCaps = requireAction('ManageDevbox');
const editGuardrail = requireAction('EditGuardrail');
capabilitiesRouter.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') { next(); return; }
  if (req.path === '/guardrail' || req.path.startsWith('/guardrail/')) { editGuardrail(req, res, next); return; }
  manageCaps(req, res, next);
});

// ── Guardrails ────────────────────────────────────────────────────────────────

capabilitiesRouter.get('/guardrail', asyncHandler(async (_req, res) => {
  const snapshot = await guardrails.getGuardrail();
  res.json(snapshot);
}));

capabilitiesRouter.get('/guardrail/metrics', asyncHandler(async (req, res) => {
  const hours = Math.max(1, Math.min(168, parseInt((req.query['hours'] as string) ?? '24', 10) || 24));
  const summary = await cloudwatch.getGuardrailMetrics(config.guardrail.id, hours);
  res.json(summary);
}));

capabilitiesRouter.patch('/guardrail/pii', requireAction('EditGuardrail'), asyncHandler(async (req, res) => {
  const { type, action, enabled } = req.body as { type: string; action?: string; enabled?: boolean };
  const filter = await guardrails.togglePiiFilter(type, { action, enabled });
  if (!filter) { res.json({ ok: true }); return; }
  res.json({ ok: true, filter });
}));

capabilitiesRouter.patch('/guardrail/topics/:name', requireAction('EditGuardrail'), asyncHandler(async (req, res) => {
  const { enabled, definition } = req.body as { enabled?: boolean; definition?: string };
  const topic = await guardrails.updateDeniedTopic(req.params['name'] as string, { enabled, definition });
  if (!topic) { res.status(404).json({ error: 'Topic not found' }); return; }
  res.json({ ok: true, topic });
}));

capabilitiesRouter.post('/guardrail/topics', requireAction('EditGuardrail'), asyncHandler(async (req, res) => {
  const { name, definition } = req.body as { name: string; definition: string };
  if (!name || !definition) { res.status(400).json({ error: 'name and definition required' }); return; }
  const topic = await guardrails.addDeniedTopic({ name, definition });
  res.status(201).json({ ok: true, topic });
}));

capabilitiesRouter.delete('/guardrail/topics/:name', requireAction('EditGuardrail'), asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params['name'] as string);
  const ok = await guardrails.removeDeniedTopic(name);
  if (!ok) { res.status(404).json({ error: 'Topic not found' }); return; }
  res.json({ ok: true });
}));

// ── Code Interpreter Sessions ─────────────────────────────────────────────────

/**
 * Running Code Interpreter sandboxes.
 *
 * `{ sessions: [] }` used to mean two incompatible things — no sandbox is
 * running, or `ListCodeInterpreterSessions` failed — and the provider had
 * already thrown that distinction away before the handler saw it. It answers
 * an envelope now (lib/upstream.ts), so a healthy empty list is byte-identical
 * to what this route always sent and only a failure changes shape:
 *
 *   { sessions: [] }                            nothing is running
 *   { sessions: [], degraded: true, error }     we could not ask
 *
 * Still a 200 either way. A dead CODE_INTERPRETER_ID is an ordinary state of
 * this account (CLAUDE.md: capability ids are minted fresh on every rebuild
 * and .env.aws is not regenerated), and failing the Capabilities page over one
 * panel would be a worse answer than showing the panel with its reason.
 */
capabilitiesRouter.get('/code-sessions', asyncHandler(async (_req, res) => {
  const result = await agentcore.listCodeSessionsResult();
  res.json({ sessions: result.items, ...degradedFields(result) });
}));

capabilitiesRouter.delete('/code-sessions/:sessionId', asyncHandler(async (req, res) => {
  const ok = await agentcore.terminateCodeSession(req.params['sessionId'] as string);
  if (!ok) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json({ ok: true });
}));

capabilitiesRouter.post('/code-interpreter/execute', asyncHandler(async (req, res) => {
  const { code, language } = req.body as { code: string; language?: 'python' };
  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: 'code (string) is required' });
    return;
  }
  const startedAt = new Date();
  const result = await agentcore.executeCode(code, language ?? 'python');
  recordCapabilityEvent({
    id: randomUUID(),
    kind: 'code_execute',
    startedAt: startedAt.toISOString(),
    durationMs: result.durationMs,
    sessionId: result.sessionId,
    detail: {
      codeSnippet: snippet(code, 160),
      outputSnippet: snippet(result.output, 200),
      language: language ?? 'python',
    },
    ok: !result.error,
    ...(result.error ? { error: result.error } : {}),
  });
  res.json(result);
}));

// ── Browser Sessions ──────────────────────────────────────────────────────────

/** Open browser sessions. Same two answers as `/code-sessions` above, for the
 *  same reason — and this is the panel where it matters most, because a stale
 *  BROWSER_ID fails SOFT: site-survey's browser fallback cannot tell a dead
 *  browser from a site with no JavaScript-only pages. */
capabilitiesRouter.get('/browser-sessions', asyncHandler(async (_req, res) => {
  const result = await agentcore.listBrowserSessionsResult();
  res.json({ sessions: result.items, ...degradedFields(result) });
}));

capabilitiesRouter.post('/browser-sessions', asyncHandler(async (req, res) => {
  const { agentName, url } = req.body as { agentName: string; url?: string };
  const startedAt = new Date();
  const session = await agentcore.createBrowserSession({ agentName, url });

  // Auto-navigate when the user provided a starting URL on launch. Previously
  // createBrowserSession echoed the URL back without actually visiting it, so
  // the user had to retype it in the Navigate panel. Fire-and-forget; the UI
  // will refresh the session shortly and pick up the new currentUrl.
  let navTitle = '';
  if (url && url.trim() && url !== 'about:blank') {
    try {
      const nav = await agentcore.navigateBrowser(session.sessionId, url);
      if (nav) navTitle = nav.pageTitle ?? '';
    } catch (err) {
      console.warn('[capabilities] auto-navigate on launch failed:', (err as Error).message);
    }
  }

  recordCapabilityEvent({
    id: randomUUID(),
    kind: 'browser_launch',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sessionId: session.sessionId,
    detail: {
      agentName,
      url: url ?? 'about:blank',
      pageTitle: navTitle,
    },
    ok: true,
  });
  res.status(201).json({ ok: true, session: { ...session, currentUrl: url ?? session.currentUrl, pageTitle: navTitle || session.pageTitle } });
}));

capabilitiesRouter.delete('/browser-sessions/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = req.params['sessionId'] as string;
  const startedAt = new Date();
  const ok = await agentcore.closeBrowserSession(sessionId);
  if (!ok) { res.status(404).json({ error: 'Session not found' }); return; }
  recordCapabilityEvent({
    id: randomUUID(),
    kind: 'browser_close',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sessionId,
    detail: {},
    ok: true,
  });
  res.json({ ok: true });
}));

capabilitiesRouter.post('/browser-sessions/:sessionId/navigate', asyncHandler(async (req, res) => {
  const sessionId = req.params['sessionId'] as string;
  const { url, captureScreenshot } = req.body as { url: string; captureScreenshot?: boolean };
  const startedAt = new Date();
  const session = await agentcore.navigateBrowser(sessionId, url);

  // If the caller wants the navigation captured as a journey step, screenshot
  // immediately + push it into the per-session journey ring.
  let imageDataUrl: string | undefined;
  if (session && captureScreenshot) {
    try {
      const shot = await agentcore.screenshotBrowser(sessionId);
      imageDataUrl = shot?.imageDataUrl;
    } catch {
      // ignore — journey step is still recorded without an image
    }
    appendJourneyStep(sessionId, {
      startedAt: startedAt.toISOString(),
      url,
      pageTitle: session.pageTitle ?? '',
      textSnippet: '',
      ...(imageDataUrl ? { imageDataUrl } : {}),
    });
  }

  recordCapabilityEvent({
    id: randomUUID(),
    kind: 'browser_navigate',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sessionId,
    detail: { url, pageTitle: session?.pageTitle ?? '' },
    ok: !!session,
    ...(session ? {} : { error: 'navigate failed' }),
  });
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json({ ok: true, session, imageDataUrl: imageDataUrl ?? null });
}));

// ── Journey: ordered (url → screenshot → text) steps per session ──────────────

capabilitiesRouter.get('/browser-sessions/:sessionId/journey', (req, res) => {
  const sessionId = req.params['sessionId'] as string;
  res.json({ steps: getJourney(sessionId) });
});

capabilitiesRouter.delete('/browser-sessions/:sessionId/journey', (req, res) => {
  const sessionId = req.params['sessionId'] as string;
  clearJourney(sessionId);
  res.json({ ok: true });
});

// ── Web Q&A: launch → navigate → screenshot → vision-model answer ─────────────

capabilitiesRouter.post('/browser/web-qa', asyncHandler(async (req, res) => {
  const { url, question, sessionId: existingSessionId, label } = req.body as {
    url?: string;
    question?: string;
    sessionId?: string;
    label?: string;
  };
  if (!url || !question) {
    res.status(400).json({ error: 'url and question are required' });
    return;
  }

  let sessionId = existingSessionId ?? '';
  let createdHere = false;
  const startedAt = new Date();

  try {
    if (!sessionId) {
      const session = await agentcore.createBrowserSession({ agentName: label || 'web-qa' });
      sessionId = session.sessionId;
      createdHere = true;
    }

    // Navigate (the navigate provider updates the internal state cache too).
    const nav = await agentcore.navigateBrowser(sessionId, url);
    if (!nav) {
      res.status(502).json({ error: 'navigate failed' });
      return;
    }

    // Screenshot.
    const shot = await agentcore.screenshotBrowser(sessionId);
    const imageBytes = shot?.imageDataUrl ? Buffer.from(shot.imageDataUrl.split(',')[1] ?? '', 'base64') : undefined;

    // Vision-model answer. Nova Lite is multimodal — we send the screenshot
    // plus the user question and a short instruction. Cheaper than Pro for
    // a single Q&A turn.
    let answer = '';
    if (imageBytes && imageBytes.length > 0) {
      try {
        const visionResp = await _bedrockRt.send(
          new ConverseCommand({
            modelId: VISION_MODEL,
            system: [{
              text: 'You answer questions about a web page using a screenshot of it as evidence. Keep answers concise (3-5 sentences). If the page does not contain the answer, say so explicitly.',
            }],
            messages: [{
              role: 'user',
              content: [
                { image: { format: 'png', source: { bytes: imageBytes } } },
                { text: `Page URL: ${url}\nPage title: ${nav.pageTitle ?? ''}\n\nQuestion: ${question}` },
              ],
            }],
            inferenceConfig: { maxTokens: 400, temperature: 0.2 },
          }),
        );
        void recordBffCall({ feature: 'browser-vision-answer', model: VISION_MODEL, usage: visionResp.usage });
        const blocks = visionResp.output?.message?.content ?? [];
        answer = blocks.map((c) => ('text' in c ? c.text : '')).join('').trim();
      } catch (err) {
        answer = `(vision call failed: ${(err as Error).message})`;
      }
    } else {
      answer = '(no screenshot captured — cannot answer)';
    }

    appendJourneyStep(sessionId, {
      startedAt: startedAt.toISOString(),
      url,
      pageTitle: nav.pageTitle ?? '',
      textSnippet: '',
      question,
      answer,
      ...(shot?.imageDataUrl ? { imageDataUrl: shot.imageDataUrl } : {}),
    });

    recordCapabilityEvent({
      id: randomUUID(),
      kind: 'browser_navigate',
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      sessionId,
      detail: { url, pageTitle: nav.pageTitle ?? '', qa: true },
      ok: true,
    });

    res.json({
      sessionId,
      createdHere,
      url,
      pageTitle: nav.pageTitle ?? '',
      imageDataUrl: shot?.imageDataUrl ?? null,
      answer,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}));

capabilitiesRouter.post('/browser-sessions/:sessionId/screenshot', asyncHandler(async (req, res) => {
  const sessionId = req.params['sessionId'] as string;
  const startedAt = new Date();
  const shot = await agentcore.screenshotBrowser(sessionId);
  recordCapabilityEvent({
    id: randomUUID(),
    kind: 'browser_screenshot',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sessionId,
    detail: { bytes: shot ? shot.imageDataUrl.length : 0 },
    ok: !!shot,
    ...(shot ? {} : { error: 'screenshot failed' }),
  });
  if (!shot) { res.status(404).json({ error: 'Session not found or screenshot failed' }); return; }
  res.json(shot);
}));

// ── Doc Discovery Crawler ─────────────────────────────────────────────────────

capabilitiesRouter.post('/browser/crawl', asyncHandler(async (req, res) => {
  const { startUrl, maxPages, includePattern, sameOriginOnly, label } = req.body as {
    startUrl?: string;
    maxPages?: number;
    includePattern?: string;
    sameOriginOnly?: boolean;
    label?: string;
  };
  if (!startUrl || typeof startUrl !== 'string') {
    res.status(400).json({ error: 'startUrl required' });
    return;
  }
  try { new URL(startUrl); } catch { res.status(400).json({ error: 'startUrl must be a valid URL' }); return; }
  const crawl = await startCrawl({ startUrl, maxPages, includePattern, sameOriginOnly, label });
  res.status(201).json({ crawl });
}));

capabilitiesRouter.get('/browser/crawl', (_req, res) => {
  res.json({ crawls: listCrawls() });
});

capabilitiesRouter.get('/browser/crawl/:crawlId', (req, res) => {
  const crawl = getCrawl(req.params['crawlId'] as string);
  if (!crawl) { res.status(404).json({ error: 'Crawl not found' }); return; }
  res.json({ crawl });
});

capabilitiesRouter.post('/browser/crawl/:crawlId/cancel', (req, res) => {
  const ok = cancelCrawl(req.params['crawlId'] as string);
  if (!ok) { res.status(404).json({ error: 'Crawl not found' }); return; }
  res.json({ ok: true });
});

capabilitiesRouter.get('/browser/crawl/:crawlId/stream', (req, res) => {
  const crawlId = req.params['crawlId'] as string;
  const crawl = getCrawl(crawlId);
  if (!crawl) { res.status(404).json({ error: 'Crawl not found' }); return; }

  initSSE(res);
  // Send current state immediately so a late subscriber catches up.
  writeSSE(res, { type: 'snapshot', session: crawl });

  const unsubscribe = subscribeCrawl(crawlId, (ev) => {
    writeSSE(res, ev);
    if (ev.type === 'completed' || ev.type === 'cancelled' || ev.type === 'failed') {
      endSSE(res);
    }
  });

  // If the crawl already finished before we subscribed, close immediately.
  if (crawl.status !== 'running') {
    writeSSE(res, { type: crawl.status === 'completed' ? 'completed' : crawl.status === 'cancelled' ? 'cancelled' : 'failed', session: crawl });
    endSSE(res);
    return;
  }

  req.on('close', () => { unsubscribe(); endSSE(res); });
});

// ── GET /reconcile — are the configured capability ids real? ────────────────
//
// The class of failure this catches cost a whole afternoon: after a stack
// rebuild every id in .env.aws pointed at a resource that no longer existed,
// and each one failed somewhere far from the cause.
capabilitiesRouter.get('/reconcile', asyncHandler(async (_req, res) => {
  res.json(await reconcileCapabilities());
}));
