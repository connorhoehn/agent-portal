// Milo's interview tools: one registry, two triggers, one path (docs/interviews-tenant-plan.md, "Milo's interview tools").
//
// The tools are named, described and given their schemas in the shared catalogue (voice/catalogue.ts INTERVIEW_TOOLS); what
// each one DOES is here. Two triggers reach the same function, `runMiloTool`:
//   (a) the detector's exact phrase, for the tools that take no arguments (`toolOfPhrase`: "how much time is left", "repeat the
//       question", "Milo, introduce yourself"), answered at once with no model (milo-policy.ts `answerFromHeldText`);
//   (b) the live session's function call, for everything else (the orchestrator's checks of a call, then the policy's `runTool`).
// `runMiloTool` decides who may ask (the lead always; anyone for `time_left` and `repeat_question`; the candidate for the pad tools
// only while the lead's switch is on, milo-settings.ts; a panel member not for the pad), runs the tool, and logs the line Milo
// will say in the said log, unposted; the orchestrator then posts it with the approved mark and says it as approved words, and
// `heldTextSaid` marks the row. Every refusal is one fixed sentence. Nothing a model writes is ever said: the lines are the
// server's own, and what a model wrote reaches the pad only through the checks of tests.ts, imports.ts and helper.ts.
//
// The pad tools write through Milo's own pad seat (pad/milo-writer.ts, admitted by admitPadChannel), in the pad's language at the
// moment of writing, one write per interview at a time, credited to Milo in the pad log (side `milo`). They cost nothing beyond
// the live session, except a candidate's helper, whose solution check is held and settled under the interview's cap (verdict.ts).
import { randomBytes } from 'node:crypto';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEW_TOOLS, responsesFunctionTools, serverTool, type ResponsesFunctionTool } from '../../voice/catalogue.js';
import { interviewsNowMs } from '../clock.js';
import { miloSettingsStore, type MiloSettings } from '../milo-settings.js';
import { appendPadEvents, MILO_WRITER_ID } from '../pad/log/service.js';
import type { PadEventIn } from '../pad/log/rules.js';
import { writeIntoPad, type MiloPadPlan, type MiloPadWriteResult } from '../pad/milo-writer.js';
import { candidateLine } from '../speak/index.js';
import { logIntroduction } from '../speak/intro.js';
import { saidStore, type SaidSource } from '../speak/store.js';
import { interviewsStore } from '../store-select.js';
import { INTERVIEWS_TENANT, type Interview, type KitQuestion, type PadLanguage } from '../types.js';
import { functionOf } from '../testcases/render.js';
import { MAX_PAD_TEXT } from '../pad-text.js';
import { checkedImportLines, placeImports } from './imports.js';
import { checkHelper, entryOf, helperBlock, placeHelper } from './helper.js';
import { judgeHelper, type VerdictInput } from './verdict.js';
import { testCasesFor, questionForPad } from './tests.js';
import { atEnd } from '../pad/milo-writer.js';
import { hasPad, interviewBackendInstructions } from './context.js';

export type Standing = 'lead' | 'panel' | 'candidate';

// ── The fixed sentences ──────────────────────────────────────────────────────────────────────────────────────────────────
export const PAD_OFF = "The lead hasn't turned on pad help from Milo for this round.";
export const PAD_LEAD_ONLY = 'Only the lead interviewer, or the candidate when the lead allows it, can ask Milo to change the pad.';
export const INTRO_LEAD_ONLY = 'Only the lead interviewer can ask Milo to introduce itself.';
export const NO_PAD = 'There is no code pad in this round.';
export const PAD_BUSY = 'Milo is still writing in the pad.';
export const NOT_SOLUTION = "I can add test cases, imports or a helper, but I can't write the solution.";
export const NOT_STANDARD_IMPORT = 'Milo only adds standard-library imports at the top of the pad.';
export const NOTHING_NEW = 'The pad already has that.';
export const HELPER_NOT_ADDED = "Milo couldn't add that helper to the pad.";
export const TESTS_NOT_ADDED = "Milo couldn't add those test cases to the pad.";
export const PAD_FAILED = "Milo couldn't change the pad this time.";
export const PAD_TOO_LONG = 'The pad is too long for Milo to change.';
export const TESTS_LIMIT = 'Milo has already added test cases three times in this round.';
export const ON_IT = 'On it.';
/** The most times Milo writes test cases in one interview. */
export const MAX_TEST_CASE_BATCHES = 3;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
export const countWords = (n: number): string => NUMBER_WORDS[n] ?? String(n);
export const testsAddedLine = (n: number, checked: boolean): string => (checked
  ? `Added ${countWords(n)} test case${n === 1 ? '' : 's'} at the bottom of the pad.`
  : `Added ${countWords(n)} test input${n === 1 ? '' : 's'} at the bottom of the pad. The expected values are yours to fill in.`);
