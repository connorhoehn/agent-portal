// The coach for the lead (docs/interviews-tenant-plan.md decisions 6, 7, 8, 18, 20; row I3.3; contract D7).
//
// `suggestionFor` is what the lead's room reads: the rules (rules.ts), then, only when they say think, a hold on the
// interview's opening for the part `coach` (a refused hold makes no call and answers `paused: 'budget'`), the model, the
// money settled or released, the log, and the view. One call in flight per interview. A read is what makes the coach
// think: it starts no timer and hooks nothing.
//
// `answerSuggestion` records the lead's answer once. `milo-ask` is logged as that answer with `spoken: false`, written in the
// said log (speak/index.ts), posted in the call's chat with the approved mark when Milo is in the call, and then said aloud on
// the call's own live session as approved words (row I3.5, decision 9); `spoken` is set only when the words were relayed.
//
// Nothing of the transcript, the prompt, the answer or a dropped suggestion's text is logged anywhere but the log's own
// row; console lines carry codes only.
import { randomBytes } from 'node:crypto';
import { estimateUsageCost } from '../../pricing.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { consentStore } from '../consent/store.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend, type InterviewReserveInput, type InterviewReserveOutcome, type InterviewSettleInput } from '../spend.js';
import { INTERVIEWS_TENANT, type Interview, type Opening } from '../types.js';
import { COACH_TIMEOUT_MS, DEFAULT_COACH_MODEL_ID, estimateCoachTokens, makeCoachModel, type CoachModel, type CoachModelResult } from './model.js';
import { parseCoachAnswer, type ParseResult } from './parse.js';
import { COACH_PROMPT_VERSION, MAX_PREVIOUS, codeLinesOf, coachCode, type CoachCode, type CoachInput, type CoachLine } from './prompt.js';
import type { RunView } from '../runs/service.js';
import { decideCoach, RETRY_WAITING_MS, SUGGESTION_GAP_MS } from './rules.js';
import { CLARIFYING_MODEL_ID, CLARIFYING_RULE_VERSION, askedWords, clarifyingNudge, type ClarifyNudge } from './clarifying.js';
import { roundSurface } from '../kit.js';
import { suggestionStore, type SuggestionAnswer, type SuggestionRecord, type SuggestionStore } from './store.js';
import { assistantTranscript, type CoachTranscript, type TranscriptSource } from './transcript.js';
import { interviewsNowMs } from '../clock.js';
import { logAndPost, sayLogged, type NotAloudWhy } from '../speak/index.js';

/** D7's view of a suggestion. */
export interface SuggestionView { id: string; text: string; competency: { id: string; name: string }; basedOn: string | null; shownAt: string }
/** D7's answer to the read. */
export interface SuggestionBody { suggestion: SuggestionView | null; paused: null | 'budget' | 'model'; retryAfterMs: number }

export interface CoachDeps {
  store: () => SuggestionStore;
  consents: (interviewId: string) => Promise<{ transcription: boolean; milo: boolean } | null>;
  transcript: TranscriptSource;
  model: () => CoachModel;
  reserve: (i: InterviewReserveInput) => Promise<InterviewReserveOutcome>;
  settle: (i: InterviewSettleInput) => Promise<void>;
  release: (holdIds: readonly (string | null)[]) => Promise<void>;
  /** Row I3.5: log, post and mark the words (speak/index.ts `logAndPost`), then say them aloud; absent in a test means the defaults. */
  speak?: { post: typeof logAndPost; say: typeof sayLogged };
  now: () => number;
  newId: () => string;
}

/**
 * D4: the coach runs only when the candidate accepted the transcript and Milo. The same read and rule as
 * lib/interviews/consent/index.ts `consentsFor` (Milo held to the transcript whatever a row says), made here from the
 * consent store because importing that index registers the knock precondition and Milo's consent source as a side
 * effect, which is the integrator's wiring, not this module's. __tests__/service.test.ts checks the two agree.
 */
export async function coachConsents(interviewId: string): Promise<{ transcription: boolean; milo: boolean } | null> {
  const record = await runWithDbTenant(INTERVIEWS_TENANT, () => consentStore().getConsent(interviewId));
  return record ? { transcription: record.transcription, milo: record.transcription && record.milo } : null;
}

