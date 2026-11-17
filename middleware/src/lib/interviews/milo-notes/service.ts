// Milo for you (docs/interviews-tenant-plan.md rows I3.6 and I3.7; decisions 4, 6, 8, 18, 20; contract E5).
//
//   transcriptFor   the panel side's live transcript: who may read it is the route's (the tenant's scope); this reads the
//                   candidate's answers first and nothing of the call when the transcript was not accepted.
//   notesFor        the seats' notes: what was asked about per competency, and the time check. No model.
//   askMilo         the lead's private question: the rules (rules.ts), then, only when they say think, a hold on the
//                   interview's opening for the part `coach` (key `ask-<n>`; a refused hold makes no call and answers
//                   `paused: 'budget'`), the model, the money settled or released, the parse and guard, the log, the view.
//                   One question in flight per interview.
//
// Nothing of the transcript, the question or the answer is written anywhere but the log's own row; console lines carry
// codes only.
import { randomBytes } from 'node:crypto';
import { seatOf } from '../assign.js';
import { recordTranscript } from '../record/transcript.js';
import { ratingsAtRecap } from '../recap/index.js';
import { estimateUsageCost } from '../../pricing.js';
import { COACH_TIMEOUT_MS, DEFAULT_COACH_MODEL_ID } from '../coach/model.js';
import { MAX_TRANSCRIPT_LINES } from '../coach/prompt.js';
import { coachConsents } from '../coach/service.js';
import { suggestionStore, type SuggestionRecord } from '../coach/store.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend, type InterviewReserveInput, type InterviewReserveOutcome, type InterviewSettleInput } from '../spend.js';
import type { Interview, Opening } from '../types.js';
import { estimateAskTokens, makeMiloModel, type MiloModel, type MiloModelResult } from './model.js';
import { competencyNotes, notesStartMs, timeCheck, type MiloNotesView } from './notes.js';
import { parseAskAnswer, type AskParseResult } from './parse.js';
import { ASK_PROMPT_VERSION, type AskInput } from './prompt.js';
import { AFTER_CALL_REFUSAL_LINES, decideAfterCallAsk, decideAsk, DROPPED_LINE, FAILED_LINE, FIXED_ANSWER, REFUSAL_LINES, type AfterCallRefusal, type AskRefusal } from './rules.js';
import { coachLogStore, type CoachLogCode, type CoachLogRecord, type CoachLogStore } from './store.js';
import {
  assistantLiveTranscript, coachLinesOf, sideOf, TRANSCRIPT_NOT_INVITED, transcriptLineViews, transcriptOffForConsent,
  type LiveTranscript, type LiveTranscriptSource, type TranscriptLineView,
} from './transcript.js';

export interface MiloDeps {
  log: () => CoachLogStore;
  consents: (interviewId: string) => Promise<{ transcription: boolean; milo: boolean } | null>;
  transcript: LiveTranscriptSource;
  /** The coach's suggestion log, read only (what the lead took counts as asked). */
  suggestions: (interviewId: string) => Promise<SuggestionRecord[]>;
  model: () => MiloModel;
  reserve: (i: InterviewReserveInput) => Promise<InterviewReserveOutcome>;
  settle: (i: InterviewSettleInput) => Promise<void>;
  release: (holdIds: readonly (string | null)[]) => Promise<void>;
  now: () => number;
  newId: () => string;
  /** After the call: whether this person's own recap open is stored. */
  opened: (interviewId: string, userId: string) => Promise<boolean>;
  /** After the call: the finished interview's lines, the way the recap reads them (the record first, then Milo's call record). */
  finished: (ref: MiloRef) => Promise<TranscriptLineView[] | null>;
}

const DEFAULTS: MiloDeps = {
  log: coachLogStore,
  consents: coachConsents,
  transcript: assistantLiveTranscript,
  suggestions: (id) => suggestionStore().listSuggestions(id),
  model: makeMiloModel,
  reserve: reserveInterviewSpend,
  settle: settleInterviewSpend,
  release: releaseInterviewSpend,
  now: Date.now,
  newId: () => `ml-${Date.now().toString(36)}${randomBytes(5).toString('hex')}`,
  opened: async (interviewId, userId) => (await ratingsAtRecap(interviewId, userId)) !== null,
  finished: finishedTranscript,
};

