// What listening costs (docs/meeting-assistant-design.md, decision 10). The spend source is `meeting_assistant`.
//
//   invite   reserve the ceiling's minutes at the voice rate against the INVITER, on the call's initiative when it has one
//            (lib/spend-holds.ts reserveSpend, the same chokepoint voice uses). Refused: the invite fails with the refusal
//            voice would give, and Milo does not join.
//   extend   reserve the added minutes the same way, under a second source id.
//   settle   when Milo leaves, two ledger rows keyed by the call, as lib/voice/ledger.ts books a voice session: the listening
//            seconds (`ma:<callId>`, which settles the invite's hold) and the delegated tokens (`ma:<callId>:tokens`).
//            Extension holds are released; the invite's hold is settled by its ledger row.
//
// The provider's own seconds win (the session reports them cumulatively); with none, the seconds Milo was listening are the
// estimate, floored at the provider's 15-second minimum. The mock world's scripted session reports elapsed seconds, so the
// ledger shows a realistic entry without a paid call.
import { MIN_BILLED_SECONDS, voiceConfig, voiceCostUsd } from '../voice/config.js';
import { assistantStore } from './store-select.js';
import { periodOf, sessionOf, type AssistantRecord } from './types.js';

export interface SpendRefusal { status: number; body: unknown; headers?: Record<string, string> }
export type ReserveOutcome = { ok: true; holdId: string | null } | { ok: false; refusal: SpendRefusal };

export interface ReserveInput {
  callId: string;
  tenant: string;
  inviterId: string;
  initiativeId: string | null;
  /** Listening seconds this hold covers. */
  seconds: number;
  /** 0 for the invite's own hold, then 1, 2 ... for extensions. */
  part: number;
  confirmOverUserBudget?: boolean;
}

export interface SettleInput {
  record: AssistantRecord;
  /** The provider's (or scripted) seconds, summed over the call's sessions; 0 when none reported. */
  usageSeconds: number;
  tokens: { input: number; output: number; cached: number };
  /** The session that ran: only the provider's figures are `reported`. */
  sessionKind: 'openai' | 'scripted';
  /** What Milo was listening for, as the server counted it. */
  listeningSeconds: number;
  /** The ledger part to book under (0, or the part of the fresh hold a resume after a settlement reserved). */
  part?: number;
}

export interface AssistantSpend {
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  release(holdIds: readonly string[]): Promise<void>;
  settle(input: SettleInput): Promise<void>;
}

export const sourceIdFor = (callId: string, part = 0): string => (part === 0 ? `ma:${callId}` : `ma:${callId}:x${part}`);

/** A hold is open this long past the ceiling: pauses do not count against the ceiling but the wall clock runs. */
const HOLD_EXTRA_MS = 2 * 60 * 60_000;

export const realSpend: AssistantSpend = {
  async reserve(i) {
    const { reserveSpend, HOLD_GRACE_MS, spendRefusalResponse } = await import('../spend-holds.js');
    const cfg = voiceConfig();
    const p75 = voiceCostUsd(i.seconds, cfg.usdPerMinute);
    const forecast = { costUsdP75: p75, costUsdP25: Math.round((p75 / 4) * 10_000) / 10_000, confidence: 'prior' as const };
    const held = await reserveSpend({
      initiativeId: i.initiativeId, actorId: i.inviterId, source: 'meeting_assistant', sourceId: sourceIdFor(i.callId, i.part), forecast,
      expiresInMs: i.seconds * 1000 + HOLD_EXTRA_MS + HOLD_GRACE_MS, tenant: i.tenant,
      ...(i.confirmOverUserBudget ? { confirmed: { userBudget: true } } : {}),
    });
    if (held.kind === 'held') return { ok: true, holdId: held.holdId };
    // The listening time being bought rides along, so the over-budget ask can say what it holds and for how long.
    const out = spendRefusalResponse(held, { reason: 'budget', estimateUsd: p75, listeningSeconds: i.seconds });
    return { ok: false, refusal: { status: out.status, body: out.body, ...(out.headers ? { headers: out.headers as Record<string, string> } : {}) } };
  },

  async release(holdIds) {
    if (!holdIds.length) return;
    const { releaseHold } = await import('../../providers/spend-holds.js');
    for (const id of holdIds) { try { await releaseHold(id); } catch (e) { console.warn('[meeting-assistant] hold release failed', (e as Error).message); } }
  },

  async settle(i) {
    const { recordSpend } = await import('../../providers/spend-ledger.js');
    const { delegationCostUsd, delegationModel } = await import('../voice/ledger.js');
    const cfg = voiceConfig();
    const known = i.usageSeconds > 0;
    const raw = known ? i.usageSeconds : Math.round(i.listeningSeconds);
    const seconds = raw > 0 ? Math.max(MIN_BILLED_SECONDS, Math.ceil(raw)) : 0;
    const reported = known && i.sessionKind === 'openai';
    const r = i.record;
    await recordSpend({
      source: 'meeting_assistant', sourceId: sourceIdFor(r.callId, i.part ?? 0), initiativeId: r.initiativeId, boxId: null, actorId: r.invitedBy,
      trigger: `meeting-assistant:${r.tenant}`, model: cfg.model, costUsd: voiceCostUsd(seconds, cfg.usdPerMinute),
      costBasis: reported ? 'reported' : 'estimated', provider: 'openai',
    });
    if (i.tokens.input + i.tokens.output > 0) {
      const model = delegationModel();
      const costUsd = await delegationCostUsd(model, { inputTokens: i.tokens.input, outputTokens: i.tokens.output, cachedTokens: Math.min(i.tokens.cached, i.tokens.input), responses: 0 });
      await recordSpend({
        source: 'meeting_assistant', sourceId: `${sourceIdFor(r.callId, i.part ?? 0)}:tokens`, initiativeId: r.initiativeId, boxId: null, actorId: r.invitedBy,
        trigger: 'meeting-assistant-delegation', model, costUsd, costBasis: costUsd == null ? 'unknown' : reported ? 'reported' : 'estimated', provider: 'openai',
        inputTokens: i.tokens.input, outputTokens: i.tokens.output, estimatedCostUsd: costUsd,
      });
    }
  },
};

