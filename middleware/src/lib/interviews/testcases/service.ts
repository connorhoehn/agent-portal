// The candidate asks Milo for test cases, and Milo writes them into the pad (docs/interviews-tenant-plan.md, "Milo writes
// test cases").
//
// The request arrives the way the candidate's other spoken requests do: a final transcript line addressed to Milo, found by the
// meeting assistant's detector and handed to the interviews policy (milo-policy.ts `answerFromHeldText`). The answer is always
// a line the server holds, logged in the said log first, then posted and said by the orchestrator on the one speaking path
// (approved words, one at a time, under the speech hold). What this module adds before that line:
//
//   1. the rules, each with its own fixed sentence: a coding round, the lead's setting on (milo-settings.ts, off by default),
//      the candidate's consent to Milo, one request at a time per interview, at most MAX_TEST_CASE_BATCHES per interview;
//   2. the pad joined as Milo (pad/milo-writer.ts) so the cases are written for the pad as it stands, in its language;
//   3. the money: a hold under the interview's `coach` part before the model is asked, settled with what it cost (nothing for
//      the stand-in, nothing for a call that was refused before it ran); a refused hold is a fixed sentence and no model;
//   4. the model's cases read as data (parse.ts) and written as code here (render.ts), appended at the end of the pad as one
//      edit, and acknowledged by the gateway;
//   5. the pad log credits the edit to Milo (side `milo`, kind `tests`, and a snapshot of the pad as Milo left it), so the
//      record page and its playback show who wrote it;
//   6. the line: "Added twelve test cases at the bottom of the pad."
// Nothing here throws to the caller: a failure is the fixed sentence TESTS_FAILED.
import { randomBytes } from 'node:crypto';
import { estimateUsageCost } from '../../pricing.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { interviewsNowMs } from '../clock.js';
import { coachConsents } from '../coach/service.js';
import { DEFAULT_COACH_MODEL_ID } from '../coach/model.js';
import { miloSettingsStore, type MiloSettings } from '../milo-settings.js';
import { appendPadEvents, MILO_WRITER_ID } from '../pad/log/service.js';
import { writeIntoPad, type MiloPadPlan, type MiloPadWriteResult } from '../pad/milo-writer.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend, type InterviewReserveInput, type InterviewReserveOutcome, type InterviewSettleInput } from '../spend.js';
import { saidStore, type SaidSource, type SaidStore } from '../speak/store.js';
import { interviewsStore } from '../store-select.js';
import { INTERVIEWS_TENANT, type Interview, type KitQuestion, type PadLanguage } from '../types.js';
import { estimateTestCaseTokens, makeTestCaseModel, type TestCaseInput, type TestCaseModel } from './model.js';
import { parseTestCases } from './parse.js';
import { functionOf, renderTestCases } from './render.js';
import { countWords } from './request.js';

/** The most times Milo writes test cases in one interview. */
export const MAX_TEST_CASE_BATCHES = 3;

export const TESTS_OFF = 'Test cases from Milo are not turned on for this round.';
export const TESTS_NO_PAD = 'There is no code pad in this round, so Milo cannot add test cases.';
export const TESTS_BUSY = 'Milo is still writing the last test cases.';
export const TESTS_LIMIT = `Milo has already added test cases ${countWords(MAX_TEST_CASE_BATCHES)} times in this round.`;
export const TESTS_FAILED = 'Milo could not add test cases this time.';
/** The line after a write: what Milo did, in a few words. */
export const testsAddedLine = (n: number): string => `Added ${countWords(n)} test case${n === 1 ? '' : 's'} at the bottom of the pad.`;

export interface TestCaseDeps {
  settings: (interviewId: string) => Promise<MiloSettings>;
  consents: (interviewId: string) => Promise<{ transcription: boolean; milo: boolean } | null>;
  /** The round's chosen questions (all of its kit's coding questions when none were chosen). */
  questions: (interview: Interview) => Promise<KitQuestion[]>;
  said: () => SaidStore;
  model: () => TestCaseModel;
  write: (interviewId: string, plan: MiloPadPlan) => Promise<MiloPadWriteResult>;
  reserve: (i: InterviewReserveInput) => Promise<InterviewReserveOutcome>;
  settle: (i: InterviewSettleInput) => Promise<void>;
  release: (holdIds: readonly (string | null)[]) => Promise<void>;
  /** Append Milo's own events to the pad log. */
  padLog: (interviewId: string, events: Parameters<typeof appendPadEvents>[2], at: Date) => Promise<number>;
  now: () => number;
  newId: () => string;
}

