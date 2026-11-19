// What an interview spends, and the one door its callers use (docs/interviews-tenant-plan.md decision 18, row I0.6).
//
// Milo's listening, the coach's calls, speech and code runs in an interview are paid by the interview's OPENING, never by
// an initiative or a person. The money goes through the same chokepoints as every other spend: a hold before the first
// side effect (lib/spend-holds.ts `reserveSpend`, source `interviews`), a ledger row after (providers/spend-ledger.ts
// `recordSpend`, which settles the hold), and the run meter (`meterForHold`) for a run that may overrun its hold.
//
// ── How an opening carries its caps ─────────────────────────────────────────────────────────────────────────────────
//   budgetCapUsd      the opening's cap, across all its interviews. Null: no cap is set, and nothing that costs money
//                     starts in its interviews (the refusal tells the recruiter to set one).
//   interviewCapUsd   the cap per interview. Null: the deployment's default, `INTERVIEWS_INTERVIEW_CAP_USD`
//                     (DEFAULT_INTERVIEW_CAP_USD when unset): an hour of Milo listening plus the coach, speech and runs.
// A hold is judged against both, by what the interview and the opening have already held and spent, under one lock per
// opening (`interviews:opening:<id>`), so two holds racing at either cap cannot both pass. It is NOT judged by the
// initiative allocation brake, an envelope or anyone's user budget, and it takes no budget threshold. The kill switches
// and the run limits (the `interviews` tenant's) apply as to every run. Caps are lifetime figures: an opening is hired
// for once, so there is no monthly period.
//
// ── What a hold names ───────────────────────────────────────────────────────────────────────────────────────────────
// Its source id: `iv:<openingId>:<interviewId>:<part>:<key>` from this door (part: listening, coach, speech, run; key:
// the caller's own, unique per attempt), with `#topup-<n>` appended by the run meter. When an interview call's
// meeting-assistant policy names this source (row I3.2, `interviewsPayer`), the meeting assistant keeps its own ids
// (`ma:<callId>…`); those are tied to their interview by the interview's `callId`, else by the call's lobby
// (`interviews:interview:<id>`), live or kept on Milo's record. No new column on the shared spend tables.
// Holds carry no actor; ledger rows keep who caused them for the record, and every per-person reader skips this source.
//
// ── Who reads it ────────────────────────────────────────────────────────────────────────────────────────────────────
// The opening's figures (`openingMoney`) are served by GET /api/interviews/openings/:id/spend to the recruiter, the
// opening's hiring manager and the cross-tenant admin; an interviewer gets a not-found. Work's spend report leaves the
// source out except for the admin (providers/spend-report.ts), and GET /api/me/spend and user budgets never count it.

import type { SpendSource } from '../../providers/spend-ledger.js';
import type { Payer } from '../meeting-assistant/policy.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type InterviewsWorld, type Opening } from './types.js';

export const INTERVIEWS_SOURCE: SpendSource = 'interviews';

/** What an interview spends on. */
/** `tools`: Milo's interview tools (the solution check behind a helper or a batch of cases; milo-tools/verdict.ts). */
export type InterviewSpendPart = 'listening' | 'coach' | 'speech' | 'run' | 'tools';
export const INTERVIEW_SPEND_PARTS: readonly InterviewSpendPart[] = ['listening', 'coach', 'speech', 'run', 'tools'];

/** The cap per interview when an opening sets none: an hour of Milo listening (about $3) and room for the coach, speech and runs. */
export const DEFAULT_INTERVIEW_CAP_USD = 10;

/** `INTERVIEWS_INTERVIEW_CAP_USD`: the deployment's cap per interview, a non-negative number of dollars. */
export function defaultInterviewCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['INTERVIEWS_INTERVIEW_CAP_USD'] ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVIEW_CAP_USD;
}

/** The cap per interview an opening enforces: its own, else the deployment's. */
export const interviewCapOf = (o: Pick<Opening, 'interviewCapUsd'>): number => o.interviewCapUsd ?? defaultInterviewCapUsd();

/** One interview, and the opening that pays for it. */
export interface InterviewRef { openingId: string; interviewId: string }

const ID = /^[A-Za-z0-9._-]+$/;
const TOPUP = /#topup-\d+$/;

/** The source id of one attempt at one part of an interview's spend. Ids and key must not hold `:` or `#`. */
export function interviewSpendSourceId(ref: InterviewRef, part: InterviewSpendPart, key: string): string {
  for (const v of [ref.openingId, ref.interviewId, key]) {
    if (!ID.test(v)) throw new Error(`an interview spend key part may hold letters, digits, dot, dash and underscore only: ${JSON.stringify(v)}`);
  }
  return `iv:${ref.openingId}:${ref.interviewId}:${part}:${key}`;
}