export const importsAddedLine = (n: number): string => (n === 1 ? 'Added the import at the top of the pad.' : `Added ${countWords(n)} imports at the top of the pad.`);
export const HELPER_ADDED = 'Added the helper at the top of the pad, marked as added by Milo.';

/** What this asker may ask for, said when Milo heard a request it could not serve (milo-policy.ts `heldFallback`). */
export function whatICanDo(standing: Standing, padHelp: boolean, padRound: boolean): string | null {
  if (standing === 'panel') return null;
  if (standing === 'candidate' && !(padHelp && padRound)) return null; // the candidate's own fixed sentence (speak/index.ts MILO_CAN_DO)
  return padRound
    ? (standing === 'lead'
      ? "I can add test cases, imports or a helper to the pad, introduce myself, or tell you how much time is left. I can't write the solution."
      : "I can repeat the question, tell you how much time is left, or add test cases, imports or a helper to the pad. I can't write the solution.")
    : 'I can introduce myself, repeat the question or tell you how much time is left.';
}

// ── The interview behind a request ───────────────────────────────────────────────────────────────────────────────────────

export interface MiloToolDeps {
  interview: (interviewId: string) => Promise<Interview | null>;
  /** The guest id was minted for this interview (milo-policy.ts). */
  guestOf: (userId: string, interviewId: string) => Promise<boolean>;
  settings: (interviewId: string) => Promise<MiloSettings>;
  questions: (interview: Interview) => Promise<KitQuestion[]>;
  write: (interviewId: string, plan: MiloPadPlan) => Promise<MiloPadWriteResult>;
  padLog: (interviewId: string, events: readonly PadEventIn[], at: Date) => Promise<number>;
  judge: (interviewId: string, leadId: string, input: VerdictInput) => Promise<'helper' | 'solution'>;
  now: () => number;
  newId: () => string;
}

const GUEST = /^guest:(.+)$/;

async function roundQuestions(interview: Interview): Promise<KitQuestion[]> {
  const store = interviewsStore();
  const [applications, openings] = await runWithDbTenant(INTERVIEWS_TENANT, () => Promise.all([store.listApplications(), store.listOpenings()]));
  const opening = openings.find((o) => o.id === applications.find((a) => a.id === interview.applicationId)?.openingId);
  const bank = opening?.kit.questions ?? [];
  const chosen = interview.questionIds.length ? bank.filter((q) => interview.questionIds.includes(q.id)) : bank;
  return chosen.filter((q) => q.roundType === 'technical');
}

const DEFAULTS: MiloToolDeps = {
  interview: async (id) => (await runWithDbTenant(INTERVIEWS_TENANT, () => interviewsStore().listInterviews())).find((i) => i.id === id) ?? null,
  guestOf: async (userId, interviewId) => {
    const inviteId = GUEST.exec(userId)?.[1];
    if (!inviteId) return false;
    const { inviteStore } = await import('../invite/store.js');
    return (await inviteStore().getInvite(inviteId).catch(() => null))?.interviewId === interviewId;
  },
  settings: (id) => runWithDbTenant(INTERVIEWS_TENANT, () => miloSettingsStore().get(id)),
  questions: roundQuestions,
  write: writeIntoPad,
  padLog: (id, events, at) => runWithDbTenant(INTERVIEWS_TENANT, () => appendPadEvents(id, { id: MILO_WRITER_ID, side: 'milo' }, events, at)),
  judge: judgeHelper,
  now: interviewsNowMs,
  newId: () => `said-${randomBytes(8).toString('hex')}`,
};
let overrides: Partial<MiloToolDeps> = {};
/** Tests: replace some dependencies; `null` puts every default back. */
export function setMiloToolDeps(next: Partial<MiloToolDeps> | null): void { overrides = next ?? {}; }
const deps = (): MiloToolDeps => ({ ...DEFAULTS, ...overrides });