let overrides: Partial<MiloDeps> = {};
/** Tests: replace some dependencies; `null` puts every default back. */
export function setMiloDeps(next: Partial<MiloDeps> | null): void { overrides = next ?? {}; }
const deps = (): MiloDeps => ({ ...DEFAULTS, ...overrides });

/** The interview, the opening that holds its kit, and the names the panel reads, found in the viewer's scope by the route. */
export interface MiloRef { interview: Interview; opening: Opening; candidateName: string; nameOf: (userId: string) => string }

// ── The live transcript (I3.7) ──────────────────────────────────────────────────────────────────────────────────────

export interface TranscriptBody { transcript: { state: 'on' | 'off'; off: string | null; lines: TranscriptLineView[]; lastSeq: number } }

export async function transcriptFor(ref: MiloRef, after: number): Promise<TranscriptBody> {
  const d = deps();
  const from = Number.isInteger(after) && after > 0 ? after : 0;
  const off = transcriptOffForConsent(await d.consents(ref.interview.id));
  if (off) return { transcript: { state: 'off', off, lines: [], lastSeq: from } };
  const t = await d.transcript({ id: ref.interview.id, callId: ref.interview.callId }, from);
  if (!t) return { transcript: { state: 'off', off: TRANSCRIPT_NOT_INVITED, lines: [], lastSeq: from } };
  return { transcript: { state: 'on', off: null, lines: transcriptLineViews(t.lines, { candidate: ref.candidateName, nameOf: ref.nameOf }), lastSeq: t.lastSeq } };
}

// ── Milo's notes (I3.6, no model) ───────────────────────────────────────────────────────────────────────────────────

/** Every line so far, read a page at a time from the start (at most WHOLE_PAGES pages): what the notes and the model read. */
const WHOLE_PAGES = 10;
async function wholeTranscript(d: MiloDeps, interview: Interview): Promise<LiveTranscript | null> {
  const first = await d.transcript({ id: interview.id, callId: interview.callId }, 0);
  if (!first) return null;
  let page = first;
  const lines = [...first.lines];
  for (let n = 1; n < WHOLE_PAGES && page.lastSeq > 0; n++) {
    const next = await d.transcript({ id: interview.id, callId: interview.callId }, page.lastSeq);
    if (!next || next.lastSeq <= page.lastSeq) break;
    lines.push(...next.lines);
    page = next;
  }
  return { ...first, lastSeq: page.lastSeq, lines };
}

const chosenOf = (ref: Pick<MiloRef, 'interview' | 'opening'>) => ref.interview.questionIds.flatMap((id) => {
  const q = ref.opening.kit.questions.find((x) => x.id === id);
  return q ? [{ id: q.id, prompt: q.prompt, competencyId: q.competencyId }] : [];
});

export async function notesFor(ref: MiloRef): Promise<{ notes: MiloNotesView }> {
  const d = deps();
  const { interview, opening } = ref;
  const consent = await d.consents(interview.id);
  // The panel's own words are read only when the transcript was accepted; the coach's log only when Milo was.
  const transcript = transcriptOffForConsent(consent) ? null : await wholeTranscript(d, interview);
  const suggestions = consent?.transcription && consent.milo ? await d.suggestions(interview.id) : [];
  const panelLines = (transcript?.lines ?? []).filter((l) => sideOf(l.userId) === 'panel').map((l) => l.text);
  const competencies = competencyNotes({
    competencies: opening.kit.competencies.map((c) => ({ id: c.id, name: c.name })), chosen: chosenOf(ref), panelLines, suggestions,
  });
  const time = timeCheck(notesStartMs(interview.scheduledAt, transcript?.startedAtMs ?? null), interview.minutes, d.now());
  return { notes: { competencies, time } };
}

// ── The private question (I3.6, the model) ──────────────────────────────────────────────────────────────────────────

