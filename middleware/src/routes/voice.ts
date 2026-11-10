// /api/voice — the voice navigator's middleware half (docs/voice-navigator-spec.md §2, §6, §7, §9).
//
// The browser runs every tool (§2); the middleware only mints the session and
// meters it:
//
//   POST /api/voice/sessions             { sdp?, confirmOverUserBudget?, resumeOf? }
//     Cedar VoiceNavigate, the tenant from the session, the demo persona refused
//     outside INSECURE_DEV_MODE, a `voice_session` hold through reserveSpend,
//     then the mint through lib/voice/openai.ts (or a scripted session under
//     MOCK_VOICE=1). 201:
//       { sessionId, voiceSessionId, holdId, maxSeconds, expiresAt, sdp, mock,
//         model, voice (the caller's choice, else VOICE_VOICE, else null), style (G38),
//         toolsEnabled, tools: [names], budget: { holdUsd, usdPerMinute },
//         toastSeconds (VOICE_TOAST_SECONDS: how long a queued job's toast stays once it ends, G19),
//         mockScript?: { onStart, onResponseCreate, onClose, onResponseCreateSeq?, onSent? } }   (MOCK_VOICE only; lib/voice/openai.ts; PUT /mock-script, below)
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
//     object. `resumeOf` (G35): the session id the dock kept after a drop; the
//     new row's resume_of links to it only when that session is the caller's,
//     in this tenant (anyone else's id, or an unknown one, links nothing and is
//     not distinguished); the `minted` event records the link.
//   POST /api/voice/sessions/:id/events  { tool, args? | argsSha256?, outcome, durationMs?, confirmedBy?, summary? }
//     one voice_tool_calls row; the arguments are hashed and dropped. 201 { id }.
//     It also writes a `tool-result` row to the session's event log.
//   POST /api/voice/sessions/:id/events  { kind, tool?, args? | argsSha256?, summary?, note?, data? }
//     (the event form: `kind` present) one row of the session's event log
//     (lib/voice/session-log.ts parseClientEvent): kind is one of started,
//     delegation, tool-call, tool-result, refused, confirm-shown, confirmed,
//     cancelled, usage, error, client; sanitized, never words or arguments.
//     201 { seq }; 429 once the log holds 500 rows.
//   POST /api/voice/sessions/:id/events  { events: [ <the event form above>, … ] }
//     (the batched form: the dock sends at most one request per 500 ms) 1 to
//     MAX_EVENT_BATCH events, each parsed as the event form; any bad one is a
//     400 naming its index and nothing is written. 201 { seqs } in order;
//     429 { seqs } with the rows written before the log filled.
//
//   GET /api/voice/settings              (G38)
//     The caller's voice settings: { voice (null = the default), style, pace,
//     options: { voices: [{ value, name | id, label, language, region,
//     presentation, bestQuality?, custom? }], styles: [{ id, label, hint }],
//     paces: [{ id, label }] }, default: { voice } } (lib/voice/voices.ts).
//   PUT /api/voice/settings              { voice?: string | null, style?, pace? }
//     Validated against the catalogue: a preset name in any case (stored
//     lowercase), or a designed voice on VOICE_CUSTOM_VOICES; null resets a
//     field to its default. 400 { error, field } names the bad field; 200 is
//     the GET body. The mint applies them: the voice through resolveVoice,
//     and the designed voice's description, the style and the pace as lines
//     appended to the voice's instructions. Words only: there is no speed
//     parameter, and no line names or imitates a person.
//
// The event log (lib/voice/session-log.ts): the mint (`minted`, or `error` +
// `closed` when it fails after the row exists), the dock's events above, the
// sideband (`sideband` for the socket's life, `usage` at most every 30 s and
// when final), the close (`closed`) and the reaper (`reaper`, `closed`).
// Read back by the owner only: routes/voice-log.ts.
//   POST /api/voice/sessions/:id/close   { seconds, reason?, cause?, transport?, delegated?: { inputTokens, outputTokens, cachedTokens, responses } }
//     `cause` (G35) says why a session ended, one of CLOSE_CAUSES (pagehide,
//     beforeunload, visibilitychange, ice-failed, ice-disconnected,
//     peer-closed, channel-closed, user, tenant-switch, cutoff); `transport`
//     the connection's own failure when the page was hidden. The `closed`
//     event carries it as `data.reason` (else the stop reason).
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
  attachSideband, createLiveSession, detachSideband, hangupLiveSession, mockLiveScript, mockLiveTurns, parseMockTurns, sidebandViewRow,
  voiceProviderConfigured, waitForSidebandUsage, MOCK_SDP_ANSWER, VoiceProviderError, type MockTurn, type ProviderUsage,
} from '../lib/voice/openai.js';
import {
  canonicalVoice, isVoicePace, isVoiceStyle, resolveVoice, voiceCatalogueConfig, voiceSettingsView, withVoiceSettings,
  DEFAULT_VOICE_SETTINGS, type VoiceSettings,
} from '../lib/voice/voices.js';
import { getVoiceSettings, putVoiceSettings, type VoiceSettingsPatch } from '../providers/voice-settings.js';
import { MAX_EVENT_BATCH, parseClientEvent, recordVoiceEvent, type VoiceEventKind } from '../lib/voice/session-log.js';
import {
  closeVoiceSession, getVoiceSession, insertVoiceSession, insertVoiceToolCall, learnReapedSessionCost, recordProviderUsage, setProviderSessionId,
  userOpenVoiceSessions, userVoiceSecondsSince,
  CLIENT_STOP_REASONS, VOICE_TOOL_OUTCOMES, type VoiceSessionRow, type VoiceStopReason, type VoiceToolOutcome,
} from '../providers/voice-sessions.js';