const DEFAULTS: CoachDeps = {
  store: suggestionStore,
  consents: coachConsents,
  transcript: assistantTranscript,
  model: makeCoachModel,
  reserve: reserveInterviewSpend,
  settle: settleInterviewSpend,
  release: releaseInterviewSpend,
  now: interviewsNowMs,
  newId: () => `sg-${Date.now().toString(36)}${randomBytes(5).toString('hex')}`,
};

let overrides: Partial<CoachDeps> = {};
/** Tests: replace some of the coach's dependencies; `null` puts every default back. */
export function setCoachDeps(next: Partial<CoachDeps> | null): void { overrides = next ?? {}; modelFailures.clear(); }
const deps = (): CoachDeps => ({ ...DEFAULTS, ...overrides });

/** I4.5: what the coach reads of an interview's code: the pad's current text and the last run. */
export type CoachCodeSource = (interviewId: string) => Promise<{ pad: { text: string; language: string | null } | null; lastRun: RunView | null }>;
let codeSource: CoachCodeSource | null = null;
/**
 * U4: where the coach reads the code. Default: no code. lib/interviews/runs/index.ts registers one (its `lastRun`, no pad)
 * when it loads; the integrator points `pad` at the pad log's `latestPadSnapshot` (hook H2). Not reset by setCoachDeps.
 */
export function setCoachCodeSource(read: CoachCodeSource | null): void { codeSource = read; }

/** The code part of the request for a technical round, or null (no source, nothing there, or the source failed). */
export async function coachCodeFor(interview: Pick<Interview, 'id' | 'type'>): Promise<CoachCode | null> {
  if (interview.type !== 'technical' || !codeSource) return null;
  try {
    const got = await codeSource(interview.id);
    return coachCode(got.pad, got.lastRun ? { language: got.lastRun.language, status: got.lastRun.status, result: got.lastRun.result } : null);
  } catch (e) {
    console.warn('[interviews] coach code not read', (e as Error)?.name ?? 'error');
    return null;
  }
}

const inFlight = new Set<string>();

/**
 * Consecutive calls per interview that the model failed (an error or a timeout, not an answer the parser dropped). At this many
 * the read says `paused: 'model'`, the same shape as the budget's pause, so the lead sees the coach is down instead of an
 * empty panel. The coach still tries again at the usual gap; the first call the model answers clears the count.
 *
 * Held in this process for at most MODEL_FAILURES_KEPT interviews, the least recently failed dropped first: a round that ended
 * while its model was down is never read again, and its count would otherwise stay for the life of the process. Dropping a
 * live round's count only delays its pause notice.
 */
export const MODEL_FAILURES_BEFORE_PAUSE = 3;
export const MODEL_FAILURES_KEPT = 200;
const modelFailures = new Map<string, number>();
const modelPaused = (interviewId: string): boolean => (modelFailures.get(interviewId) ?? 0) >= MODEL_FAILURES_BEFORE_PAUSE;
/** Count a failed model call for the interview (`failed`), or clear its count when the model answered. */
export function noteModelCall(interviewId: string, failed: boolean): void {
  const before = modelFailures.get(interviewId) ?? 0;
  modelFailures.delete(interviewId);
  if (!failed) return;
  modelFailures.set(interviewId, before + 1);
  if (modelFailures.size > MODEL_FAILURES_KEPT) modelFailures.delete(modelFailures.keys().next().value!);
}
/** Tests: the interview's consecutive failures as this process holds them. */
export function modelFailuresOf(interviewId: string): number { return modelFailures.get(interviewId) ?? 0; }

/** The interview and the opening that holds its kit, found in the viewer's scope by the route. */
export interface CoachRef { interview: Interview; opening: Opening }

