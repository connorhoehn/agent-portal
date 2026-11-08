// /api/voice — the voice navigator's middleware half (docs/voice-navigator-spec.md §2, §6, §7, §9).
//
// The browser runs every tool (§2); the middleware only mints the session and
// meters it:
//
//   POST /api/voice/sessions             { sdp?, confirmOverUserBudget? }
//     Cedar VoiceNavigate, the tenant from the session, the demo persona refused
//     outside INSECURE_DEV_MODE, a `voice_session` hold through reserveSpend,
//     then the mint through lib/voice/openai.ts (or a scripted session under
//     MOCK_VOICE=1). 201:
//       { sessionId, voiceSessionId, holdId, maxSeconds, expiresAt, sdp, mock,
//         model, voice, toolsEnabled, tools: [names], budget: { holdUsd, usdPerMinute },
//         mockScript?: { onStart, onResponseCreate, onClose } }   (MOCK_VOICE only; lib/voice/openai.ts)
//     sessionId is opaque: the provider's live_… id stays server-side (§6), so a
//     hang-up goes through POST /:id/close, never from the browser to OpenAI.
//     503 { error: 'voice-unavailable', reason: 'no-key' | 'provider' }, a spend
//     refusal in spendRefusalResponse's shape plus { reason: 'budget' }, 403 for
//     the grant or the demo persona. Never the key, the instructions or the
//     session object.
//   POST /api/voice/sessions/:id/events  { tool, args? | argsSha256?, outcome, durationMs?, confirmedBy? }
//     one voice_tool_calls row; the arguments are hashed and dropped. 201 { id }.
//   POST /api/voice/sessions/:id/close   { seconds, reason? }
//     one ledger row (source voice_session, cost seconds/60 × rate, basis
//     estimated, provider openai) that settles the hold. Idempotent.
//
// A session belongs to the user who minted it, and its tool calls to the
// tenant it was minted in: any other caller gets 404, whether or not the id
// exists. A close is accepted from the same user in any tenant, so a tenant
// switch (which ends the session, §2) still settles the hold.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { isAllowed, requireSession, resolveSession } from '../lib/authz.js';
import { DEMO_SUB, type Session } from '../lib/session.js';
import { insecureDevMode } from '../lib/insecure-dev-mode.js';
import { emitFleetMetric } from '../lib/fleet-metrics.js';
import { rateLimit } from '../lib/rate-limit.js';
import { clock } from '../mock/core/index.js';
import { voiceConfig, voiceCostUsd, MIN_BILLED_SECONDS } from '../lib/voice/config.js';
import { bookVoiceSpend } from '../lib/voice/ledger.js';
import {
  delegationInstructions, hashToolArgs, responsesFunctionTools, toolsForTenant, voiceInstructions, voiceTool, MOCK_CALLS,
} from '../lib/voice/catalogue.js';
import {
  createLiveSession, hangupLiveSession, mockLiveScript, voiceProviderConfigured, MOCK_SDP_ANSWER, VoiceProviderError,
} from '../lib/voice/openai.js';
import {
  closeVoiceSession, getVoiceSession, insertVoiceSession, insertVoiceToolCall, learnReapedSessionCost, setProviderSessionId,
  CLIENT_STOP_REASONS, VOICE_TOOL_OUTCOMES, type VoiceSessionRow, type VoiceStopReason, type VoiceToolOutcome,
} from '../providers/voice-sessions.js';

export const voiceRouter = Router();

voiceRouter.use(requireSession('VoiceNavigate'));

const SESSION_ID = /^vs_[0-9a-f-]{36}$/;
const bySub = (req: Request): string | null => resolveSession(req)?.sub ?? null;
const MAX_SDP_BYTES = 64 * 1024;

function unavailable(res: Response, reason: 'no-key' | 'provider', message: string, status = 503): void {
  emitFleetMetric('voice-unavailable', { reason });
  res.status(status).json({ error: 'voice-unavailable', reason, message });
}

/** The forecast a session is held at: p75 minutes (never past the ceiling) × the rate. */
function voiceForecast(cfg: ReturnType<typeof voiceConfig>) {
  const p75 = voiceCostUsd(Math.min(cfg.p75Minutes, cfg.maxMinutes) * 60, cfg.usdPerMinute);
  return { costUsdP75: p75, costUsdP25: Math.round((p75 / 4) * 10_000) / 10_000, confidence: 'prior' as const };
}

