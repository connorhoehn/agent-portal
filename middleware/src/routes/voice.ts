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
//         toastSeconds (VOICE_TOAST_SECONDS: how long a queued job's toast stays once it ends, G19),
//         mockScript?: { onStart, onResponseCreate, onClose } }   (MOCK_VOICE only; lib/voice/openai.ts)
//     sessionId is opaque: the provider's live_… id stays server-side (§6), so a
//     hang-up goes through POST /:id/close, never from the browser to OpenAI.
//     503 { error: 'voice-unavailable', reason: 'no-key' | 'provider' }; 429
//     { error: 'voice-unavailable', reason: 'daily-minutes', minutesLeft,
//     dailyMinutes, resetsAt } when the user's VOICE_DAILY_MINUTES for the UTC
//     day are used (G13; a session that fits only partly is minted with its
//     maxSeconds cut to what is left, and `dailyMinutesLeft` says so); a spend
//     refusal in spendRefusalResponse's shape plus { reason: 'budget' }, 403 for
//     the grant or the demo persona; 409 { error: 'voice-unavailable', reason:
//     'session-open', openSessionId } while the user already has an open real
//     session in any tenant (one per person: the dock closes that id and
//     retries). Both checks are read again after the insert, so two mints at
//     once never both go through (at most one does; both may refuse) and never
//     past the day's minutes. Never the key, the instructions or the session
//     object.
//   POST /api/voice/sessions/:id/events  { tool, args? | argsSha256?, outcome, durationMs?, confirmedBy? }
//     one voice_tool_calls row; the arguments are hashed and dropped. 201 { id }.
//   POST /api/voice/sessions/:id/close   { seconds, reason?, delegated?: { inputTokens, outputTokens, cachedTokens, responses } }
//     two ledger rows (lib/voice/ledger.ts, G11), both source voice_session,
//     provider openai: `<id>` at seconds/60 × rate, which settles the hold,
//     and `<id>:tokens` (trigger voice-delegation) for the delegated model's
//     tokens. Each prefers the provider's own figure from the sideband
//     (G12, basis reported) and falls back to the dock's (basis estimated:
//     seconds capped at wall time, tokens bounded at 50,000 per response and
//     one response per reported tool call plus one); neither = unknown.
//     Idempotent.
//
// On a real mint the middleware attaches the sideband (lib/voice/openai.ts
// attachSideband, G12): best effort, never blocking or failing the mint; the
// figures it hears land in the row's provider_* columns, and the close and the
// reaper close the socket.
//
// A session belongs to the user who minted it, and its tool calls to the
// tenant it was minted in: any other caller gets 404, whether or not the id
// exists. A close is accepted from the same user in any tenant, so a tenant
// switch (which ends the session, §2) still settles the hold: `voice_sessions`
// sits under row-level security, so the close reads and writes the row as the
// system, and the owner check (`user_sub`) is its boundary.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { asyncHandler } from '../lib/async-handler.js';
import { isAllowed, requireSession, resolveSession } from '../lib/authz.js';
import { DEMO_SUB, type Session } from '../lib/session.js';
import { insecureDevMode } from '../lib/insecure-dev-mode.js';
import { emitFleetMetric } from '../lib/fleet-metrics.js';
import { rateLimit } from '../lib/rate-limit.js';
import { clock } from '../mock/core/index.js';
import { runAsSystem } from '../providers/db-tenant.js';
import { voiceSessionOverdue } from '../lib/voice/reaper.js';
import { voiceConfig, voiceCostUsd, utcDay, MIN_BILLED_SECONDS, MIN_DAILY_SESSION_SECONDS } from '../lib/voice/config.js';
import { bookVoiceSpend, boundDelegatedUsage, preferProviderFigures, providerUsageFromRow } from '../lib/voice/ledger.js';
import {
  delegationInstructions, hashToolArgs, responsesFunctionTools, toolsForTenant, voiceInstructions, voiceTool, mockCallFor,
} from '../lib/voice/catalogue.js';
import {
  attachSideband, createLiveSession, detachSideband, hangupLiveSession, mockLiveScript, voiceProviderConfigured, waitForSidebandUsage,
  MOCK_SDP_ANSWER, VoiceProviderError, type ProviderUsage,
} from '../lib/voice/openai.js';
import {
  closeVoiceSession, getVoiceSession, insertVoiceSession, insertVoiceToolCall, learnReapedSessionCost, recordProviderUsage, setProviderSessionId,
  userOpenVoiceSessions, userVoiceSecondsSince,
  CLIENT_STOP_REASONS, VOICE_TOOL_OUTCOMES, type VoiceSessionRow, type VoiceStopReason, type VoiceToolOutcome,
} from '../providers/voice-sessions.js';