export function coachInput(ref: CoachRef, lines: readonly CoachLine[], log: readonly SuggestionRecord[], code: CoachCode | null = null): CoachInput {
  const kit = ref.opening.kit;
  return {
    roundType: ref.interview.type,
    competencies: kit.competencies.map((c) => ({ id: c.id, name: c.name, lookFor: c.lookFor, anchors: c.anchors })),
    questions: kit.questions.filter((q) => q.roundType === ref.interview.type)
      .map((q) => ({ id: q.id, prompt: q.prompt, followUps: q.followUps, competencyId: q.competencyId })),
    chosenQuestionIds: [...ref.interview.questionIds],
    lines: [...lines],
    previous: log.filter((r) => r.dropped === null && r.competencyId !== null).slice(-MAX_PREVIOUS)
      .map((r) => ({ text: r.text, competencyId: r.competencyId!, answer: r.answer })),
    ...(code ? { code } : {}),
  };
}

export function suggestionView(row: SuggestionRecord, opening: Opening): SuggestionView {
  const c = opening.kit.competencies.find((x) => x.id === row.competencyId);
  return {
    id: row.id, text: row.text, competency: { id: row.competencyId ?? '', name: c?.name ?? 'Competency' },
    basedOn: row.basedOn, shownAt: row.shownAt ?? new Date(0).toISOString(),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** What one attempt may cost, in dollars: the request's estimated tokens at the model's price (Nova Pro's for the stand-in). */
export function coachEstimateUsd(model: Pick<CoachModel, 'modelId'>, input: CoachInput): number {
  const tokens = estimateCoachTokens(input);
  return estimateUsageCost(model.modelId, tokens) ?? estimateUsageCost(DEFAULT_COACH_MODEL_ID, tokens) ?? 0.02;
}

async function book(d: CoachDeps, model: CoachModel, input: CoachInput, held: { holdId: string | null; sourceId: string }, result: CoachModelResult, lead: string): Promise<void> {
  try {
    if (!result.sent) { await d.release([held.holdId]); return; }
    if (model.kind === 'scripted') {
      await d.settle({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model: model.modelId, actorId: lead, provider: 'local' });
      return;
    }
    const usage = result.usage ?? estimateCoachTokens(input);
    const cost = estimateUsageCost(model.modelId, usage);
    await d.settle({
      sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model: model.modelId, actorId: lead, provider: 'bedrock',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    });
  } catch (e) {
    console.warn('[interviews] coach spend not booked', (e as Error)?.name ?? 'error');
  }
}

export type SuggestionOutcome = { kind: 'not-found' } | { kind: 'ok'; body: SuggestionBody };

/** D7's read for the lead: the waiting suggestion, a new one when the rules allow, or none with when to ask again. */
export async function suggestionFor(ref: CoachRef, viewer: { userId: string }): Promise<SuggestionOutcome> {
  const d = deps();
  const { interview, opening } = ref;
  if (viewer.userId !== interview.leadId) return { kind: 'not-found' };
  const store = d.store();
  // Consent first: with Milo declined nothing else is read (not even the transcript).
  const consent = interview.state === 'live' ? await d.consents(interview.id) : null;
  const ready = interview.state === 'live' && !!(consent?.transcription && consent.milo);
  const log = ready ? await store.listSuggestions(interview.id) : [];
  const transcript = ready ? await d.transcript({ id: interview.id, callId: interview.callId }) : null;
  const nowMs = d.now();
  const decision = decideCoach({
    viewerId: viewer.userId, interview, consent, log,
    transcript: transcript ? { callId: transcript.callId, lastSeq: transcript.lastSeq } : null,
    inFlight: inFlight.has(interview.id), nowMs,
  });
  if (decision.kind === 'not-found') return { kind: 'not-found' };
  if (decision.kind === 'none' && (!ready || decision.reason === 'in-flight' || decision.reason === 'not-live' || decision.reason === 'no-consent')) {
    return { kind: 'ok', body: { suggestion: null, paused: ready && modelPaused(interview.id) ? 'model' : null, retryAfterMs: decision.retryAfterMs } };
  }
  if (decision.kind === 'show') {
    const shown = (await store.markShown(interview.id, decision.suggestion.id, iso(nowMs))) ?? decision.suggestion;
    return { kind: 'ok', body: { suggestion: suggestionView(shown, opening), paused: null, retryAfterMs: RETRY_WAITING_MS } };
  }

  // A whiteboard round a few minutes in with no clarifying question from the candidate: one nudge, by rule, no model
  // (clarifying.ts). It waits for no gap and no new line (silence is the point). Decided without an await, so the
  // in-flight check above still holds when the think below adds its hold.
  const nudge = transcript ? clarifyingFor(ref, log, transcript.lines, nowMs) : null;
  if (nudge && transcript) {
    const row = await appendClarifying(ref, nudge, transcript, nowMs, d);
    if (row) return { kind: 'ok', body: { suggestion: suggestionView(row, opening), paused: null, retryAfterMs: RETRY_WAITING_MS } };
  }
  if (decision.kind === 'none' || nudge) {
    return { kind: 'ok', body: { suggestion: null, paused: ready && modelPaused(interview.id) ? 'model' : null, retryAfterMs: decision.kind === 'none' ? decision.retryAfterMs : RETRY_WAITING_MS } };
  }

  // think: one call in flight per interview (the check above and this add run without an await between them).
  inFlight.add(interview.id);
  try {
    const model = d.model();
    const lines = transcript!.lines;
    const input = coachInput(ref, lines, log, await coachCodeFor(interview));
    const id = d.newId();
    const held = await d.reserve({
      interviewId: interview.id, part: 'coach', key: id, estimateUsd: coachEstimateUsd(model, input), expiresInMs: COACH_TIMEOUT_MS * 2 + 30_000,
    });
    if (!held.ok) return { kind: 'ok', body: { suggestion: null, paused: 'budget', retryAfterMs: SUGGESTION_GAP_MS } };
    let result: CoachModelResult;
    try { result = await model.suggest(input); } catch (e) {
      // The name only: a message could quote the request.
      console.warn('[interviews] coach model failed', (e as Error)?.name ?? 'error');
      result = { raw: null, code: 'error', sent: false, usage: null };
    }
    noteModelCall(interview.id, result.code === 'error' || result.code === 'timeout');
    await book(d, model, input, held, result, viewer.userId);
    const parsed: ParseResult | { ok: false; code: 'timeout' | 'error' | 'nothing' } = result.code === 'ok'
      ? parseCoachAnswer(result.raw, { competencyIds: opening.kit.competencies.map((c) => c.id), lines, codeLines: codeLinesOf(input.code) })
      : { ok: false, code: result.code };
    const madeAt = iso(d.now());
    const row: SuggestionRecord = {
      id, interviewId: interview.id, callId: transcript!.callId, throughSeq: transcript!.lastSeq,
      text: parsed.ok ? parsed.suggestion.text : '', competencyId: parsed.ok ? parsed.suggestion.competencyId : null,
      basedOn: parsed.ok ? parsed.suggestion.basedOn : null,
      madeAt, shownAt: parsed.ok ? madeAt : null, answer: null, answeredAt: null, spoken: false,
      modelId: model.modelId, promptVersion: COACH_PROMPT_VERSION, dropped: parsed.ok ? null : parsed.code,
    };
    await store.appendSuggestion(row);
    if (!parsed.ok) {
      console.warn('[interviews] coach suggestion dropped', parsed.code);
      return { kind: 'ok', body: { suggestion: null, paused: modelPaused(interview.id) ? 'model' : null, retryAfterMs: SUGGESTION_GAP_MS } };
    }
    return { kind: 'ok', body: { suggestion: suggestionView(row, opening), paused: null, retryAfterMs: RETRY_WAITING_MS } };
  } finally {
    inFlight.delete(interview.id);
  }
}

/** The clarifying nudge the rule gives now (clarifying.ts), from the interview's round and questions; null for none. */
function clarifyingFor(ref: CoachRef, log: readonly SuggestionRecord[], lines: readonly CoachLine[], nowMs: number): ClarifyNudge | null {
  const { interview, opening: { kit } } = ref;
  const chosen = interview.questionIds.map((id) => kit.questions.find((q) => q.id === id)).filter((q): q is NonNullable<typeof q> => Boolean(q));
  return clarifyingNudge({
    surface: roundSurface(kit.rounds.find((r) => r.id === interview.roundId)),
    startedAtMs: interview.startedAt ? Date.parse(interview.startedAt) : null,
    nowMs,
    questions: chosen.length ? chosen : kit.questions.filter((q) => q.roundType === interview.type),
    lines,
    log,
  });
}

/**
 * Log the nudge as a suggestion shown now; null when another read of this interview holds it (it will show that one).
 * The log is read again inside the hold: the caller's read came before its awaits, so another tab may have logged the
 * nudge since, and then that row is the one shown.
 */
async function appendClarifying(ref: CoachRef, nudge: ClarifyNudge, transcript: CoachTranscript, nowMs: number, d: CoachDeps): Promise<SuggestionRecord | null> {
  const id = ref.interview.id;
  if (inFlight.has(id)) return null;
  inFlight.add(id);
  try {
    const store = d.store();
    const logged = (await store.listSuggestions(id)).find((r) => r.modelId === CLARIFYING_MODEL_ID);
    if (logged) return logged.answer === null ? (await store.markShown(id, logged.id, iso(nowMs))) ?? logged : null;
    const madeAt = iso(nowMs);
    const row: SuggestionRecord = {
      id: d.newId(), interviewId: id, callId: transcript.callId, throughSeq: transcript.lastSeq,
      text: nudge.text, competencyId: nudge.competencyId, basedOn: null,
      madeAt, shownAt: madeAt, answer: null, answeredAt: null, spoken: false,
      modelId: CLARIFYING_MODEL_ID, promptVersion: CLARIFYING_RULE_VERSION, dropped: null,
    };
    await store.appendSuggestion(row);
    return row;
  } finally {
    inFlight.delete(id);
  }
}

/**
 * `said` (Have Milo ask only): aloud and in chat, in chat only, or nowhere; `why` with anything short of aloud, so the lead's
 * receipt says what happened and never claims a chat post that was not made.
 */
export type AnswerOutcome =
  | { kind: 'ok'; said?: 'spoken' | 'chat' | 'none'; why?: NotAloudWhy }
  | { kind: 'not-found' } | { kind: 'not-live' } | { kind: 'answered' };

/** D7's answer, by the lead, while the interview is live; once. */
export async function answerSuggestion(ref: CoachRef, viewer: { userId: string }, suggestionId: string, answer: SuggestionAnswer): Promise<AnswerOutcome> {
  const d = deps();
  const { interview } = ref;
  if (viewer.userId !== interview.leadId) return { kind: 'not-found' };
  if (interview.state !== 'live') return { kind: 'not-live' };
  const written = await d.store().answerSuggestion(interview.id, suggestionId, answer, iso(d.now()));
  if (!written.ok) return written.reason === 'stale' ? { kind: 'answered' } : { kind: 'not-found' };
  if (answer !== 'milo-ask') return { kind: 'ok' };
  // Logged first (above, and in the said log); then the approved words go to the call's chat when Milo is in the call, and
  // then to its voice as approved words.
  let posted = false;
  try {
    const t = await d.transcript({ id: interview.id, callId: interview.callId });
    if (!t) return { kind: 'ok', said: 'none', why: 'not-in-call' };
    const speak = d.speak ?? { post: logAndPost, say: sayLogged };
    // E9: a plain question with the server's approved mark (no asker named), the one kind of Milo's message the candidate reads.
    const out = await speak.post(interview.id, t.callId, { kind: 'question', source: 'suggestion', text: askedWords(written.row), askedBy: viewer.userId, suggestionId: written.row.id });
    posted = out.posted;
    const row = out.row;
    if (!posted) return { kind: 'ok', said: 'none', why: 'not-in-call' };
    const aloud = await speak.say(interview.id, row, t.callId);
    if (!aloud.spoken) return { kind: 'ok', said: 'chat', why: aloud.why };
    await d.store().markSpoken?.(interview.id, written.row.id);
    return { kind: 'ok', said: 'spoken' };
  } catch (e) {
    console.warn('[interviews] approved question not posted', (e as Error)?.name ?? 'error');
    return { kind: 'ok', said: posted ? 'chat' : 'none', why: 'not-said' };
  }
}

/** D6: remove these interviews' rows from the suggestion log (a record-class eraser). */
export async function eraseSuggestionRows(interviewIds: readonly string[]): Promise<number> {
  return deps().store().eraseSuggestions(interviewIds);
}