/** Where this person stands in the interview: its lead, on its panel, its candidate (a guest of its invite), or nowhere. */
export async function standingOf(interview: Interview, userId: string): Promise<Standing | null> {
  if (userId === interview.leadId) return 'lead';
  if (interview.panelIds.includes(userId)) return 'panel';
  if (GUEST.test(userId) && (await deps().guestOf(userId, interview.id).catch(() => false))) return 'candidate';
  return null;
}

// ── Trigger (a): the exact phrases ───────────────────────────────────────────────────────────────────────────────────────

const LEAD = String.raw`(?:(?:um|uh|sorry|so|ok|okay|hey|hi|and|but)\s+)*(?:(?:hey\s+)?milo\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?`;
const INTRO = new RegExp(String.raw`^${LEAD}(?:introduce\s+yourself|say\s+(?:hello|hi)(?:\s+to\s+\w+)?)(?:\s+(?:please|to\s+\w+|to\s+the\s+candidate))*$`);

/** The argument-less tool an utterance asks for, word for word (anything looser goes to the live model); null when none. */
export async function toolOfPhrase(text: string): Promise<'time_left' | 'repeat_question' | 'introduce' | null> {
  const { candidateRequestOf } = await import('../speak/index.js');
  const r = candidateRequestOf(text);
  if (r === 'time') return 'time_left';
  if (r === 'repeat') return 'repeat_question';
  const { isIntroduction } = await import('../speak/intro.js');
  const t = text.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return INTRO.test(t) || isIntroduction(text) ? 'introduce' : null;
}

/** A pad request the slow tools serve (test cases, a helper), by its words: acknowledged with "On it." when its call is coming. */
export const SLOW_PAD_REQUEST = /\btest\s*(?:cases?|inputs?)\b|\bhelper\b|\b(?:class|data structure|cache|trie|heap|linked list)\b/i;

// ── The one path ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Argument-less tools heard twice for one request (the phrase and the model's call): the second within this is not run. */
export const REPEAT_WINDOW_MS = 20_000;
const recent = new Map<string, number>();
const writing = new Set<string>();

interface Ran { line: string; source: SaidSource }

async function logLine(interview: Interview, askedBy: string, ran: Ran): Promise<string> {
  const d = deps();
  await runWithDbTenant(INTERVIEWS_TENANT, () => saidStore().append({
    id: d.newId(), interviewId: interview.id, callId: interview.callId, kind: 'answer', source: ran.source, questionId: null, suggestionId: null,
    text: ran.line, askedBy, saidAt: new Date(d.now()).toISOString(), posted: false, spoken: false,
  }));
  return ran.line;
}

/**
 * Run tool `name` for `askedBy` in the interview: who may ask, the tool, the line logged (unposted). The line to post and say,
 * or null for nothing (not a live interview, not one of its people, a repeat of the same request, already introduced).
 */
export async function runMiloTool(interviewId: string, askedBy: string, name: string, args: unknown): Promise<string | null> {
  const d = deps();
  const spec = serverTool(name);
  if (!spec) return null;
  const interview = await d.interview(interviewId).catch(() => null);
  if (!interview || interview.state !== 'live') return null;
  const standing = await standingOf(interview, askedBy);
  if (!standing) return null;
  if (spec.who === 'lead' && standing !== 'lead') return logLine(interview, askedBy, { line: INTRO_LEAD_ONLY, source: 'refusal' });
  if (spec.who === 'pad') {
    if (interview.type !== 'technical') return logLine(interview, askedBy, { line: NO_PAD, source: 'refusal' });
    if (standing === 'panel') return logLine(interview, askedBy, { line: PAD_LEAD_ONLY, source: 'refusal' });
    if (standing === 'candidate' && !(await d.settings(interview.id).catch(() => null))?.candidateMayAsk) return logLine(interview, askedBy, { line: PAD_OFF, source: 'refusal' });
  }
  if (spec.who !== 'pad') {
    const key = `${interview.id}|${askedBy}|${name}`;
    const now = d.now();
    if (now - (recent.get(key) ?? -Infinity) < REPEAT_WINDOW_MS) return null;
    recent.set(key, now);
    if (recent.size > 500) recent.delete(recent.keys().next().value as string);
  }
  switch (name) {
    case 'time_left': { const r = await candidateLine(interview, 'time'); return logLine(interview, askedBy, { line: r.text, source: r.source }); }
    case 'repeat_question': { const r = await candidateLine(interview, 'repeat'); return logLine(interview, askedBy, { line: r.text, source: r.source }); }
    case 'introduce': return logIntroduction(interview, askedBy, d.now, d.newId);
    default: break;
  }
  if (writing.has(interview.id)) return logLine(interview, askedBy, { line: PAD_BUSY, source: 'refusal' });
  writing.add(interview.id);
  try {
    return logLine(interview, askedBy, await runPadTool(interview, standing, name, args));
  } catch (e) {
    console.warn('[interviews] Milo pad tool failed', (e as Error)?.name ?? 'error');
    return logLine(interview, askedBy, { line: PAD_FAILED, source: 'refusal' }).catch(() => PAD_FAILED);
  } finally {
    writing.delete(interview.id);
  }
}