export interface AskSourceView { seq: number; quote: string; speaker: string; at: string }
export interface AskAnswerView { id: string; question: string; text: string; sources: AskSourceView[]; askedAt: string }
export type AskRefusedCode = AskRefusal | AfterCallRefusal | 'judgement' | 'personal' | 'dropped' | 'failed';
/** E5's answer to the lead. */
export interface AskBody { answer: AskAnswerView | null; refused: AskRefusedCode | null; line: string | null; paused: null | 'budget'; retryAfterMs: number | null }

export type AskOutcome = { kind: 'not-found' } | { kind: 'not-live'; body: AskBody } | { kind: 'ok'; body: AskBody };

const inFlight = new Set<string>();
const iso = (ms: number): string => new Date(ms).toISOString();
const refusedBody = (refused: AskRefusedCode, line: string, retryAfterMs: number | null = null): AskBody => ({ answer: null, refused, line, paused: null, retryAfterMs });

/** What one question may cost, in dollars: the request's estimated tokens at the model's price (Nova Pro's for the stand-in). */
export function askEstimateUsd(model: Pick<MiloModel, 'modelId'>, input: AskInput): number {
  const tokens = estimateAskTokens(input);
  return estimateUsageCost(model.modelId, tokens) ?? estimateUsageCost(DEFAULT_COACH_MODEL_ID, tokens) ?? 0.02;
}

async function book(d: MiloDeps, model: MiloModel, input: AskInput, held: { holdId: string | null; sourceId: string }, result: MiloModelResult, lead: string): Promise<void> {
  try {
    if (!result.sent) { await d.release([held.holdId]); return; }
    if (model.kind === 'scripted') {
      await d.settle({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model: model.modelId, actorId: lead, provider: 'local' });
      return;
    }
    const usage = result.usage ?? estimateAskTokens(input);
    const cost = estimateUsageCost(model.modelId, usage);
    await d.settle({
      sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model: model.modelId, actorId: lead, provider: 'bedrock',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    });
  } catch (e) {
    console.warn('[interviews] milo spend not booked', (e as Error)?.name ?? 'error');
  }
}