const roundQuestions = async (interview: Interview): Promise<KitQuestion[]> => {
  const store = interviewsStore();
  const [applications, openings] = await runWithDbTenant(INTERVIEWS_TENANT, () => Promise.all([store.listApplications(), store.listOpenings()]));
  const opening = openings.find((o) => o.id === applications.find((a) => a.id === interview.applicationId)?.openingId);
  const bank = opening?.kit.questions ?? [];
  const chosen = interview.questionIds.length ? bank.filter((q) => interview.questionIds.includes(q.id)) : bank;
  return chosen.filter((q) => q.roundType === 'technical');
};

const DEFAULTS: TestCaseDeps = {
  settings: (id) => runWithDbTenant(INTERVIEWS_TENANT, () => miloSettingsStore().get(id)),
  consents: coachConsents,
  questions: roundQuestions,
  said: saidStore,
  model: makeTestCaseModel,
  write: writeIntoPad,
  reserve: reserveInterviewSpend,
  settle: settleInterviewSpend,
  release: releaseInterviewSpend,
  padLog: (id, events, at) => runWithDbTenant(INTERVIEWS_TENANT, () => appendPadEvents(id, { id: MILO_WRITER_ID, side: 'milo' }, events, at)),
  now: interviewsNowMs,
  newId: () => `said-${randomBytes(8).toString('hex')}`,
};
let overrides: Partial<TestCaseDeps> = {};
/** Tests: replace some dependencies; `null` puts every default back. */
export function setTestCaseDeps(next: Partial<TestCaseDeps> | null): void { overrides = next ?? {}; }
const deps = (): TestCaseDeps => ({ ...DEFAULTS, ...overrides });

/** One request in flight per interview (the check and the add run with no await between them). */
const inFlight = new Set<string>();

/**
 * The question the pad is working on: the round's question whose starter function the pad defines in its language, else the
 * one whose starter function the pad names in any language, else the round's first coding question.
 */
export function questionForPad(questions: readonly KitQuestion[], pad: string, language: PadLanguage): KitQuestion | null {
  const fnOf = (q: KitQuestion, lang: PadLanguage) => (q.starter?.[lang] ? functionOf(q.starter[lang]!, lang) : null);
  const here = functionOf(pad, language);
  const exact = here ? questions.find((q) => fnOf(q, language) === here) : undefined;
  if (exact) return exact;
  const named = questions.find((q) => Object.keys(q.starter ?? {}).some((l) => { const f = fnOf(q, l as PadLanguage); return !!f && pad.includes(`${f}(`); }));
  return named ?? questions[0] ?? null;
}

/** What one request may cost: the request's estimated tokens at the model's price (Nova Pro's for the stand-in). */
export function testCaseEstimateUsd(model: Pick<TestCaseModel, 'modelId'>, input: TestCaseInput): number {
  const tokens = estimateTestCaseTokens(input);
  return estimateUsageCost(model.modelId, tokens) ?? estimateUsageCost(DEFAULT_COACH_MODEL_ID, tokens) ?? 0.02;
}

export interface TestCaseAnswer {
  /** The line Milo says, logged in the said log (not yet posted or spoken). */
  line: string;
  source: SaidSource;
  /** How many cases went into the pad (0 for every refusal and failure). */
  written: number;
}