export const voiceRouter = Router();

voiceRouter.use(requireSession('VoiceNavigate'));

const SESSION_ID = /^vs_[0-9a-f-]{36}$/;

/** Why a session ended, as the dock saw it (G35): the page going away, the connection failing, or the user. */
export const CLOSE_CAUSES = [
  'pagehide', 'beforeunload', 'visibilitychange', 'ice-failed', 'ice-disconnected', 'peer-closed', 'channel-closed', 'user', 'tenant-switch', 'cutoff',
] as const;
export type CloseCause = typeof CLOSE_CAUSES[number];
const TRANSPORT_CAUSES: readonly string[] = ['ice-failed', 'ice-disconnected', 'peer-closed', 'channel-closed'];
const closeCause = (v: unknown): CloseCause | null => ((CLOSE_CAUSES as readonly unknown[]).includes(v) ? v as CloseCause : null);

/**
 * The dropped session a mint resumes (G35): the caller's own, in this tenant,
 * else null. Read as the system (row-level security), with the owner check as
 * the boundary; an id that is not the caller's is treated as unknown.
 */
async function resumable(raw: unknown, session: Session): Promise<string | null> {
  if (typeof raw !== 'string' || !SESSION_ID.test(raw)) return null;
  const prior = await runAsSystem(() => getVoiceSession(raw));
  return prior && prior.user_sub === session.sub && prior.tenant === session.tenant ? prior.id : null;
}
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

const settingsReads = rateLimit('voice-settings-reads', 120, 60_000, bySub);
const settingsWrites = rateLimit('voice-settings-writes', 30, 60_000, bySub);

voiceRouter.get('/settings', settingsReads, asyncHandler(async (req, res) => {
  const session = resolveSession(req) as Session;
  res.json(voiceSettingsView(await getVoiceSettings(session.sub), voiceCatalogueConfig()));
}));

