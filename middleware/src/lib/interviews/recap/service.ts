// Milo's recap (docs/interviews-tenant-plan.md decisions 6, 14, 18; row I5.2; contract E3).
//
// `openRecap` is what a seat's "Continue to the recap" posts. It stores that person's ratings as they stand (first open
// only: rate first, then the recap, decision 14), then answers the recap. The FIRST open of the interview is what writes
// it, once, kept:
//   consent   read with the coach's `coachConsents`. No transcript accepted: `no-transcript`, no model call. The
//             transcript accepted but Milo declined: `none`, no model call (stricter reading: the recap is Milo's work).
//   words     the transcript through `setRecapDeps({ transcript })` (default the coach's `assistantTranscript`; the
//             integrator points it at the record's reader, E1). No lines: `no-transcript`, no model call.
//   money     a hold with `reserveInterviewSpend` (part `coach`, key `recap-<attempt>-<suffix>`); refused: `paused`
//             with `paused: 'budget'`, no call, nothing stored, the next open tries again.
//   model     the recap model (model.ts), parsed by parse.ts; the hold settled (or released when nothing was sent).
//   attempts  at most RECAP_MAX_ATTEMPTS per interview, ever, one in flight. Each attempt is claimed in the store
//             before its call (`putAttempt`), so the count survives a restart and two processes cannot both make the
//             same attempt. A dropped attempt (malformed, judging, personal, timed out, failed) is given its code and its
//             text is never kept; the open tries again at once while attempts remain. The last attempt failing writes a
//             `failed` row: readers see `none` from then on. Writing either row clears the attempts.
// `readRecap` never writes: it answers the stored recap, or `no-transcript` / `none`.
//
// Who may open and who may read is the route's (routes/interviews/recap.ts). Nothing of the transcript, the prompt, the
// answer or a dropped attempt's text is logged; console lines carry codes only.
import { randomBytes } from 'node:crypto';
import { estimateUsageCost } from '../../pricing.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { DEFAULT_COACH_MODEL_ID, type CoachModelResult } from '../coach/model.js';
import { coachConsents } from '../coach/service.js';
import { suggestionStore } from '../coach/store.js';
import { assistantTranscript, type TranscriptSource } from '../coach/transcript.js';
import { recordTranscript } from '../record/transcript.js';

/** E1: the recap reads the interview record's transcript (which holds the mock world's seeded lines), else Milo's call record. */
const recordOrAssistantTranscript: TranscriptSource = async (i) => {
  const r = await recordTranscript(i);
  return r ? { callId: r.callId, lastSeq: r.lines.at(-1)?.seq ?? 0, lines: r.lines.map(({ seq, side, text }) => ({ seq, side, text })) } : assistantTranscript(i);
};
import type { CoachLine } from '../coach/prompt.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend, type InterviewReserveInput, type InterviewReserveOutcome, type InterviewSettleInput } from '../spend.js';
import { INTERVIEWS_TENANT, type Interview, type Opening } from '../types.js';
import { estimateRecapTokens, makeRecapModel, RECAP_TIMEOUT_MS, type RecapModel } from './model.js';
import { parseRecapAnswer, type RecapContent } from './parse.js';
import { RECAP_MAX_LINES, RECAP_PROMPT_VERSION, type RecapInput, type RecapQuestion } from './prompt.js';
import { recapStore, type OpenRating, type RecapAttemptCode, type RecapOpen, type RecapRecord, type RecapStore } from './store.js';
import { interviewsNowMs } from '../clock.js';

/** At most this many model calls per interview, ever (one recap, kept). */
export const RECAP_MAX_ATTEMPTS = 3;

/** E3's answer. */
export interface RecapBody {
  state: 'ready' | 'none' | 'no-transcript' | 'paused';
  paused: null | 'budget';
  writtenAt: string | null;
  competencies: { id: string; name: string; evidence: { text: string; source: { kind: 'transcript'; seq: number; quote: string } }[] }[];
  notCovered: { id: string; name: string }[];
}