let spend: AssistantSpend = realSpend;
export function assistantSpend(): AssistantSpend { return spend; }
export function setAssistantSpend(next: AssistantSpend | null): void { spend = next ?? realSpend; }

/** Listening seconds of the current ledger period as of `now`: its closed periods plus the open one. This is what a settlement bills. */
export function currentListeningSecondsOf(record: Pick<AssistantRecord, 'session'>, now: number): number {
  const s = sessionOf(record);
  return s.listeningSeconds + (s.listeningSince != null ? Math.max(0, (now - s.listeningSince) / 1000) : 0);
}

/** Listening seconds of the whole call as of `now`: settled periods plus the current one. The ceiling, its warning and the state view use this. */
export function listeningSecondsOf(record: Pick<AssistantRecord, 'session'>, now: number): number {
  return sessionOf(record).settledListeningSeconds + currentListeningSecondsOf(record, now);
}

/**
 * Milo left: release the extension holds and book the ledger rows, once (`session.settled`). Called by the runtime when a
 * call's run ends. A failure is logged and leaves `settled` false; the hold then expires on its own. `period` is the period the run
 * served: once the record has moved to a newer one (Milo was invited back), this settles nothing, so a late stop never books an
 * earlier period's figures under the newer period's part (the invitation back settled the earlier one from the record).
 */