export const voiceRouter = Router();

voiceRouter.use(requireSession('VoiceNavigate'));

const SESSION_ID = /^vs_[0-9a-f-]{36}$/;
const bySub = (req: Request): string | null => resolveSession(req)?.sub ?? null;
const MAX_SDP_BYTES = 64 * 1024;

function unavailable(res: Response, reason: 'no-key' | 'provider' | 'daily-minutes' | 'session-open', message: string, status = 503, extra: Record<string, unknown> = {}): void {
  emitFleetMetric('voice-unavailable', { reason });
  res.status(status).json({ error: 'voice-unavailable', reason, message, ...extra });
}

/** 409: the user already has a live session; the dock closes `openSessionId` and mints again. */
function sessionOpen(res: Response, openSessionId: string): void {
  unavailable(res, 'session-open', 'A voice session is already open for you. Close it to start another.', 409, { openSessionId });
}

/** 429: the day's minutes are used (G13). */
function dailyMinutesUsed(res: Response, dailyMinutes: number, leftSeconds: number): void {
  const { next } = utcDay(clock.now());
  res.set('Retry-After', String(Math.max(1, Math.ceil((next.getTime() - clock.now().getTime()) / 1000))));
  unavailable(res, 'daily-minutes', `Today's ${dailyMinutes} minutes of voice are used. Voice is back at midnight UTC.`, 429, {
    minutesLeft: Math.floor(Math.max(0, leftSeconds) / 60), dailyMinutes, resetsAt: next.toISOString(),
  });
}

/**
 * The user's open real sessions that are still live: one past its ceiling plus
 * the hold grace is the reaper's (its money is bounded by the hold), and the
 * dock could not have kept it anyway.
 */
async function liveOpenSessions(sub: string): Promise<VoiceSessionRow[]> {
  const now = clock.now().getTime();
  return (await userOpenVoiceSessions(sub)).filter((r) => !voiceSessionOverdue(r, now));
}