export interface RecapDeps {
  store: () => RecapStore;
  consents: (interviewId: string) => Promise<{ transcription: boolean; milo: boolean } | null>;
  transcript: TranscriptSource;
  /** The suggestions the lead took (asked, or had Milo ask), read from the coach's log. */
  taken: (interviewId: string) => Promise<{ text: string; competencyId: string; answer: 'ask' | 'milo-ask' }[]>;
  model: () => RecapModel;
  reserve: (i: InterviewReserveInput) => Promise<InterviewReserveOutcome>;
  settle: (i: InterviewSettleInput) => Promise<void>;
  release: (holdIds: readonly (string | null)[]) => Promise<void>;
  now: () => number;
  suffix: () => string;
}

const defaultTaken: RecapDeps['taken'] = async (interviewId) => {
  const rows = await runWithDbTenant(INTERVIEWS_TENANT, () => suggestionStore().listSuggestions(interviewId));
  return rows.filter((r) => r.dropped === null && r.competencyId !== null && (r.answer === 'ask' || r.answer === 'milo-ask'))
    .map((r) => ({ text: r.text, competencyId: r.competencyId!, answer: r.answer as 'ask' | 'milo-ask' }));
};

const DEFAULTS: RecapDeps = {
  store: recapStore,
  consents: coachConsents,
  transcript: recordOrAssistantTranscript,
  taken: defaultTaken,
  model: makeRecapModel,
  reserve: reserveInterviewSpend,
  settle: settleInterviewSpend,
  release: releaseInterviewSpend,
  now: interviewsNowMs,
  suffix: () => randomBytes(4).toString('hex'),
};

let overrides: Partial<RecapDeps> = {};
/** The integrator (E1: `transcript`) and tests: replace some dependencies; `null` puts every default back. */
export function setRecapDeps(next: Partial<RecapDeps> | null): void { overrides = next ?? {}; }
const deps = (): RecapDeps => ({ ...DEFAULTS, ...overrides });

/** The interview and the opening that holds its kit, found by the route. */
export interface RecapRef { interview: Interview; opening: Opening }

const inFlight = new Map<string, Promise<RecapBody>>();
/** Tests: forget what this process holds in memory (the call in flight), as a restart would. The attempts are the store's. */
export function resetRecapAttempts(): void { inFlight.clear(); }

const iso = (ms: number): string => new Date(ms).toISOString();

const emptyBody = (state: RecapBody['state']): RecapBody => ({ state, paused: state === 'paused' ? 'budget' : null, writtenAt: null, competencies: [], notCovered: [] });

/** The stored recap as E3's body, with the kit's names, in the kit's order. */
export function recapBody(row: RecapRecord | null, opening: Opening): RecapBody {
  if (!row || row.state !== 'ready') return emptyBody('none');
  const kit = opening.kit.competencies;
  const byId = new Map(row.content.competencies.map((c) => [c.id, c]));
  return {
    state: 'ready', paused: null, writtenAt: row.writtenAt,
    competencies: kit.filter((k) => byId.get(k.id)?.evidence.length).map((k) => ({
      id: k.id, name: k.name,
      evidence: byId.get(k.id)!.evidence.map((e) => ({ text: e.text, source: { kind: 'transcript' as const, seq: e.seq, quote: e.quote } })),
    })),
    // Every other competency of the kit: listed as not covered, left with no claim, or added to the kit afterwards.
    notCovered: kit.filter((k) => !byId.get(k.id)?.evidence.length).map((k) => ({ id: k.id, name: k.name })),
  };
}

/** What the recap reads: the kit, the questions asked (chosen first, then the suggestions taken), the lines. */
export function recapInput(ref: RecapRef, lines: readonly CoachLine[], taken: Awaited<ReturnType<RecapDeps['taken']>>): RecapInput {
  const kit = ref.opening.kit;
  const bank = new Map(kit.questions.map((q) => [q.id, q]));
  const chosen: RecapQuestion[] = ref.interview.questionIds.map((id) => bank.get(id)).filter((q): q is NonNullable<typeof q> => !!q)
    .map((q) => ({ text: q.prompt, competencyId: q.competencyId, how: 'chosen' }));
  return {
    competencies: kit.competencies.map((c) => ({ id: c.id, name: c.name, lookFor: c.lookFor, anchors: c.anchors })),
    questions: [...chosen, ...taken.map((t): RecapQuestion => ({ text: t.text, competencyId: t.competencyId, how: t.answer }))],
    lines: lines.filter((l) => l.text.trim().length > 0).slice(-RECAP_MAX_LINES),
  };
}