voiceRouter.put('/settings', settingsWrites, asyncHandler(async (req, res) => {
  const session = resolveSession(req) as Session;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ error: 'a JSON object is required' }); return; }
  const cat = voiceCatalogueConfig();
  const patch: VoiceSettingsPatch = {};
  const bad = (field: string, error: string): void => { res.status(400).json({ error, field }); };
  if ('voice' in body) {
    const v = body['voice'];
    if (v === null) patch.voice = null;
    else if (typeof v !== 'string' || v.length > 100) { bad('voice', 'voice must be a voice name, a designed voice id, or null'); return; }
    else {
      const canonical = canonicalVoice(v, cat.customVoices);
      if (!canonical) { bad('voice', 'voice is not one this deployment offers'); return; }
      patch.voice = canonical;
    }
  }
  if ('style' in body) {
    const v = body['style'];
    if (v === null) patch.style = DEFAULT_VOICE_SETTINGS.style;
    else if (!isVoiceStyle(v)) { bad('style', 'style is not one of the offered styles'); return; }
    else patch.style = v;
  }
  if ('pace' in body) {
    const v = body['pace'];
    if (v === null) patch.pace = DEFAULT_VOICE_SETTINGS.pace;
    else if (!isVoicePace(v)) { bad('pace', 'pace is not one of brisk, normal, relaxed'); return; }
    else patch.pace = v;
  }
  const saved = Object.keys(patch).length ? await putVoiceSettings(session.sub, patch) : await getVoiceSettings(session.sub);
  res.json(voiceSettingsView(saved, cat));
}));