/** The parts of a door source id (a top-up's included); null for anything else. */
export function parseInterviewSourceId(sourceId: string): (InterviewRef & { part: InterviewSpendPart; key: string }) | null {
  const m = /^iv:([^:#]+):([^:#]+):([a-z]+):([^:#]+)$/.exec(sourceId.replace(TOPUP, ''));
  if (!m || !INTERVIEW_SPEND_PARTS.includes(m[3] as InterviewSpendPart)) return null;
  return { openingId: m[1]!, interviewId: m[2]!, part: m[3] as InterviewSpendPart, key: m[4]! };
}

/** The call a meeting-assistant source id is for (`ma:<call>`, `…:x<n>`, `…:tokens`, `…:minutes…`, `…:watch:<n>`, top-ups). */
export function callOfMeetingSourceId(sourceId: string): string | null {
  const sid = sourceId.replace(TOPUP, '');
  if (!sid.startsWith('ma:')) return null;
  const m = /^ma:(.+?)(?::minutes(?::\d+:\d+)?|:watch:\d+|(?::x\d+)?(?::tokens)?)$/.exec(sid);
  return m ? m[1]! : null;
}

const LOBBY = /^interviews:interview:([^:]+)$/;

/** The interview a call is for, from its lobby: the live call's, else the one Milo's record kept. */
async function interviewOfCall(callId: string): Promise<string | null> {
  let lobby: string | null = null;
  try {
    const { callChatRuntime } = await import('../call-chat.js');
    lobby = await callChatRuntime().lobbyOf(callId);
  } catch { lobby = null; }
  if (!lobby) {
    try {
      const { assistantStore } = await import('../meeting-assistant/store-select.js');
      lobby = (await assistantStore().get(callId))?.lobby ?? null;
    } catch { lobby = null; }
  }
  return lobby ? LOBBY.exec(lobby)?.[1] ?? null : null;
}

/** Who answers for one world: each interview's opening, and each call's interview. */
class Attribution {
  private readonly openingOf = new Map<string, string>();
  private readonly byCall = new Map<string, string | null>();
  constructor(readonly world: InterviewsWorld) {
    const appOpening = new Map(world.applications.map((a) => [a.id, a.openingId]));
    for (const i of world.interviews) {
      const o = appOpening.get(i.applicationId);
      if (o) this.openingOf.set(i.id, o);
      if (i.callId) this.byCall.set(i.callId, i.id);
    }
  }

  ref(interviewId: string): InterviewRef | null {
    const openingId = this.openingOf.get(interviewId);
    return openingId ? { openingId, interviewId } : null;
  }

  /** The interview a hold's or a ledger row's source id belongs to; null when it names none in this world. */
  async of(sourceId: string | null): Promise<InterviewRef | null> {
    if (!sourceId) return null;
    const door = parseInterviewSourceId(sourceId);
    if (door) {
      const ref = this.ref(door.interviewId);
      // The id names its opening; an interview is never moved between openings, so a mismatch is not this interview's.
      return ref && ref.openingId === door.openingId ? ref : null;
    }
    const callId = callOfMeetingSourceId(sourceId);
    if (!callId) return null;
    if (!this.byCall.has(callId)) this.byCall.set(callId, await interviewOfCall(callId));
    const iv = this.byCall.get(callId);
    return iv ? this.ref(iv) : null;
  }
}

async function attribution(): Promise<Attribution> {
  return new Attribution(await loadWorld(interviewsStore()));
}

/** The interview a hold is for, and the opening that pays; null when the source id names no interview. */
export async function interviewOfSpend(sourceId: string | null): Promise<InterviewRef | null> {
  return (await attribution()).of(sourceId);
}

interface Money { spentUsd: number; heldUsd: number; unknownCount: number }
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const zero = (): Money => ({ spentUsd: 0, heldUsd: 0, unknownCount: 0 });

/** Every interviews hold and ledger row, summed per interview and per opening. */
async function sums(a: Attribution, opts: { held: boolean }): Promise<{ byInterview: Map<string, Money>; byOpening: Map<string, Money> }> {
  const { ledgerRowsForSource } = await import('../../providers/spend-ledger.js');
  const { openHoldsForSource } = await import('../../providers/spend-holds.js');
  const [entries, holds] = await Promise.all([ledgerRowsForSource(INTERVIEWS_SOURCE), opts.held ? openHoldsForSource(INTERVIEWS_SOURCE) : Promise.resolve([])]);
  const byInterview = new Map<string, Money>();
  const byOpening = new Map<string, Money>();
  const add = (ref: InterviewRef, f: (m: Money) => void) => {
    for (const [map, key] of [[byInterview, ref.interviewId], [byOpening, ref.openingId]] as const) {
      const m = map.get(key) ?? zero();
      f(m);
      map.set(key, m);
    }
  };
  for (const e of entries) {
    const ref = await a.of(e.sourceId);
    if (!ref) continue;
    add(ref, (m) => { if (e.costUsd == null) m.unknownCount += 1; else m.spentUsd = round4(m.spentUsd + e.costUsd); });
  }
  for (const h of holds) {
    const ref = await a.of(h.sourceId);
    if (ref) add(ref, (m) => { m.heldUsd = round4(m.heldUsd + h.amountUsd); });
  }
  return { byInterview, byOpening };
}

/** What a hold is judged against. */
export interface InterviewSpendState {
  openingCapUsd: number | null;
  interviewCapUsd: number;
  opening: { spentUsd: number; heldUsd: number };
  interview: { spentUsd: number; heldUsd: number };
}

/** The caps and the money already held and spent, for one interview and its opening. `held: false` reads no holds (holds off). */
export async function interviewSpendState(ref: InterviewRef, opts: { held: boolean } = { held: true }): Promise<InterviewSpendState> {
  const a = await attribution();
  const opening = a.world.openings.find((o) => o.id === ref.openingId);
  if (!opening) throw new Error('the opening behind an interview is gone');
  const s = await sums(a, opts);
  const iv = s.byInterview.get(ref.interviewId) ?? zero();
  const op = s.byOpening.get(ref.openingId) ?? zero();
  return {
    openingCapUsd: opening.budgetCapUsd, interviewCapUsd: interviewCapOf(opening),
    opening: { spentUsd: op.spentUsd, heldUsd: op.heldUsd }, interview: { spentUsd: iv.spentUsd, heldUsd: iv.heldUsd },
  };
}

export type InterviewHoldDecision =
  | { kind: 'proceed' }
  | { kind: 'no-cap' }
  | { kind: 'capped'; gate: 'interview-cap' | 'opening-cap'; capUsd: number; spentUsd: number; heldUsd: number };

/** Pure: may `amountUsd` more be held? The interview's cap is judged first, then the opening's; reaching a cap exactly is allowed. */
export function decideInterviewHold(s: InterviewSpendState, amountUsd: number): InterviewHoldDecision {
  if (s.openingCapUsd == null) return { kind: 'no-cap' };
  const over = (cap: number, m: { spentUsd: number; heldUsd: number }) => round4(m.spentUsd + m.heldUsd + amountUsd) > cap + 1e-9;
  if (over(s.interviewCapUsd, s.interview)) return { kind: 'capped', gate: 'interview-cap', capUsd: s.interviewCapUsd, ...s.interview };
  if (over(s.openingCapUsd, s.opening)) return { kind: 'capped', gate: 'opening-cap', capUsd: s.openingCapUsd, ...s.opening };
  return { kind: 'proceed' };
}

/** The opening's money as its page shows it. `leftUsd` is null while no cap is set. */
export interface OpeningMoney {
  capUsd: number | null;
  /** The opening's own cap per interview; null when it takes the default. */
  interviewCapUsd: number | null;
  /** The deployment's cap per interview, for the form's hint. */
  defaultInterviewCapUsd: number;
  /** The cap per interview in force. */
  effectiveInterviewCapUsd: number;
  spentUsd: number;
  heldUsd: number;
  leftUsd: number | null;
  /** Ledger rows whose cost is not known yet (their holds stay open until they expire). */
  unknownCount: number;
}

export async function openingMoney(opening: Opening): Promise<OpeningMoney> {
  const a = await attribution();
  const { byOpening } = await sums(a, { held: true });
  const m = byOpening.get(opening.id) ?? zero();
  const cap = opening.budgetCapUsd;
  return {
    capUsd: cap, interviewCapUsd: opening.interviewCapUsd, defaultInterviewCapUsd: defaultInterviewCapUsd(),
    effectiveInterviewCapUsd: interviewCapOf(opening), spentUsd: m.spentUsd, heldUsd: m.heldUsd,
    leftUsd: cap == null ? null : Math.max(0, round4(cap - m.spentUsd - m.heldUsd)), unknownCount: m.unknownCount,
  };
}

// ── The door (rows I3.2, I3.3, I3.5, I4.4 call these) ───────────────────────────────────────────────────────────────

export interface InterviewReserveInput {
  interviewId: string;
  part: InterviewSpendPart;
  /** The caller's own key for this attempt (a request id, a run id), unique within the interview and part. */
  key: string;
  /** The p75 of what this attempt may cost, in dollars. */
  estimateUsd: number;
  /** The attempt's ceiling plus grace: the hold expires on its own after this. */
  expiresInMs: number;
}

export type InterviewReserveOutcome =
  | { ok: true; holdId: string | null; sourceId: string; amountUsd: number }
  | { ok: false; refusal: { status: number; body: Record<string, unknown>; headers?: Record<string, string> } };

/** Hold money for one attempt at one part of an interview, against its opening. A refusal is the HTTP answer to give. */
export async function reserveInterviewSpend(i: InterviewReserveInput): Promise<InterviewReserveOutcome> {
  const { reserveSpend, spendRefusalResponse } = await import('../spend-holds.js');
  const { interviewSpendRefusal } = await import('../spend-refusal.js');
  const ref = (await attribution()).ref(i.interviewId);
  if (!ref) return { ok: false, refusal: spendRefusalResponse({ kind: 'refused', reason: interviewSpendRefusal({ kind: 'no-interview' }) }) };
  const sourceId = interviewSpendSourceId(ref, i.part, i.key);
  const est = Math.max(0, i.estimateUsd);
  const held = await reserveSpend({
    initiativeId: null, actorId: null, source: INTERVIEWS_SOURCE, sourceId,
    forecast: { costUsdP75: est, costUsdP25: round4(est / 4), confidence: 'prior' },
    expiresInMs: i.expiresInMs, tenant: INTERVIEWS_TENANT,
  });
  if (held.kind === 'held') return { ok: true, holdId: held.holdId, sourceId, amountUsd: held.amountUsd };
  const out = spendRefusalResponse(held, { estimateUsd: est });
  return { ok: false, refusal: { status: out.status, body: out.body, ...(out.headers ? { headers: out.headers } : {}) } };
}

export interface InterviewSettleInput {
  /** The hold's source id, from `reserveInterviewSpend`. */
  sourceId: string;
  costUsd: number | null;
  basis: 'reported' | 'estimated' | 'unknown';
  model: string | null;
  /** Who caused it, kept on the row for the record; it counts against nobody. */
  actorId?: string | null;
  provider?: 'bedrock' | 'openai' | 'local' | null;
  inputTokens?: number;
  outputTokens?: number;
}

/** Book what the attempt cost. A known cost settles its hold (and its top-ups); an unknown one leaves the hold to expire. */
export async function settleInterviewSpend(i: InterviewSettleInput): Promise<void> {
  const parsed = parseInterviewSourceId(i.sourceId);
  if (!parsed) throw new Error('settleInterviewSpend takes a source id from reserveInterviewSpend');
  const { recordSpend } = await import('../../providers/spend-ledger.js');
  await recordSpend({
    source: INTERVIEWS_SOURCE, sourceId: i.sourceId.replace(TOPUP, ''), initiativeId: null, boxId: null, actorId: i.actorId ?? null,
    trigger: `interviews:${parsed.part}`, model: i.model, costUsd: i.costUsd, costBasis: i.basis,
    ...(i.provider ? { provider: i.provider } : {}),
    ...(i.inputTokens !== undefined ? { inputTokens: i.inputTokens } : {}),
    ...(i.outputTokens !== undefined ? { outputTokens: i.outputTokens } : {}),
    ...(i.costUsd !== null ? { estimatedCostUsd: i.costUsd } : {}),
  });
}

/** An attempt that never started gives its money back. */
export async function releaseInterviewSpend(holdIds: readonly (string | null)[]): Promise<void> {
  const { releaseHold } = await import('../../providers/spend-holds.js');
  for (const id of holdIds) await releaseHold(id);
}

/**
 * The run meter for an attempt that may overrun its hold (a run, a long coach call): top-ups are judged by the same caps
 * under the same lock, and a refused top-up cuts the attempt off. Null when the attempt holds nothing or cut-off is off.
 */
export async function meterInterviewSpend(i: {
  holdId: string | null; amountUsd: number; sourceId: string; model: string | null; expiresInMs: number;
  onCut?: Parameters<typeof import('../spend-holds.js').meterForHold>[0]['onCut'];
}) {
  const { meterForHold } = await import('../spend-holds.js');
  return meterForHold({
    holdId: i.holdId, amountUsd: i.amountUsd, initiativeId: null, actorId: null, source: INTERVIEWS_SOURCE,
    sourceId: i.sourceId, model: i.model, expiresInMs: i.expiresInMs, ...(i.onCut ? { onCut: i.onCut } : {}),
  });
}

/**
 * The meeting-assistant `payer` for an interview call (row I3.2 returns this from its policy): the opening pays, under
 * this source, on no initiative. `actorId` stays the inviter so the ledger keeps who asked; no per-person reader counts it.
 */
export function interviewsPayer(period: { inviterId: string }): Payer {
  return { actorId: period.inviterId, initiativeId: null, source: INTERVIEWS_SOURCE };
}