/** What one attempt may cost, in dollars: the request's estimated tokens at the model's price (Nova Pro's for the stand-in). */
export function recapEstimateUsd(model: Pick<RecapModel, 'modelId'>, input: RecapInput): number {
  const tokens = estimateRecapTokens(input);
  return estimateUsageCost(model.modelId, tokens) ?? estimateUsageCost(DEFAULT_COACH_MODEL_ID, tokens) ?? 0.05;
}

async function book(d: RecapDeps, model: RecapModel, input: RecapInput, held: { holdId: string | null; sourceId: string }, result: CoachModelResult, actor: string): Promise<void> {
  try {
    if (!result.sent) { await d.release([held.holdId]); return; }
    if (model.kind === 'scripted') {
      await d.settle({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model: model.modelId, actorId: actor, provider: 'local' });
      return;
    }
    const usage = result.usage ?? estimateRecapTokens(input);
    const cost = estimateUsageCost(model.modelId, usage);
    await d.settle({
      sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model: model.modelId, actorId: actor, provider: 'bedrock',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    });
  } catch (e) {
    console.warn('[interviews] recap spend not booked', (e as Error)?.name ?? 'error');
  }
}

/** Write the recap now if it can be: the consent, the words, then up to the attempts left. */
async function write(d: RecapDeps, ref: RecapRef, actor: string): Promise<RecapBody> {
  const { interview, opening } = ref;
  const store = d.store();
  const consent = await d.consents(interview.id);
  if (!consent?.transcription) return emptyBody('no-transcript');
  if (!consent.milo) return emptyBody('none');
  const transcript = await d.transcript({ id: interview.id, callId: interview.callId });
  const input = recapInput(ref, transcript?.lines ?? [], await d.taken(interview.id));
  if (!input.lines.length) return emptyBody('no-transcript');

  const model = d.model();
  // The attempts already made, by any process: an attempt whose call never came back still counts.
  const made = await store.listAttempts(interview.id);
  const count = { n: made.reduce((m, a) => Math.max(m, a.attempt), 0), codes: made.flatMap((a) => (a.code ? [a.code] : [])) };
  while (count.n < RECAP_MAX_ATTEMPTS) {
    const attempt = count.n + 1;
    const held = await d.reserve({
      interviewId: interview.id, part: 'coach', key: `recap-${attempt}-${d.suffix()}`,
      estimateUsd: recapEstimateUsd(model, input), expiresInMs: RECAP_TIMEOUT_MS * 2 + 30_000,
    });
    if (!held.ok) return emptyBody('paused');
    count.n = attempt;
    if (!await store.putAttempt({ interviewId: interview.id, attempt, code: null, madeAt: iso(d.now()) })) {
      // Another open made this attempt first: it counts, and this one makes no call for it.
      await book(d, model, input, held, { raw: null, code: 'error', sent: false, usage: null }, actor);
      continue;
    }
    let result: CoachModelResult;
    try { result = await model.write(input); } catch { result = { raw: null, code: 'error', sent: false, usage: null }; }
    await book(d, model, input, held, result, actor);
    const parsed = result.code === 'ok'
      ? parseRecapAnswer(result.raw, { competencyIds: opening.kit.competencies.map((c) => c.id), lines: input.lines })
      : { ok: false as const, code: (result.code === 'timeout' ? 'timeout' : 'error') as RecapAttemptCode };
    if (parsed.ok) {
      const row: RecapRecord = {
        interviewId: interview.id, state: 'ready', content: parsed.recap, writtenAt: iso(d.now()), modelId: model.modelId,
        promptVersion: RECAP_PROMPT_VERSION, attempts: attempt, droppedCodes: [...count.codes], droppedClaims: parsed.droppedClaims,
      };
      const kept = await store.putRecap(row);
      await store.clearAttempts(interview.id);
      return recapBody(kept.row, opening);
    }
    count.codes.push(parsed.code);
    await store.setAttemptCode(interview.id, attempt, parsed.code);
    console.warn('[interviews] recap attempt dropped', parsed.code);
  }
  const failed: RecapRecord = {
    interviewId: interview.id, state: 'failed', content: { competencies: [], notCovered: [] } satisfies RecapContent, writtenAt: iso(d.now()),
    modelId: model.modelId, promptVersion: RECAP_PROMPT_VERSION, attempts: count.n, droppedCodes: [...count.codes], droppedClaims: 0,
  };
  const kept = await store.putRecap(failed);
  await store.clearAttempts(interview.id);
  return recapBody(kept.row, opening);
}