/** The candidate's request for `count` test cases, answered: the rules, the cases written as Milo, the line logged. */
export async function answerTestCaseRequest(interview: Interview, askedBy: string, count: number): Promise<TestCaseAnswer> {
  const d = deps();
  const answer = async (line: string, source: SaidSource, written = 0): Promise<TestCaseAnswer> => {
    await runWithDbTenant(INTERVIEWS_TENANT, () => d.said().append({
      id: d.newId(), interviewId: interview.id, callId: interview.callId, kind: 'answer', source, questionId: null, suggestionId: null,
      text: line, askedBy, saidAt: new Date(d.now()).toISOString(), posted: false, spoken: false,
    }));
    return { line, source, written };
  };
  if (interview.type !== 'technical') return answer(TESTS_NO_PAD, 'refusal');
  const [settings, consent] = await Promise.all([d.settings(interview.id).catch(() => null), d.consents(interview.id).catch(() => null)]);
  if (!settings?.testCases || !consent?.milo) return answer(TESTS_OFF, 'refusal');
  if (inFlight.has(interview.id)) return answer(TESTS_BUSY, 'refusal');
  inFlight.add(interview.id);
  try {
    const earlier = (await runWithDbTenant(INTERVIEWS_TENANT, () => d.said().list(interview.id))).filter((r) => r.source === 'tests').length;
    if (earlier >= MAX_TEST_CASE_BATCHES) return answer(TESTS_LIMIT, 'refusal');
    const questions = await d.questions(interview).catch(() => []);
    if (!questions.length) return answer(TESTS_FAILED, 'refusal');
    let refusedMoney = false;
    let cases = 0;
    const plan: MiloPadPlan = async ({ text, language }) => {
      const question = questionForPad(questions, text, language);
      if (!question) return null;
      const fn = functionOf(text, language);
      const model = d.model();
      const input: TestCaseInput = { question: { id: question.id, prompt: question.prompt }, language, fn, pad: text, count };
      const held = await d.reserve({
        interviewId: interview.id, part: 'coach', key: `tests-${d.newId()}`, estimateUsd: testCaseEstimateUsd(model, input), expiresInMs: 120_000,
      });
      if (!held.ok) { refusedMoney = true; return null; }
      const result = await model.write(input).catch(() => ({ raw: null, code: 'error' as const, sent: false, usage: null }));
      // Booked to the lead, who turned test cases on for this round (the candidate is no app user).
      await book(d, model, input, held, result, interview.leadId);
      const parsed = result.code === 'ok' ? parseTestCases(result.raw, { pad: text, count }) : null;
      if (!parsed?.ok) return null;
      cases = parsed.cases.length;
      return renderTestCases(parsed.cases, language, fn);
    };
    const out = await d.write(interview.id, plan);
    if (!out.ok) {
      if (!refusedMoney) console.warn('[interviews] test cases not written', out.code);
      return answer(TESTS_FAILED, 'refusal');
    }
    const at = new Date(d.now());
    const clientAt = at.toISOString();
    await d.padLog(interview.id, [
      { kind: 'tests', clientAt, from: out.from, inserted: out.inserted, length: out.length, lines: out.lines, language: out.language },
      { kind: 'snapshot', clientAt, text: out.text, language: out.language, length: out.length },
    ], at).catch((e: unknown) => console.warn('[interviews] Milo\'s pad edit not logged', (e as Error)?.name ?? 'error'));
    return answer(testsAddedLine(cases), 'tests', cases);
  } catch (e) {
    console.warn('[interviews] test cases failed', (e as Error)?.name ?? 'error');
    return answer(TESTS_FAILED, 'refusal').catch(() => ({ line: TESTS_FAILED, source: 'refusal' as const, written: 0 }));
  } finally {
    inFlight.delete(interview.id);
  }
}

/** Book what the model call cost, as Milo's private answers book theirs (milo-notes/service.ts). Never throws. */
async function book(d: TestCaseDeps, model: TestCaseModel, input: TestCaseInput, held: { holdId: string | null; sourceId: string },
  result: { sent: boolean; usage: { inputTokens: number; outputTokens: number } | null }, actor: string): Promise<void> {
  try {
    if (!result.sent) { await d.release([held.holdId]); return; }
    if (model.kind === 'scripted') {
      await d.settle({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model: model.modelId, actorId: actor, provider: 'local' });
      return;
    }
    const usage = result.usage ?? estimateTestCaseTokens(input);
    const cost = estimateUsageCost(model.modelId, usage);
    await d.settle({
      sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model: model.modelId, actorId: actor, provider: 'bedrock',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    });
  } catch (e) {
    console.warn('[interviews] test case spend not booked', (e as Error)?.name ?? 'error');
  }
}
