import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { mockGuardrail, mockCodeSessions, mockBrowserSessions } from '../mock/capabilities.js';

export const capabilitiesRouter = Router();

// ── Guardrails ────────────────────────────────────────────────────────────────

capabilitiesRouter.get('/guardrail', (_req, res) => {
  res.json(mockGuardrail);
});

capabilitiesRouter.patch('/guardrail/pii', asyncHandler(async (req, res) => {
  const { type, action, enabled } = req.body as { type: string; action: string; enabled: boolean };
  const filter = mockGuardrail.piiFilters.find(f => f.type === type);
  if (filter) {
    if (action !== undefined) filter.action = action as typeof filter.action;
    if (enabled !== undefined) filter.enabled = enabled;
  }
  mockGuardrail.updatedAt = new Date().toISOString();
  res.json({ ok: true, filter });
}));

capabilitiesRouter.patch('/guardrail/topics/:name', asyncHandler(async (req, res) => {
  const topic = mockGuardrail.deniedTopics.find(t => t.name === req.params['name']);
  if (!topic) { res.status(404).json({ error: 'Topic not found' }); return; }
  const { enabled, definition } = req.body as { enabled?: boolean; definition?: string };
  if (enabled !== undefined) topic.enabled = enabled;
  if (definition !== undefined) topic.definition = definition;
  mockGuardrail.updatedAt = new Date().toISOString();
  res.json({ ok: true, topic });
}));

capabilitiesRouter.post('/guardrail/topics', asyncHandler(async (req, res) => {
  const { name, definition } = req.body as { name: string; definition: string };
  if (!name || !definition) { res.status(400).json({ error: 'name and definition required' }); return; }
  const topic = { name, definition, enabled: true };
  mockGuardrail.deniedTopics.push(topic);
  mockGuardrail.updatedAt = new Date().toISOString();
  res.status(201).json({ ok: true, topic });
}));

// ── Code Interpreter Sessions ─────────────────────────────────────────────────

capabilitiesRouter.get('/code-sessions', (_req, res) => {
  res.json({ sessions: mockCodeSessions });
});

capabilitiesRouter.delete('/code-sessions/:sessionId', (req, res) => {
  const session = mockCodeSessions.find(s => s.sessionId === req.params['sessionId']);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.status = 'TERMINATED';
  res.json({ ok: true });
});

// ── Browser Sessions ──────────────────────────────────────────────────────────

capabilitiesRouter.get('/browser-sessions', (_req, res) => {
  res.json({ sessions: mockBrowserSessions });
});

capabilitiesRouter.post('/browser-sessions', asyncHandler(async (req, res) => {
  const { agentName, url } = req.body as { agentName: string; url?: string };
  const session = {
    sessionId: `bs-${Math.random().toString(36).slice(2, 10)}`,
    agentName,
    status: 'ACTIVE' as const,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    currentUrl: url ?? 'about:blank',
    pageTitle: '',
    requestCount: 0,
    profileId: 'bp-default',
  };
  mockBrowserSessions.push(session);
  res.status(201).json({ ok: true, session });
}));

capabilitiesRouter.delete('/browser-sessions/:sessionId', (req, res) => {
  const session = mockBrowserSessions.find(s => s.sessionId === req.params['sessionId']);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  session.status = 'CLOSED';
  res.json({ ok: true });
});

capabilitiesRouter.post('/browser-sessions/:sessionId/navigate', asyncHandler(async (req, res) => {
  const session = mockBrowserSessions.find(s => s.sessionId === req.params['sessionId']);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const { url } = req.body as { url: string };
  session.currentUrl = url;
  session.pageTitle = `Page at ${new URL(url).hostname}`;
  session.requestCount += 1;
  session.lastActivityAt = new Date().toISOString();
  res.json({ ok: true, currentUrl: session.currentUrl });
}));