export async function askMilo(ref: MiloRef, viewer: { userId: string }, question: string): Promise<AskOutcome> {
  const d = deps();
  const { interview, opening } = ref;
  if (viewer.userId !== interview.leadId) return { kind: 'not-found' };
  const store = d.log();
  const live = interview.state === 'live';
  const consent = live ? await d.consents(interview.id) : null;
  const ready = live && !!(consent?.transcription && consent.milo);
  const log = ready ? await store.list(interview.id, 'answer') : [];
  const transcript = ready ? await wholeTranscript(d, interview) : null;
  const all = transcript?.lines ?? [];
  const nowMs = d.now();
  const decision = decideAsk({
    viewerId: viewer.userId, interview, consent, question, log, inFlight: inFlight.has(interview.id), lineCount: all.length, nowMs,
  });
  if (decision.kind === 'not-found') return { kind: 'not-found' };
  if (decision.kind === 'refuse') {
    const body = refusedBody(decision.reason, REFUSAL_LINES[decision.reason], decision.retryAfterMs);
    return decision.reason === 'not-live' ? { kind: 'not-live', body } : { kind: 'ok', body };
  }
  const row = (over: Partial<CoachLogRecord>): CoachLogRecord => ({
    id: d.newId(), interviewId: interview.id, kind: 'answer', askedBy: viewer.userId, question, answer: '', sources: [], code: null,
    askedAt: iso(d.now()), modelId: 'none', promptVersion: ASK_PROMPT_VERSION, ...over,
  });
  if (decision.kind === 'fixed') {
    // No model, no charge: the one fixed sentence, logged as its code.
    await store.append(row({ code: decision.code }));
    return { kind: 'ok', body: refusedBody(decision.code === 'refused-judgement' ? 'judgement' : 'personal', FIXED_ANSWER) };
  }

  // think: one question in flight per interview (the check above and this add run without an await between them).
  inFlight.add(interview.id);
  try {
    const model = d.model();
    const recent = all.slice(-MAX_TRANSCRIPT_LINES);
    const lines = coachLinesOf(recent);
    const input: AskInput = {
      roundType: interview.type,
      competencies: opening.kit.competencies.map((c) => ({ id: c.id, name: c.name, lookFor: c.lookFor })),
      questions: chosenOf(ref),
      lines,
      question,
    };
    const held = await d.reserve({
      interviewId: interview.id, part: 'coach', key: `ask-${decision.n}`, estimateUsd: askEstimateUsd(model, input), expiresInMs: COACH_TIMEOUT_MS * 2 + 30_000,
    });
    if (!held.ok) return { kind: 'ok', body: { answer: null, refused: null, line: null, paused: 'budget', retryAfterMs: null } };
    let result: MiloModelResult;
    try { result = await model.ask(input); } catch { result = { raw: null, code: 'error', sent: false, usage: null }; }
    await book(d, model, input, held, result, viewer.userId);
    const parsed: AskParseResult | { ok: false; code: 'timeout' | 'error' } = result.code === 'ok' ? parseAskAnswer(result.raw, lines) : { ok: false, code: result.code };
    const written = await store.append(row({
      modelId: model.modelId,
      answer: parsed.ok ? parsed.value.answer : '',
      sources: parsed.ok ? parsed.value.sources.map((s) => ({ seq: s.seq, quote: s.quote })) : [],
      code: parsed.ok ? null : (parsed.code as CoachLogCode),
    }));
    if (!parsed.ok) {
      console.warn('[interviews] milo answer dropped', parsed.code);
      const failed = parsed.code === 'timeout' || parsed.code === 'error';
      return { kind: 'ok', body: refusedBody(failed ? 'failed' : 'dropped', failed ? FAILED_LINE : DROPPED_LINE) };
    }
    const bySeq = new Map(transcriptLineViews(recent, { candidate: ref.candidateName, nameOf: ref.nameOf }).map((l) => [l.seq, l]));
    return {
      kind: 'ok',
      body: {
        answer: {
          id: written.id, question, text: parsed.value.answer, askedAt: written.askedAt,
          sources: parsed.value.sources.map((s) => ({ seq: s.seq, quote: s.quote, speaker: bySeq.get(s.seq)?.speaker ?? '', at: bySeq.get(s.seq)?.at ?? '' })),
        },
        refused: null, line: null, paused: null, retryAfterMs: null,
      },
    };
  } finally {
    inFlight.delete(interview.id);
  }
}

// ── The private question after the call (decision 14; contract F1) ──────────────────────────────────────────────────

/** Lines the model reads after the call: the whole finished call, bounded (the live ask reads the last 120). */
export const AFTER_CALL_MAX_LINES = 400;

/** The finished interview's words as the recap reads them: the record's reader first, then Milo's call record. */
async function finishedTranscript(ref: MiloRef): Promise<TranscriptLineView[] | null> {
  const r = await recordTranscript(ref.interview);
  if (r) return r.lines.map(({ seq, at, side, speaker, text }) => ({ seq, at, side, speaker, text }));
  const t = await wholeTranscript(deps(), ref.interview);
  return t ? transcriptLineViews(t.lines, { candidate: ref.candidateName, nameOf: ref.nameOf }) : null;
}

export type AfterCallOutcome = { kind: 'not-found' } | { kind: 'not-ended'; body: AskBody } | { kind: 'ok'; body: AskBody };

const inFlightAfter = new Set<string>();
const safeKey = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * A seat's question from the recap, after the call: the after-call rule, then the same guard, hold, model, log and
 * answer as the room's ask. The question is private to the asker: `askedBy` names them and nothing lists it to anyone else.
 */