voiceRouter.post('/sessions', rateLimit('voice-mint', 10, 60_000, bySub), asyncHandler(async (req, res) => {
  const session = resolveSession(req) as Session;
  // The demo persona is a shared, cookie-less identity: it may not spend real
  // money outside a dev process (§6, docs/fail-open-audit.md §2).
  if (session.sub === DEMO_SUB && !insecureDevMode()) {
    res.status(403).json({ error: 'Voice is not available to the demo identity. Sign in.', code: 'voice-demo-refused' });
    return;
  }
  if (!await isAllowed(session, 'VoiceNavigate')) {
    res.status(403).json({ error: 'Forbidden', action: 'VoiceNavigate', role: session.role, tenant: session.tenant });
    return;
  }
  const cfg = voiceConfig();
  if (!cfg.mock && !voiceProviderConfigured()) {
    unavailable(res, 'no-key', 'Voice is not configured on this deployment (no OpenAI key).');
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sdp = typeof body['sdp'] === 'string' ? body['sdp'] : null;
  if (!cfg.mock && (!sdp || !sdp.startsWith('v=0') || Buffer.byteLength(sdp) > MAX_SDP_BYTES)) {
    res.status(400).json({ error: 'sdp (an SDP offer string) is required' });
    return;
  }

  const id = `vs_${randomUUID()}`;
  const maxSeconds = Math.round(cfg.maxMinutes * 60);
  const { reserveSpend, HOLD_GRACE_MS, spendRefusalResponse } = await import('../lib/spend-holds.js');
  const expiresInMs = maxSeconds * 1000 + HOLD_GRACE_MS;
  const held = await reserveSpend({
    initiativeId: null, actorId: session.sub, source: 'voice_session', sourceId: id,
    forecast: voiceForecast(cfg), expiresInMs, tenant: session.tenant,
    ...(body['confirmOverUserBudget'] === true ? { confirmed: { userBudget: true } } : {}),
  });
  if (held.kind !== 'held') {
    emitFleetMetric('voice-unavailable', { reason: 'budget', gate: 'gate' in held ? held.gate : held.kind });
    // The session's estimate rides along so the dock can say how far over the confirm goes.
    const out = spendRefusalResponse(held, { reason: 'budget', estimateUsd: voiceForecast(cfg).costUsdP75 });
    if (out.headers) res.set(out.headers);
    res.status(out.status).json(out.body);
    return;
  }

  const { releaseHold } = await import('../providers/spend-holds.js');
  const tools = toolsForTenant(session.tenant);
  const toolsEnabled = cfg.mock || (cfg.delegationModel != null && tools.length > 0);
  let row: VoiceSessionRow;
  try {
    row = await insertVoiceSession({
      id, user_sub: session.sub, tenant: session.tenant, hold_id: held.holdId, model: cfg.model, voice: cfg.voice,
      mock: cfg.mock, max_seconds: maxSeconds, usd_per_minute: cfg.usdPerMinute,
    });
  } catch (err) {
    await releaseHold(held.holdId);
    throw err;
  }

  let answer: { providerSessionId: string | null; sdp: string };
  if (cfg.mock) {
    answer = { providerSessionId: `mock-${id.slice(3, 15)}`, sdp: MOCK_SDP_ANSWER };
  } else {
    try {
      answer = await createLiveSession(sdp!, {
        // Without a delegation model the voice is told it has no backend (§8), never to delegate into nothing.
        model: cfg.model, instructions: voiceInstructions(session.tenant, cfg.delegationModel ? tools : []),
        delegationInstructions: delegationInstructions(session.tenant), voice: cfg.voice,
        delegationModel: cfg.delegationModel, tools: responsesFunctionTools(tools),
      });
    } catch (err) {
      // Nothing was created, so nothing is booked: the row closes at zero and the money goes back.
      await closeVoiceSession(id, { seconds: 0, cost_usd: 0, cost_basis: 'estimated', stop_reason: 'mint-failed' });
      await releaseHold(held.holdId);
      const status = err instanceof VoiceProviderError ? err.status : 0;
      console.warn(`[voice] mint failed for ${id}: ${status || (err as Error).message.slice(0, 120)}`);
      unavailable(res, 'provider', 'The voice provider refused the session. Try again shortly.', 503);
      return;
    }
  }
  await setProviderSessionId(id, answer.providerSessionId);
  console.log(JSON.stringify({ event: 'voice-session-minted', sessionId: id, sub: session.sub, tenant: session.tenant,
    holdId: held.holdId, providerSessionId: answer.providerSessionId, mock: cfg.mock }));
  emitFleetMetric('voice-sessions-started', { tenant: session.tenant, mock: cfg.mock });
  const expiresAt = new Date(Date.parse(row.started_at) + maxSeconds * 1000).toISOString();
  res.status(201).json({
    sessionId: id, voiceSessionId: id, holdId: held.holdId, maxSeconds, expiresAt,
    sdp: answer.sdp, mock: cfg.mock, model: cfg.model, voice: cfg.voice,
    toolsEnabled, tools: toolsEnabled ? tools.map((t) => t.name) : [],
    budget: { holdUsd: held.amountUsd, usdPerMinute: cfg.usdPerMinute },
    ...(cfg.mock ? { mockScript: mockLiveScript(id, MOCK_CALLS[session.tenant] ?? MOCK_CALLS['social']!) } : {}),
  });
}));

/**
 * The caller's own session, else null (the route answers 404). Tool-call rows
 * also need the caller still in the session's tenant; a close does not, so a
 * dock that closes after a tenant switch still settles its hold (§2).
 */
async function ownSession(req: Request, opts: { sameTenant: boolean }): Promise<VoiceSessionRow | null> {
  const id = String(req.params['id'] ?? '');
  if (!SESSION_ID.test(id)) return null;
  const session = resolveSession(req) as Session;
  const row = await getVoiceSession(id);
  if (!row || row.user_sub !== session.sub) return null;
  if (opts.sameTenant && row.tenant !== session.tenant) return null;
  return row;
}

const notFound = (res: Response): void => { res.status(404).json({ error: 'voice session not found' }); };

voiceRouter.post('/sessions/:id/events', rateLimit('voice-events', 120, 60_000, bySub), asyncHandler(async (req, res) => {
  const row = await ownSession(req, { sameTenant: true });
  if (!row) { notFound(res); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tool = typeof body['tool'] === 'string' ? body['tool'] : typeof body['name'] === 'string' ? body['name'] : '';
  if (!voiceTool(tool)) { res.status(400).json({ error: 'tool must name a catalogue tool' }); return; }
  const outcome = body['outcome'] as VoiceToolOutcome;
  if (!VOICE_TOOL_OUTCOMES.includes(outcome)) {
    res.status(400).json({ error: `outcome must be one of ${VOICE_TOOL_OUTCOMES.join(', ')}` });
    return;
  }
  // The arguments are the user's business (§9): only a hash is kept. A raw
  // `args` is hashed here and goes no further — not into the row, not into a log.
  let argsSha256: string | null = null;
  if (typeof body['argsSha256'] === 'string') {
    if (!/^[0-9a-f]{64}$/.test(body['argsSha256'])) { res.status(400).json({ error: 'argsSha256 must be 64 hex characters' }); return; }
    argsSha256 = body['argsSha256'];
  } else if (body['args'] !== undefined) {
    argsSha256 = hashToolArgs(body['args']);
  }
  const ms = body['durationMs'];
  const durationMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), 3_600_000) : null;
  const by = body['confirmedBy'];
  const confirmedBy = by === 'voice' || by === 'click' ? by : null;
  const written = await insertVoiceToolCall({
    session_id: row.id, tenant: row.tenant, tool, args_sha256: argsSha256, outcome, confirmed_by: confirmedBy, duration_ms: durationMs,
  });
  if (!written) { res.status(429).json({ error: 'this voice session has reported its maximum number of tool calls' }); return; }
  emitFleetMetric('voice-tool-calls', { name: tool, outcome });
  res.status(201).json({ id: written.id });
}));