export async function settleFinished(e: { callId: string; usageSeconds: number; tokens: { input: number; output: number; cached: number }; sessionKind: 'openai' | 'scripted'; period?: number }, now: number = Date.now()): Promise<void> {
  const store = assistantStore();
  const record = await store.get(e.callId);
  if (!record) return;
  const when = e.period !== undefined ? { period: e.period } : undefined;
  if (when && periodOf(record) !== when.period) return;
  const s = sessionOf(record);
  if (s.settled) return;
  // Claim the settlement first so two stops cannot book twice; give it back if the ledger write fails. The claim holds only while the
  // record is still in the run's period.
  if (!(await store.patchSession(e.callId, { settled: true }, when))) return;
  try {
    await assistantSpend().settle({ record, usageSeconds: e.usageSeconds, tokens: e.tokens, sessionKind: e.sessionKind, listeningSeconds: currentListeningSecondsOf(record, now), part: s.ledgerPart ?? 0 });
    await assistantSpend().release(s.holds);
  } catch (err) {
    await store.patchSession(e.callId, { settled: false }, when);
    console.warn('[meeting-assistant] spend settlement failed', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The minutes (package 5): one text request, booked under `ma:<callId>:minutes` against the INVITER and the call's
// initiative, through the same chokepoints as listening (reserveSpend, then a ledger row that settles its hold).
// The ledger books once per source id, so every writer run books under its own: the first write's first run keeps
// `ma:<callId>:minutes` (rows already booked stay valid); every other run is `ma:<callId>:minutes:<addition>:<attempt>`
// (addition 0 for the first write, then 1, 2 ... for each addition; attempt 1 for its first run, then one more per retry).

export const minutesSourceId = (callId: string, addition = 0, attempt = 1): string =>
  addition === 0 && attempt <= 1 ? `${sourceIdFor(callId)}:minutes` : `${sourceIdFor(callId)}:minutes:${addition}:${attempt}`;

export interface MinutesSpend {
  /** Hold the estimated cost; a refusal means no model minutes (the record then carries a plain note). `sourceId` is the run's (`minutesSourceId`). */
  reserve(input: { callId: string; sourceId: string; tenant: string; inviterId: string; initiativeId: string | null; estimateUsd: number }): Promise<ReserveOutcome>;
  release(holdIds: readonly string[]): Promise<void>;
  /** Book what the minutes cost, under the run's `sourceId` (the same as its hold's, so the row settles it). `reported` only when the provider's own token counts priced it. */
  record(input: { callId: string; sourceId: string; inviterId: string; initiativeId: string | null; tenant: string; model: string; costUsd: number | null; basis: 'reported' | 'estimated' | 'unknown'; tokensIn?: number; tokensOut?: number }): Promise<void>;
}

/** What a scripted (mock-world) minutes entry books: a small estimate, so the mock ledger shows the line. */
export const SCRIPTED_MINUTES_USD = 0.001;

export const realMinutesSpend: MinutesSpend = {
  async reserve(i) {
    const { reserveSpend, HOLD_GRACE_MS, spendRefusalResponse } = await import('../spend-holds.js');
    const forecast = { costUsdP75: i.estimateUsd, costUsdP25: Math.round((i.estimateUsd / 4) * 10_000) / 10_000, confidence: 'prior' as const };
    const held = await reserveSpend({
      initiativeId: i.initiativeId, actorId: i.inviterId, source: 'meeting_assistant', sourceId: i.sourceId, forecast,
      expiresInMs: 10 * 60_000 + HOLD_GRACE_MS, tenant: i.tenant,
    });
    if (held.kind === 'held') return { ok: true, holdId: held.holdId };
    const out = spendRefusalResponse(held, { reason: 'budget', estimateUsd: i.estimateUsd });
    return { ok: false, refusal: { status: out.status, body: out.body, ...(out.headers ? { headers: out.headers as Record<string, string> } : {}) } };
  },
  release: (ids) => realSpend.release(ids),
  async record(i) {
    const { recordSpend } = await import('../../providers/spend-ledger.js');
    await recordSpend({
      source: 'meeting_assistant', sourceId: i.sourceId, initiativeId: i.initiativeId, boxId: null, actorId: i.inviterId,
      trigger: 'meeting-assistant-minutes', model: i.model, costUsd: i.costUsd, costBasis: i.basis, provider: 'openai',
      ...(i.tokensIn !== undefined ? { inputTokens: i.tokensIn } : {}), ...(i.tokensOut !== undefined ? { outputTokens: i.tokensOut } : {}),
      ...(i.costUsd !== null ? { estimatedCostUsd: i.costUsd } : {}),
    });
  },
};

let minutesSpendImpl: MinutesSpend = realMinutesSpend;
export function minutesSpend(): MinutesSpend { return minutesSpendImpl; }
export function setMinutesSpend(next: MinutesSpend | null): void { minutesSpendImpl = next ?? realMinutesSpend; }

// ---------------------------------------------------------------------------------------------------------------
// The decision watcher (docs/meeting-consent-design.md, "Detection", package 5): each model check is one ledger row against the
// INVITER and the call's initiative under the same source, keyed `ma:<callId>:watch:<n>` so a retried write never books twice.
// A check is not made once the call's listening hold is used up (the ceiling reached) or the call's spend has been settled.

export const watcherSourceId = (callId: string, n: number): string => `${sourceIdFor(callId)}:watch:${n}`;

export interface WatcherSpend {
  /** May a check be made now? False once the listening hold is exhausted or the call is settled. */
  allowed(record: AssistantRecord, now: number): boolean;
  /** Book one check. `reported` only when the provider's own token counts priced it. */
  record(input: { callId: string; inviterId: string; initiativeId: string | null; n: number; model: string; costUsd: number | null; basis: 'reported' | 'estimated' | 'unknown'; tokensIn: number; tokensOut: number }): Promise<void>;
}

export function watcherBudgetLeft(record: AssistantRecord, now: number): boolean {
  const s = sessionOf(record);
  if (s.settled) return false;
  return listeningSecondsOf(record, now) < s.ceilingSeconds;
}

export const realWatcherSpend: WatcherSpend = {
  allowed: watcherBudgetLeft,
  async record(i) {
    const { recordSpend } = await import('../../providers/spend-ledger.js');
    await recordSpend({
      source: 'meeting_assistant', sourceId: watcherSourceId(i.callId, i.n), initiativeId: i.initiativeId, boxId: null, actorId: i.inviterId,
      trigger: 'meeting-assistant-decision-check', model: i.model, costUsd: i.costUsd, costBasis: i.basis, provider: 'bedrock',
      inputTokens: i.tokensIn, outputTokens: i.tokensOut, ...(i.costUsd !== null ? { estimatedCostUsd: i.costUsd } : {}),
    });
  },
};

let watcherSpendImpl: WatcherSpend = realWatcherSpend;
export function watcherSpend(): WatcherSpend { return watcherSpendImpl; }
export function setWatcherSpend(next: WatcherSpend | null): void { watcherSpendImpl = next ?? realWatcherSpend; }