/** A pad tool: the checks and the write against the pad as it is (its text and language then), and the line for what happened. */
async function runPadTool(interview: Interview, standing: Standing, name: string, args: unknown): Promise<Ran> {
  const d = deps();
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (name === 'pad_add_tests') {
    const earlier = (await runWithDbTenant(INTERVIEWS_TENANT, () => saidStore().list(interview.id))).filter((r) => r.source === 'tests').length;
    if (earlier >= MAX_TEST_CASE_BATCHES) return { line: TESTS_LIMIT, source: 'refusal' };
  }
  const questions = await d.questions(interview).catch(() => []);
  let refusal: string | null = null;
  let done: Ran | null = null;
  let kind: 'tests' | 'imports' | 'helper' = 'tests';
  const plan: MiloPadPlan = async ({ text, language }) => {
    if (text.length > MAX_PAD_TEXT) { refusal = PAD_TOO_LONG; return null; }
    const question = questionForPad(questions, text, language);
    if (name === 'pad_add_tests') {
      const made = testCasesFor(a['cases'], { pad: text, language, question, fn: functionOf(text, language) ?? entryOf(question?.starter, language) });
      if (!made.ok) { refusal = TESTS_NOT_ADDED; return null; }
      // A long string value could carry the algorithm: such a batch is judged like a helper, and refused with no question to judge by.
      if (made.longStrings) {
        if (!question?.prompt.trim()) { refusal = TESTS_NOT_ADDED; return null; }
        const verdict = await d.judge(interview.id, interview.leadId, { question: question.prompt, code: made.block, entry: entryOf(question.starter, language), kind: 'tests' }).catch(() => 'solution' as const);
        if (verdict !== 'helper') { refusal = TESTS_NOT_ADDED; return null; }
      }
      done = { line: testsAddedLine(made.count, made.checked), source: 'tests' };
      kind = 'tests';
      return atEnd(made.block);
    }
    if (name === 'pad_add_import') {
      const lines = checkedImportLines(a['lines'], language);
      if (!lines) { refusal = NOT_STANDARD_IMPORT; return null; }
      kind = 'imports';
      return (current) => {
        const placed = placeImports(current, lines, language);
        if (!placed) { refusal = NOTHING_NEW; return null; }
        done = { line: importsAddedLine(placed.text.trim().split('\n').length), source: 'imports' };
        return placed;
      };
    }
    // pad_add_helper
    const what = typeof a['what'] === 'string' ? a['what'] : '';
    const checked = checkHelper(what, a['code'], language, entryOf(question?.starter, language));
    if (!checked.ok) { refusal = checked.why === 'entry' ? NOT_SOLUTION : HELPER_NOT_ADDED; return null; }
    if (checked.kind === 'import') {
      kind = 'imports';
      return (current) => {
        const placed = placeImports(current, [checked.line], language);
        if (!placed) { refusal = NOTHING_NEW; return null; }
        done = { line: importsAddedLine(1), source: 'imports' };
        return placed;
      };
    }
    // Every helper is judged, whoever asked; with no question to judge it by, it is refused (fail closed; review 1, item 3).
    if (!question?.prompt.trim()) { refusal = HELPER_NOT_ADDED; return null; }
    const verdict = await d.judge(interview.id, interview.leadId, { question: question.prompt, code: checked.code, entry: entryOf(question.starter, language), kind: 'helper' }).catch(() => 'solution' as const);
    if (verdict !== 'helper') { refusal = NOT_SOLUTION; return null; }
    kind = 'helper';
    const block = helperBlock(checked.code, what, language);
    return (current) => {
      done = { line: HELPER_ADDED, source: 'helper' };
      return placeHelper(current, block, language);
    };
  };
  const out = await d.write(interview.id, plan);
  if (!out.ok) {
    if (refusal) return { line: refusal, source: 'refusal' };
    console.warn('[interviews] Milo pad write not done', out.code);
    return { line: PAD_FAILED, source: 'refusal' };
  }
  const at = new Date(d.now());
  const clientAt = at.toISOString();
  await d.padLog(interview.id, [
    { kind, clientAt, from: out.from, inserted: out.inserted, length: out.length, lines: out.lines, language: out.language } as PadEventIn,
    { kind: 'snapshot', clientAt, text: out.text, language: out.language, length: out.length } as PadEventIn,
  ], at).catch((e: unknown) => console.warn('[interviews] Milo\'s pad edit not logged', (e as Error)?.name ?? 'error'));
  return done ?? { line: PAD_FAILED, source: 'refusal' };
}