voiceRouter.post('/sessions/:id/close', asyncHandler(async (req, res) => {
  const row = await ownSession(req, { sameTenant: false });
  if (!row) { notFound(res); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = (CLIENT_STOP_REASONS.includes(body['reason'] as VoiceStopReason) ? body['reason'] : 'closed') as VoiceStopReason;
  const raw = body['seconds'];
  // A figure the dock never received (the channel died first) is unknown, never 0.
  // A reported one is floored at the provider's 15-second minimum and capped at
  // the wall time since the mint, plus a minute of slack.
  let seconds: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    const wall = Math.max(0, (clock.now().getTime() - Date.parse(row.started_at)) / 1000) + 60;
    seconds = Math.ceil(Math.max(MIN_BILLED_SECONDS, Math.min(raw, wall)));
  }
  const costUsd = seconds == null ? null : voiceCostUsd(seconds, row.usd_per_minute);

  const closed = await closeVoiceSession(row.id, {
    seconds, cost_usd: costUsd, cost_basis: seconds == null ? 'unknown' : 'estimated', stop_reason: reason,
  });
  if (!closed) {
    // Already closed. A session the reaper booked unknown learns its figure
    // from a late close; any other close is a no-op answered with what is stored.
    if (seconds != null && costUsd != null && row.stop_reason === 'reaped' && row.cost_basis === 'unknown') {
      const learnt = await learnReapedSessionCost(row.id, seconds, costUsd);
      if (learnt) await bookVoiceSpend(learnt);
      res.json(closeBody(learnt ?? row, true));
      return;
    }
    res.json(closeBody(row, true));
    return;
  }
  await bookVoiceSpend(closed);
  // The dock is gone or cut off: make sure the provider stops billing (server.mjs /api/hangup).
  if (reason !== 'closed' && !closed.mock && closed.provider_session_id) await hangupLiveSession(closed.provider_session_id);
  if (seconds != null) emitFleetMetric('voice-session-seconds', { tenant: closed.tenant, seconds });
  console.log(JSON.stringify({ event: 'voice-session-closed', sessionId: closed.id, seconds, costUsd, reason }));
  res.json(closeBody(closed, false));
}));

function closeBody(row: VoiceSessionRow, alreadyClosed: boolean) {
  return { sessionId: row.id, seconds: row.seconds, costUsd: row.cost_usd, costBasis: row.cost_basis, stopReason: row.stop_reason, alreadyClosed };
}