/** The forecast a session is held at: p75 minutes (never past the session's ceiling) × the rate. */
function voiceForecast(cfg: ReturnType<typeof voiceConfig>, maxSeconds: number) {
  const p75 = voiceCostUsd(Math.min(cfg.p75Minutes * 60, maxSeconds), cfg.usdPerMinute);
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

  // One live real session per person, in any tenant (the dock holds one).
  // Checked first: closing the open one may also give back minutes it holds
  // at its ceiling below.
  if (!cfg.mock) {
    const open = await liveOpenSessions(session.sub);
    if (open[0]) { sessionOpen(res, open[0].id); return; }
  }

  // The daily minutes (G13, §3 Q2): what the user's real sessions since UTC
  // midnight used, known seconds else their ceiling, so an open session counts
  // in full. The dollar hold below stays the money brake; this is the time one.
  let maxSeconds = Math.round(cfg.maxMinutes * 60);
  let dailyMinutesLeft: number | null = null;
  const dailySeconds = Math.round(cfg.dailyMinutes * 60);
  if (!cfg.mock && cfg.dailyMinutes > 0) {
    const { start } = utcDay(clock.now());
    const left = Math.max(0, dailySeconds - await userVoiceSecondsSince(session.sub, start));
    if (left < MIN_DAILY_SESSION_SECONDS) {
      dailyMinutesUsed(res, cfg.dailyMinutes, left);
      return;
    }
    if (left < maxSeconds) {
      maxSeconds = left;
      dailyMinutesLeft = Math.floor(left / 60);
    }
  }

  const id = `vs_${randomUUID()}`;
  const { reserveSpend, HOLD_GRACE_MS, spendRefusalResponse } = await import('../lib/spend-holds.js');
  const expiresInMs = maxSeconds * 1000 + HOLD_GRACE_MS;
  const held = await reserveSpend({
    initiativeId: null, actorId: session.sub, source: 'voice_session', sourceId: id,
    forecast: voiceForecast(cfg, maxSeconds), expiresInMs, tenant: session.tenant,
    ...(body['confirmOverUserBudget'] === true ? { confirmed: { userBudget: true } } : {}),
  });
  if (held.kind !== 'held') {
    emitFleetMetric('voice-unavailable', { reason: 'budget', gate: 'gate' in held ? held.gate : held.kind });
    // The session's estimate rides along so the dock can say how far over the confirm goes.
    const out = spendRefusalResponse(held, { reason: 'budget', estimateUsd: voiceForecast(cfg, maxSeconds).costUsdP75 });
    if (out.headers) res.set(out.headers);
    res.status(out.status).json(out.body);
    return;
  }

  const { releaseHold } = await import('../providers/spend-holds.js');
  // run_command offers only the phrases this deployment's safe-mode allowlist runs (G9).
  const { commandAllowlist } = await import('./devbox.js');
  const tools = toolsForTenant(session.tenant, { commandAllowlist: commandAllowlist(), role: session.role });
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

  // Both checks above read before this insert, so two mints at once can pass
  // them together. Read again with this row in the table, before the provider
  // is asked for anything. Any other live row refuses this one: of two racing
  // mints the second to read always sees the first's row, so at most one goes
  // through (both refuse when each reads after the other's insert; the dock
  // retries). The day's minutes, this row at its ceiling, must still fit.
  if (!cfg.mock) {
    const other = (await liveOpenSessions(session.sub)).find((r) => r.id !== id);
    let refuse: (() => void) | null = other ? () => sessionOpen(res, other.id) : null;
    if (!refuse && cfg.dailyMinutes > 0) {
      const used = await userVoiceSecondsSince(session.sub, utcDay(clock.now()).start);
      if (used > dailySeconds) refuse = () => dailyMinutesUsed(res, cfg.dailyMinutes, dailySeconds - (used - maxSeconds));
    }
    if (refuse) {
      await closeVoiceSession(id, { seconds: 0, cost_usd: 0, cost_basis: 'estimated', stop_reason: 'mint-failed' });
      await releaseHold(held.holdId);
      refuse();
      return;
    }
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
  // The provider's own usage for this session (G12): best effort, never awaited, never failing the mint.
  if (!cfg.mock && answer.providerSessionId) {
    const tenant = session.tenant;
    attachSideband(answer.providerSessionId, {
      lifetimeMs: expiresInMs + SIDEBAND_LINGER_PAST_HOLD_MS,
      onUsage: (u) => recordProviderUsage(id, tenant, u),
    });
  }
  console.log(JSON.stringify({ event: 'voice-session-minted', sessionId: id, sub: session.sub, tenant: session.tenant,
    holdId: held.holdId, providerSessionId: answer.providerSessionId, mock: cfg.mock }));
  emitFleetMetric('voice-sessions-started', { tenant: session.tenant, mock: cfg.mock });
  const expiresAt = new Date(Date.parse(row.started_at) + maxSeconds * 1000).toISOString();
  res.status(201).json({
    sessionId: id, voiceSessionId: id, holdId: held.holdId, maxSeconds, expiresAt,
    sdp: answer.sdp, mock: cfg.mock, model: cfg.model, voice: cfg.voice,
    toolsEnabled, tools: toolsEnabled ? tools.map((t) => t.name) : [],
    budget: { holdUsd: held.amountUsd, usdPerMinute: cfg.usdPerMinute },
    toastSeconds: cfg.toastSeconds,
    ...(dailyMinutesLeft != null ? { dailyMinutesLeft } : {}),
    ...(cfg.mock ? { mockScript: mockLiveScript(id, mockCallFor(session.tenant, session.role)) } : {}),
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
  // A close may come from another tenant than the row's, which row-level
  // security would hide: read it as the system; the owner check is the boundary.
  const row = opts.sameTenant ? await getVoiceSession(id) : await runAsSystem(() => getVoiceSession(id));
  if (!row || row.user_sub !== session.sub) return null;
  if (opts.sameTenant && row.tenant !== session.tenant) return null;
  return row;
}

const notFound = (res: Response): void => { res.status(404).json({ error: 'voice session not found' }); };

/** How long the close waits for `session.closed` on the sideband (the dock has usually waited already). */
export const CLOSE_SIDEBAND_WAIT_MS = 2_500;
/** The sideband outlives the hold by this much, so the reaper's sweep can still read it. */
const SIDEBAND_LINGER_PAST_HOLD_MS = 10 * 60_000;

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
  // The delegated tokens (G11) as the dock summed them, bounded.
  const delegated = boundDelegatedUsage(body['delegated'], row.tool_calls);

  // The provider's own figures win (G12): the sideband this process holds,
  // waited on briefly for session.closed, else what it wrote to the row.
  const live = !row.ended_at && !row.mock && row.provider_session_id ? row.provider_session_id : null;
  let provider: ProviderUsage | null = null;
  let hungUp = false;
  if (live) {
    // The dock is gone or cut off: make sure the provider stops billing (server.mjs /api/hangup).
    if (reason !== 'closed') { await hangupLiveSession(live); hungUp = true; }
    provider = await waitForSidebandUsage(live, CLOSE_SIDEBAND_WAIT_MS);
    // A session the sideband never saw close may still be billing.
    if (provider && !provider.final && !hungUp) await hangupLiveSession(live);
  }
  const figures = preferProviderFigures(row, provider ?? providerUsageFromRow(row), { seconds, delegated });

  // As the system: the row may sit in a tenant the caller has switched away from (ownSession).
  const closed = await runAsSystem(() => closeVoiceSession(row.id, {
    seconds: figures.seconds, cost_usd: figures.costUsd, cost_basis: figures.basis, stop_reason: reason,
  }));
  if (live) detachSideband(live);
  if (!closed) {
    // Already closed. A session the reaper booked unknown learns its figure
    // from a late close; any other close is a no-op answered with what is stored.
    if (seconds != null && costUsd != null && row.stop_reason === 'reaped' && row.cost_basis === 'unknown') {
      const learnt = await runAsSystem(() => learnReapedSessionCost(row.id, seconds, costUsd));
      if (learnt) await bookVoiceSpend(learnt, delegated);
      res.json(closeBody(learnt ?? row, true));
      return;
    }
    res.json(closeBody(row, true));
    return;
  }
  await bookVoiceSpend(closed, figures.delegated, figures.tokensBasis);
  if (figures.seconds != null) emitFleetMetric('voice-session-seconds', { tenant: closed.tenant, seconds: figures.seconds });
  const used = figures.delegated;
  console.log(JSON.stringify({ event: 'voice-session-closed', sessionId: closed.id, seconds: figures.seconds, costUsd: figures.costUsd,
    basis: figures.basis, dockSeconds: seconds, reason, tokensBasis: used ? figures.tokensBasis : null,
    delegatedTokens: used ? { input: used.inputTokens, output: used.outputTokens, responses: used.responses } : null }));
  res.json(closeBody(closed, false));
}));

function closeBody(row: VoiceSessionRow, alreadyClosed: boolean) {
  return { sessionId: row.id, seconds: row.seconds, costUsd: row.cost_usd, costBasis: row.cost_basis, stopReason: row.stop_reason, alreadyClosed };
}