/**
 * Each competency of `required` (default: the whole kit) rated once, 1 to 4, any other kit competency at most once, and
 * nothing else: the ratings an open stores, in the kit's order; null when they are not (E4 #30: the round's own).
 */
export function checkOpenRatings(body: unknown, opening: Opening, required: readonly string[] = opening.kit.competencies.map((k) => k.id)): OpenRating[] | null {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['ratings'] : undefined;
  if (!Array.isArray(raw)) return null;
  const kit = opening.kit.competencies;
  const seen = new Map<string, OpenRating['rating']>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const { competencyId, rating } = r as Record<string, unknown>;
    if (typeof competencyId !== 'string' || !kit.some((k) => k.id === competencyId) || seen.has(competencyId)) return null;
    if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) return null;
    seen.set(competencyId, rating);
  }
  if (required.some((id) => !seen.has(id))) return null;
  return kit.filter((k) => seen.has(k.id)).map((k) => ({ competencyId: k.id, rating: seen.get(k.id)! }));
}

/**
 * E3's open, for a seat once the interview has ended (the route checks both): store `ratings` for (interview, viewer)
 * the first time only, then answer the recap, writing it when it is not there yet.
 */
export async function openRecap(ref: RecapRef, viewer: { userId: string }, ratings: readonly OpenRating[]): Promise<RecapBody> {
  const d = deps();
  const store = d.store();
  await store.putOpen({ interviewId: ref.interview.id, interviewerId: viewer.userId, ratings: ratings.map((r) => ({ ...r })), openedAt: iso(d.now()) });
  const stored = await store.getRecap(ref.interview.id);
  if (stored) return recapBody(stored, ref.opening);
  // One writer per interview: a second open while the first is writing waits for the same answer.
  const running = inFlight.get(ref.interview.id);
  if (running) return running;
  const job = write(d, ref, viewer.userId).finally(() => inFlight.delete(ref.interview.id));
  inFlight.set(ref.interview.id, job);
  return job;
}

/** E3's read: the stored recap, else `no-transcript` when the candidate declined the transcript, else `none`. Never writes. */
export async function readRecap(ref: RecapRef): Promise<RecapBody> {
  const d = deps();
  const stored = await d.store().getRecap(ref.interview.id);
  if (stored) return recapBody(stored, ref.opening);
  const consent = await d.consents(ref.interview.id);
  return emptyBody(consent && !consent.transcription ? 'no-transcript' : 'none');
}

/** The ratings `userId` had when they first opened this interview's recap; null when they never opened it. */
export async function ratingsAtRecap(interviewId: string, userId: string): Promise<OpenRating[] | null> {
  return (await deps().store().getOpen(interviewId, userId))?.ratings ?? null;
}

/** Remove these interviews' recaps and opens (a record-class eraser); how many rows went. */
export async function eraseRecapRows(interviewIds: readonly string[]): Promise<number> {
  return deps().store().eraseRecaps(interviewIds);
}

/** The interview's recap as kept, and who opened it when with which ratings: what an export holds. */
export async function exportRecapRows(interviewId: string): Promise<{ recap: RecapRecord | null; opens: RecapOpen[] }> {
  const store = deps().store();
  return { recap: await store.getRecap(interviewId), opens: await store.listOpens(interviewId) };
}