// ── What the policy asks besides running a tool ──────────────────────────────────────────────────────────────────────────

/**
 * The tools a live interview's session is offered and what its background agent is told (policy `sessionTools`): every tool for
 * a coding round, the spoken ones only otherwise; the round's questions and the pad as it is now (read through Milo's own seat,
 * which writes nothing). Nothing for an interview that is not live.
 */
export async function sessionToolsFor(interviewId: string): Promise<{ tools: ResponsesFunctionTool[]; backendInstructions: string }> {
  const d = deps();
  const interview = await d.interview(interviewId).catch(() => null);
  if (!interview || interview.state !== 'live') return { tools: [], backendInstructions: '' };
  const pad = hasPad(interview);
  const tools = INTERVIEW_TOOLS.filter((t) => pad || t.who !== 'pad');
  let seen: { text: string; language: PadLanguage } | null = null;
  if (pad) await d.write(interview.id, ({ text, language }) => { seen = { text, language }; return null; }).catch(() => null);
  const questions = pad ? await d.questions(interview).catch(() => []) : [];
  return { tools: responsesFunctionTools(tools), backendInstructions: interviewBackendInstructions(questions, seen) };
}

/** May this person have Milo run `name` here at all (policy `mayUseTool`)? One of the interview's people, in a live interview. */
export async function mayAsk(interviewId: string, userId: string, name: string): Promise<boolean> {
  if (!serverTool(name)) return false;
  const interview = await deps().interview(interviewId).catch(() => null);
  return !!interview && interview.state === 'live' && (await standingOf(interview, userId)) !== null;
}

/**
 * The line for a request nothing answered (policy `heldFallback`): what THIS asker may ask, logged; the candidate without pad
 * help gets `candidateLine` (their own fixed sentence, speak/index.ts MILO_CAN_DO); a panel member, nothing.
 */
export async function fallbackLine(interviewId: string, askedBy: string, candidateLine: string): Promise<string | null> {
  const d = deps();
  const interview = await d.interview(interviewId).catch(() => null);
  if (!interview || interview.state !== 'live') return null;
  const standing = await standingOf(interview, askedBy);
  if (!standing || standing === 'panel') return null;
  const padHelp = standing === 'lead' || !!(await d.settings(interview.id).catch(() => null))?.candidateMayAsk;
  const line = whatICanDo(standing, padHelp, hasPad(interview)) ?? candidateLine;
  return logLine(interview, askedBy, { line, source: 'refusal' });
}

/** "On it." for a slow pad request (test cases, a helper) from someone allowed to make it (policy `heldAcknowledgement`), logged. */
export async function acknowledgementLine(interviewId: string, askedBy: string, text: string): Promise<string | null> {
  if (!SLOW_PAD_REQUEST.test(text)) return null;
  const d = deps();
  const interview = await d.interview(interviewId).catch(() => null);
  if (!interview || interview.state !== 'live' || !hasPad(interview) || writing.has(interview.id)) return null;
  const standing = await standingOf(interview, askedBy);
  const allowed = standing === 'lead' || (standing === 'candidate' && !!(await d.settings(interview.id).catch(() => null))?.candidateMayAsk);
  return allowed ? logLine(interview, askedBy, { line: ON_IT, source: 'ack' }) : null;
}

/** Tests: forget the repeat window and the in-flight writes. */
export function resetMiloTools(): void { recent.clear(); writing.clear(); }

export type { PadLanguage };