/** The caller's settings for a mint: a read that fails never blocks the session, it speaks in the default voice. */
async function mintSettings(sub: string): Promise<VoiceSettings> {
  try {
    return await getVoiceSettings(sub);
  } catch (err) {
    console.warn(`[voice] settings read failed, minting with the defaults: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    return { ...DEFAULT_VOICE_SETTINGS };
  }
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
  // computer run offers only the phrases this deployment's safe-mode allowlist runs (G9).
  const { commandAllowlist } = await import('./devbox.js');
  const tools = toolsForTenant(session.tenant, { commandAllowlist: commandAllowlist(), role: session.role });
  const toolsEnabled = cfg.mock || (cfg.delegationModel != null && tools.length > 0);
  // The caller's voice settings (G38): the voice, and the lines the instructions carry.
  const catalogue = voiceCatalogueConfig();
  const settings = await mintSettings(session.sub);
  const voice = resolveVoice(settings, catalogue);
  let row: VoiceSessionRow;
  let resumeOf: string | null = null;
  try {
    resumeOf = await resumable(body['resumeOf'], session);
    row = await insertVoiceSession({
      id, user_sub: session.sub, tenant: session.tenant, hold_id: held.holdId, model: cfg.model, voice,
      mock: cfg.mock, max_seconds: maxSeconds, usd_per_minute: cfg.usdPerMinute, resume_of: resumeOf,
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
      await recordVoiceEvent(row, 'closed', { stopReason: 'mint-failed', refusedBy: other ? 'session-open' : 'daily-minutes' });
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
        model: cfg.model,
        instructions: withVoiceSettings(voiceInstructions(session.tenant, cfg.delegationModel ? tools : []), voice, settings, catalogue),
        delegationInstructions: delegationInstructions(session.tenant), voice,
        delegationModel: cfg.delegationModel, tools: responsesFunctionTools(tools),
      });
    } catch (err) {
      // Nothing was created, so nothing is booked: the row closes at zero and the money goes back.
      await closeVoiceSession(id, { seconds: 0, cost_usd: 0, cost_basis: 'estimated', stop_reason: 'mint-failed' });
      await releaseHold(held.holdId);
      const status = err instanceof VoiceProviderError ? err.status : 0;
      await recordVoiceEvent(row, 'error', { stage: 'mint', status });
      await recordVoiceEvent(row, 'closed', { stopReason: 'mint-failed' });
      console.warn(`[voice] mint failed for ${id}: ${status || (err as Error).message.slice(0, 120)}`);
      unavailable(res, 'provider', 'The voice provider refused the session. Try again shortly.', 503);
      return;
    }
  }
  await setProviderSessionId(id, answer.providerSessionId);
  await recordVoiceEvent(row, 'minted', {
    mock: cfg.mock, model: cfg.model, voice, style: settings.style, pace: settings.pace, maxSeconds, toolsEnabled, tools: toolsEnabled ? tools.map((t) => t.name) : [],
    holdUsd: held.amountUsd, usdPerMinute: cfg.usdPerMinute, dailyMinutesLeft,
    ...(body['resumeOf'] !== undefined ? { resumeOf, resumeLinked: resumeOf != null } : {}),
  });
  // The provider's own usage for this session (G12): best effort, never awaited, never failing the mint.
  if (!cfg.mock && answer.providerSessionId) {
    const tenant = session.tenant;
    let lastUsageLog = 0;
    attachSideband(answer.providerSessionId, {
      lifetimeMs: expiresInMs + SIDEBAND_LINGER_PAST_HOLD_MS,
      onUsage: async (u, view) => {
        await recordProviderUsage(id, tenant, u);
        const now = clock.now().getTime();
        if (u.final || now - lastUsageLog >= USAGE_LOG_EVERY_MS) {
          lastUsageLog = now;
          await recordVoiceEvent(row, 'usage', { source: 'sideband', seconds: u.seconds, inputTokens: u.inputTokens,
            outputTokens: u.outputTokens, cachedTokens: u.cachedTokens, responses: u.responses, final: u.final, ...sidebandViewRow(answer.providerSessionId!, view) });
        }
      },
      onEvent: (e) => { void recordVoiceEvent(row, 'sideband', { ...e }); },
    });
  }
  console.log(JSON.stringify({ event: 'voice-session-minted', sessionId: id, sub: session.sub, tenant: session.tenant,
    holdId: held.holdId, providerSessionId: answer.providerSessionId, mock: cfg.mock }));
  emitFleetMetric('voice-sessions-started', { tenant: session.tenant, mock: cfg.mock });
  const expiresAt = new Date(Date.parse(row.started_at) + maxSeconds * 1000).toISOString();
  res.status(201).json({
    sessionId: id, voiceSessionId: id, holdId: held.holdId, maxSeconds, expiresAt,
    sdp: answer.sdp, mock: cfg.mock, model: cfg.model, voice, style: settings.style,
    toolsEnabled, tools: toolsEnabled ? tools.map((t) => t.name) : [],
    budget: { holdUsd: held.amountUsd, usdPerMinute: cfg.usdPerMinute },
    toastSeconds: cfg.toastSeconds,
    ...(resumeOf ? { resumeOf } : {}),
    ...(dailyMinutesLeft != null ? { dailyMinutesLeft } : {}),
    ...(cfg.mock ? { mockScript: scriptedTurns(session.sub, id) ?? mockLiveScript(id, devMockCall() ?? mockCallFor(session.tenant, session.role)) } : {}),
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

/**
 * MOCK_VOICE only: VOICE_MOCK_CALL (JSON `{ name, arguments, said }`, a catalogue tool) replaces the
 * persona's scripted call, so a headless walk can drive one specific tool through the real mint (G27).
 * Ignored outside the mock, and when it does not name a catalogue tool.
 */
function devMockCall(): { name: string; arguments: Record<string, unknown>; said: string } | null {
  const raw = process.env['VOICE_MOCK_CALL'];
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as { name?: unknown; arguments?: unknown; said?: unknown };
    if (typeof c.name !== 'string' || !voiceTool(c.name) || !c.arguments || typeof c.arguments !== 'object') return null;
    return { name: c.name, arguments: c.arguments as Record<string, unknown>, said: typeof c.said === 'string' ? c.said : '' };
  } catch { return null; }
}

const notFound = (res: Response): void => { res.status(404).json({ error: 'voice session not found' }); };

/** How long the close waits for `session.closed` on the sideband (the dock has usually waited already). */
export const CLOSE_SIDEBAND_WAIT_MS = 2_500;
/** The sideband outlives the hold by this much, so the reaper's sweep can still read it. */
const SIDEBAND_LINGER_PAST_HOLD_MS = 10 * 60_000;
/** The event log keeps a sideband usage figure at most this often (and always the final one). */
const USAGE_LOG_EVERY_MS = 30_000;

voiceRouter.post('/sessions/:id/events', rateLimit('voice-events', 120, 60_000, bySub), asyncHandler(async (req, res) => {
  const row = await ownSession(req, { sameTenant: true });
  if (!row) { notFound(res); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  // The batched event form: every event checked first, then written in order.
  if (body['events'] !== undefined) {
    const list = body['events'];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_EVENT_BATCH) {
      res.status(400).json({ error: `events must be an array of 1 to ${MAX_EVENT_BATCH} events` }); return;
    }
    const parsed: Array<{ kind: VoiceEventKind; data: Record<string, unknown> }> = [];
    for (const [i, raw] of list.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { res.status(400).json({ error: `events[${i}] must be an object` }); return; }
      const one = parseClientEvent(raw as Record<string, unknown>, { knownTool: (n) => voiceTool(n) != null, hashArgs: hashToolArgs });
      if ('error' in one) { res.status(400).json({ error: `events[${i}]: ${one.error}` }); return; }
      parsed.push(one);
    }
    const seqs: number[] = [];
    for (const one of parsed) {
      const event = await recordVoiceEvent(row, one.kind, one.data);
      if (!event) { res.status(429).json({ error: 'this voice session has logged its maximum number of events', seqs }); return; }
      seqs.push(event.seq);
    }
    res.status(201).json({ seqs });
    return;
  }
  // The event form: one row of the session's log, nothing else.
  if (body['kind'] !== undefined) {
    const parsed = parseClientEvent(body, { knownTool: (n) => voiceTool(n) != null, hashArgs: hashToolArgs });
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const event = await recordVoiceEvent(row, parsed.kind, parsed.data);
    if (!event) { res.status(429).json({ error: 'this voice session has logged its maximum number of events' }); return; }
    res.status(201).json({ seq: event.seq });
    return;
  }
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
  const summary = body['summary'] && typeof body['summary'] === 'object' && !Array.isArray(body['summary']) ? body['summary'] : undefined;
  await recordVoiceEvent(row, 'tool-result', {
    tool, toolCallId: written.id, outcome, argsSha256, durationMs, confirmedBy, ...(summary ? { summary } : {}),
  });
  emitFleetMetric('voice-tool-calls', { name: tool, outcome });
  res.status(201).json({ id: written.id });
}));

voiceRouter.post('/sessions/:id/close', asyncHandler(async (req, res) => {
  const row = await ownSession(req, { sameTenant: false });
  if (!row) { notFound(res); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = (CLIENT_STOP_REASONS.includes(body['reason'] as VoiceStopReason) ? body['reason'] : 'closed') as VoiceStopReason;
  // G35: why it ended, as the dock saw it; the closed event's `reason`.
  const cause = closeCause(body['cause']);
  const transportRaw = closeCause(body['transport']);
  const transport = transportRaw && TRANSPORT_CAUSES.includes(transportRaw) ? transportRaw : null;
  const why = { reason: cause ?? reason, ...(transport ? { transport } : {}) };
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
      await recordVoiceEvent(row, 'closed', { alreadyClosed: true, ...why, stopReason: reason, learnt: learnt != null, seconds: learnt?.seconds ?? null,
        costUsd: learnt?.cost_usd ?? null, basis: learnt?.cost_basis ?? row.cost_basis });
      res.json(closeBody(learnt ?? row, true));
      return;
    }
    await recordVoiceEvent(row, 'closed', { alreadyClosed: true, ...why, stopReason: row.stop_reason });
    res.json(closeBody(row, true));
    return;
  }
  await bookVoiceSpend(closed, figures.delegated, figures.tokensBasis);
  await recordVoiceEvent(closed, 'closed', {
    ...why, stopReason: reason, seconds: figures.seconds, costUsd: figures.costUsd, basis: figures.basis, dockSeconds: seconds, hungUp,
    providerFinal: provider?.final ?? false, tokensBasis: figures.delegated ? figures.tokensBasis : null,
    delegatedTokens: figures.delegated ? { inputTokens: figures.delegated.inputTokens, outputTokens: figures.delegated.outputTokens,
      cachedTokens: figures.delegated.cachedTokens, responses: figures.delegated.responses } : null,
  });
  if (figures.seconds != null) emitFleetMetric('voice-session-seconds', { tenant: closed.tenant, seconds: figures.seconds });
  const used = figures.delegated;
  console.log(JSON.stringify({ event: 'voice-session-closed', sessionId: closed.id, seconds: figures.seconds, costUsd: figures.costUsd,
    basis: figures.basis, dockSeconds: seconds, reason, cause, tokensBasis: used ? figures.tokensBasis : null,
    delegatedTokens: used ? { input: used.inputTokens, output: used.outputTokens, responses: used.responses } : null }));
  res.json(closeBody(closed, false));
}));

function closeBody(row: VoiceSessionRow, alreadyClosed: boolean) {
  return { sessionId: row.id, seconds: row.seconds, costUsd: row.cost_usd, costBasis: row.cost_basis, stopReason: row.stop_reason, alreadyClosed };
}

/**
 * MOCK_VOICE only (404 otherwise, and always under NODE_ENV=production): the turns the caller's NEXT scripted
 * session plays instead of the persona's one call, so a headless journey can say several things in one session
 * ("open Auth Migration", then "open decisions"; a request, then "confirm" once its card opens). Consumed by that
 * mint; one script per person; a real session never reads it.
 *   PUT    /api/voice/mock-script { turns: [{ said, call: { name, arguments } } | { said, on: 'card' }] }   204
 *   DELETE /api/voice/mock-script                                                                        204
 * 400 when a turn is malformed, names no catalogue tool, or the first turn is not a request (openai.ts parseMockTurns).
 */
const mockTurnsBySub = new Map<string, MockTurn[]>();
const mockScriptOpen = (): boolean => voiceConfig().mock && process.env['NODE_ENV'] !== 'production';

function scriptedTurns(sub: string, sessionId: string) {
  const turns = mockTurnsBySub.get(sub);
  if (!turns) return null;
  mockTurnsBySub.delete(sub);
  return mockLiveTurns(sessionId, turns);
}

voiceRouter.put('/mock-script', rateLimit('voice-mock-script', 60, 60_000, bySub), (req, res) => {
  if (!mockScriptOpen()) { res.status(404).json({ error: 'not found' }); return; }
  const session = resolveSession(req) as Session;
  const turns = parseMockTurns((req.body as { turns?: unknown } | undefined)?.turns, (n) => !!voiceTool(n));
  if (!turns) {
    res.status(400).json({ error: 'turns: 1-12 of { said, call: { name (a catalogue tool), arguments } } or { said, on: "card" }; the first is a request' });
    return;
  }
  mockTurnsBySub.set(session.sub, turns);
  res.status(204).end();
});

voiceRouter.delete('/mock-script', (req, res) => {
  if (!mockScriptOpen()) { res.status(404).json({ error: 'not found' }); return; }
  mockTurnsBySub.delete((resolveSession(req) as Session).sub);
  res.status(204).end();
});

/** Tests: forget every scripted turn. */
export function _resetMockTurns(): void { mockTurnsBySub.clear(); }
