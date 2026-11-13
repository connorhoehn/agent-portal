// What listening costs (docs/meeting-assistant-design.md, decision 10). The spend source is `meeting_assistant`.
//
//   invite   reserve the ceiling's minutes at the voice rate against the INVITER, on the call's initiative when it has one
//            (lib/spend-holds.ts reserveSpend, the same chokepoint voice uses). Refused: the invite fails with the refusal
//            voice would give, and Nova does not join.
//   extend   reserve the added minutes the same way, under a second source id.
//   settle   when Nova leaves, two ledger rows keyed by the call, as lib/voice/ledger.ts books a voice session: the listening
//            seconds (`ma:<callId>`, which settles the invite's hold) and the delegated tokens (`ma:<callId>:tokens`).
//            Extension holds are released; the invite's hold is settled by its ledger row.
//
// The provider's own seconds win (the session reports them cumulatively); with none, the seconds Nova was listening are the
// estimate, floored at the provider's 15-second minimum. The mock world's scripted session reports elapsed seconds, so the
// ledger shows a realistic entry without a paid call.
import { MIN_BILLED_SECONDS, voiceConfig, voiceCostUsd } from '../voice/config.js';
import { assistantStore } from './store-select.js';
import { sessionOf, type AssistantRecord } from './types.js';

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
  /** What Nova was listening for, as the server counted it. */
  listeningSeconds: number;
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
    const out = spendRefusalResponse(held, { reason: 'budget', estimateUsd: p75 });
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
      source: 'meeting_assistant', sourceId: sourceIdFor(r.callId), initiativeId: r.initiativeId, boxId: null, actorId: r.invitedBy,
      trigger: `meeting-assistant:${r.tenant}`, model: cfg.model, costUsd: voiceCostUsd(seconds, cfg.usdPerMinute),
      costBasis: reported ? 'reported' : 'estimated', provider: 'openai',
    });
    if (i.tokens.input + i.tokens.output > 0) {
      const model = delegationModel();
      const costUsd = await delegationCostUsd(model, { inputTokens: i.tokens.input, outputTokens: i.tokens.output, cachedTokens: Math.min(i.tokens.cached, i.tokens.input), responses: 0 });
      await recordSpend({
        source: 'meeting_assistant', sourceId: `${sourceIdFor(r.callId)}:tokens`, initiativeId: r.initiativeId, boxId: null, actorId: r.invitedBy,
        trigger: 'meeting-assistant-delegation', model, costUsd, costBasis: costUsd == null ? 'unknown' : reported ? 'reported' : 'estimated', provider: 'openai',
        inputTokens: i.tokens.input, outputTokens: i.tokens.output, estimatedCostUsd: costUsd,
      });
    }
  },
};

let spend: AssistantSpend = realSpend;
export function assistantSpend(): AssistantSpend { return spend; }
export function setAssistantSpend(next: AssistantSpend | null): void { spend = next ?? realSpend; }

/** Listening seconds as of `now`: the closed periods plus the open one. */
export function listeningSecondsOf(record: Pick<AssistantRecord, 'session'>, now: number): number {
  const s = sessionOf(record);
  return s.listeningSeconds + (s.listeningSince != null ? Math.max(0, (now - s.listeningSince) / 1000) : 0);
}

/**
 * Nova left: release the extension holds and book the ledger rows, once (`session.settled`). Called by the runtime when a
 * call's run ends. A failure is logged and leaves `settled` false; the hold then expires on its own.
 */
export async function settleFinished(e: { callId: string; usageSeconds: number; tokens: { input: number; output: number; cached: number }; sessionKind: 'openai' | 'scripted' }, now: number = Date.now()): Promise<void> {
  const store = assistantStore();
  const record = await store.get(e.callId);
  if (!record) return;
  const s = sessionOf(record);
  if (s.settled) return;
  // Claim the settlement first so two stops cannot book twice; give it back if the ledger write fails.
  await store.patchSession(e.callId, { settled: true });
  try {
    await assistantSpend().settle({ record, usageSeconds: e.usageSeconds, tokens: e.tokens, sessionKind: e.sessionKind, listeningSeconds: listeningSecondsOf(record, now) });
    await assistantSpend().release(s.holds);
  } catch (err) {
    await store.patchSession(e.callId, { settled: false });
    console.warn('[meeting-assistant] spend settlement failed', (err as Error).message);
  }
}