export async function askMiloAfterCall(ref: MiloRef, viewer: { userId: string }, question: string): Promise<AfterCallOutcome> {
  const d = deps();
  const { interview, opening } = ref;
  const seated = !!seatOf(interview, viewer.userId);
  const finishedState = ['ended', 'scored', 'reviewed'].includes(interview.state);
  const opened = seated && finishedState ? await d.opened(interview.id, viewer.userId) : false;
  const consent = seated && opened ? await d.consents(interview.id) : null;
  const ready = seated && opened && !!(consent?.transcription && consent.milo);
  const store = d.log();
  const log = ready ? await store.list(interview.id, 'answer') : [];
  const views = ready ? (await d.finished(ref)) ?? [] : [];
  const flightKey = `${interview.id}:${viewer.userId}`;
  const decision = decideAfterCallAsk({
    viewerId: viewer.userId, interview, seated, opened, consent, question, log, inFlight: inFlightAfter.has(flightKey), lineCount: views.length, nowMs: d.now(),
  });
  if (decision.kind === 'not-found') return { kind: 'not-found' };
  if (decision.kind === 'refuse') {
    const body = refusedBody(decision.reason, AFTER_CALL_REFUSAL_LINES[decision.reason], decision.retryAfterMs);
    return decision.reason === 'not-ended' ? { kind: 'not-ended', body } : { kind: 'ok', body };
  }
  const row = (over: Partial<CoachLogRecord>): CoachLogRecord => ({
    id: d.newId(), interviewId: interview.id, kind: 'answer', askedBy: viewer.userId, question, answer: '', sources: [], code: null,
    askedAt: iso(d.now()), modelId: 'none', promptVersion: ASK_PROMPT_VERSION, ...over,
  });
  if (decision.kind === 'fixed') {
    await store.append(row({ code: decision.code }));
    return { kind: 'ok', body: refusedBody(decision.code === 'refused-judgement' ? 'judgement' : 'personal', FIXED_ANSWER) };
  }

  inFlightAfter.add(flightKey);
  try {
    const model = d.model();
    const recent = views.slice(-AFTER_CALL_MAX_LINES);
    const lines = recent.map((l) => ({ seq: l.seq, side: l.side, text: l.text }));
    const input: AskInput = {
      roundType: interview.type,
      competencies: opening.kit.competencies.map((c) => ({ id: c.id, name: c.name, lookFor: c.lookFor })),
      questions: chosenOf(ref),
      lines,
      question,
    };
    const held = await d.reserve({
      interviewId: interview.id, part: 'coach', key: `recap-ask-${safeKey(viewer.userId)}-${decision.n}`, estimateUsd: askEstimateUsd(model, input),
      expiresInMs: COACH_TIMEOUT_MS * 2 + 30_000,
    });
    if (!held.ok) return { kind: 'ok', body: { answer: null, refused: null, line: null, paused: 'budget', retryAfterMs: null } };
    let result: MiloModelResult;
    try { result = await model.ask(input); } catch { result = { raw: null, code: 'error', sent: false, usage: null }; }
    await book(d, model, input, held, result, viewer.userId);
    const parsed: AskParseResult | { ok: false; code: 'timeout' | 'error' } = result.code === 'ok' ? parseAskAnswer(result.raw, lines) : { ok: false, code: result.code };
    const written = await store.append(row({
      modelId: model.modelId,
      answer: parsed.ok ? parsed.value.answer : '',
      sources: parsed.ok ? parsed.value.sources.map((s) => ({ seq: s.seq, quote: s.quote })) : [],
      code: parsed.ok ? null : (parsed.code as CoachLogCode),
    }));
    if (!parsed.ok) {
      console.warn('[interviews] milo recap answer dropped', parsed.code);
      const failed = parsed.code === 'timeout' || parsed.code === 'error';
      return { kind: 'ok', body: refusedBody(failed ? 'failed' : 'dropped', failed ? FAILED_LINE : DROPPED_LINE) };
    }
    const bySeq = new Map(recent.map((l) => [l.seq, l]));
    return {
      kind: 'ok',
      body: {
        answer: {
          id: written.id, question, text: parsed.value.answer, askedAt: written.askedAt,
          sources: parsed.value.sources.map((s) => ({ seq: s.seq, quote: s.quote, speaker: bySeq.get(s.seq)?.speaker ?? '', at: bySeq.get(s.seq)?.at ?? '' })),
        },
        refused: null, line: null, paused: null, retryAfterMs: null,
      },
    };
  } finally {
    inFlightAfter.delete(flightKey);
  }
}
