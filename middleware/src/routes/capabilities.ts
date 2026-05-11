import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { guardrails, agentcore, cloudwatch } from '../providers/index.js';
import { config } from '../config.js';
import { recordCapabilityEvent, snippet } from '../lib/invocations.js';

export const capabilitiesRouter = Router();

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

capabilitiesRouter.patch('/guardrail/pii', asyncHandler(async (req, res) => {
  const { type, action, enabled } = req.body as { type: string; action?: string; enabled?: boolean };
  const filter = await guardrails.togglePiiFilter(type, { action, enabled });
  if (!filter) { res.json({ ok: true }); return; }
  res.json({ ok: true, filter });
}));

capabilitiesRouter.patch('/guardrail/topics/:name', asyncHandler(async (req, res) => {
  const { enabled, definition } = req.body as { enabled?: boolean; definition?: string };
  const topic = await guardrails.updateDeniedTopic(req.params['name'] as string, { enabled, definition });
  if (!topic) { res.status(404).json({ error: 'Topic not found' }); return; }
  res.json({ ok: true, topic });
}));

capabilitiesRouter.post('/guardrail/topics', asyncHandler(async (req, res) => {
  const { name, definition } = req.body as { name: string; definition: string };
  if (!name || !definition) { res.status(400).json({ error: 'name and definition required' }); return; }
  const topic = await guardrails.addDeniedTopic({ name, definition });
  res.status(201).json({ ok: true, topic });
}));

capabilitiesRouter.delete('/guardrail/topics/:name', asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params['name'] as string);
  const ok = await guardrails.removeDeniedTopic(name);
  if (!ok) { res.status(404).json({ error: 'Topic not found' }); return; }
  res.json({ ok: true });
}));

// ── Code Interpreter Sessions ─────────────────────────────────────────────────

capabilitiesRouter.get('/code-sessions', asyncHandler(async (_req, res) => {
  const sessions = await agentcore.listCodeSessions();
  res.json({ sessions });
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

capabilitiesRouter.get('/browser-sessions', asyncHandler(async (_req, res) => {
  const sessions = await agentcore.listBrowserSessions();
  res.json({ sessions });
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
  const { url } = req.body as { url: string };
  const startedAt = new Date();
  const session = await agentcore.navigateBrowser(sessionId, url);
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
  res.json({ ok: true, session });
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
