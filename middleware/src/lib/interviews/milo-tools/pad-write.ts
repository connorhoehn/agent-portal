// What the three pad tools share (pad-add-tests.ts, pad-add-import.ts, pad-add-helper.ts): who may ask, the interview's change
// limits, the counted solution check, and one write through Milo's own pad seat (pad/milo-writer.ts) in the pad's language at the
// moment of writing, logged in the pad log as Milo's (side `milo`). One write per interview at a time is the runner's rule for a
// writing tool (meeting-assistant/server-tools.ts); `PAD_BUSY` is what it says meanwhile.
import type { ToolSaid } from '../../meeting-assistant/server-tools.js';
import type { PadEventIn } from '../pad/log/rules.js';
import type { MiloPadPlan } from '../pad/milo-writer.js';
import { MAX_PAD_TEXT } from '../pad-text.js';
import { saidStore, type SaidSource } from '../speak/store.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT, type Interview, type KitQuestion, type PadLanguage } from '../types.js';
import { hasPad } from './context.js';
import {
  candidateMayAsk, deps, MAX_PAD_CHANGES, MAX_TEST_CASE_BATCHES, MAX_VERDICTS, NO_PAD, PAD_CHANGES_LIMIT, PAD_FAILED, PAD_LEAD_ONLY, PAD_OFF,
  PAD_TOO_LONG, standingOf, TESTS_LIMIT,
} from './deps.js';
import { entriesOf } from './helper.js';
import type { VerdictInput } from './verdict.js';

const verdictsRun = new Map<string, number>();
/** Tests: forget the solution checks counted. */
export function resetVerdicts(): void { verdictsRun.clear(); }

/** Who may have Milo change the pad: the lead; the candidate while the lead's switch is on; never a panel member; only in a coding round. */
export async function padMayAsk(interview: Interview, askedBy: string): Promise<true | { refusal: string } | null> {
  const standing = await standingOf(interview, askedBy);
  if (!standing) return null;
  if (!hasPad(interview)) return { refusal: NO_PAD };
  if (standing === 'panel') return { refusal: PAD_LEAD_ONLY };
  if (standing === 'candidate' && !(await candidateMayAsk(interview))) return { refusal: PAD_OFF };
  return true;
}

/** The kinds of the pad log a Milo change is logged under. */
export type PadChangeKind = 'tests' | 'imports' | 'helper';

/** What a pad tool's plan is given, and how it says what happened. */
export interface PadStep {
  /** The pad as it is when the write starts. */
  text: string;
  language: PadLanguage;
  questions: KitQuestion[];
  /** Every technical question's prompt: the solution check judges against all of them. */
  prompts: string[];
  /** The function names of every question (a helper may not be one). */
  entries: string[];
  /** The solution check, counted per interview and refused (fail closed) past MAX_VERDICTS. */
  judge(input: VerdictInput): Promise<'helper' | 'solution'>;
  /** Refused, with the sentence to say (and, for code in another language, the pad as it is for the model). Returns null. */
  refuse(line: string, retryNote?: string): null;
  /** What the change is logged as in the pad log. */
  kind(k: PadChangeKind): void;
  /** Done: the line to say once the change is in. */
  done(line: string, source: SaidSource): void;
}

/** The said-log kinds that count as one of Milo's pad changes. */
const CHANGES: readonly SaidSource[] = ['tests', 'imports', 'helper'];

/**
 * One pad tool's run: the interview's limits, then its plan against the pad as it is, the write, the pad log, and the line for what
 * happened. `testsBatch`: the change counts against the test-case batches too.
 */
export async function writePad(interview: Interview, plan: (step: PadStep) => ReturnType<MiloPadPlan>, opts: { testsBatch?: boolean } = {}): Promise<ToolSaid> {
  const d = deps();
  const said = await runWithDbTenant(INTERVIEWS_TENANT, () => saidStore().list(interview.id));
  if (said.filter((r) => CHANGES.includes(r.source)).length >= MAX_PAD_CHANGES) return { line: PAD_CHANGES_LIMIT, kind: 'refusal' };
  if (opts.testsBatch && said.filter((r) => r.source === 'tests').length >= MAX_TEST_CASE_BATCHES) return { line: TESTS_LIMIT, kind: 'refusal' };
  // Each solution check is a model call: counted per interview, and refused (fail closed) past MAX_VERDICTS.
  const judge = (input: VerdictInput): Promise<'helper' | 'solution'> => {
    const n = verdictsRun.get(interview.id) ?? 0;
    if (n >= MAX_VERDICTS) return Promise.resolve('solution');
    verdictsRun.set(interview.id, n + 1);
    if (verdictsRun.size > 500) verdictsRun.delete(verdictsRun.keys().next().value as string);
    return d.judge(interview.id, interview.leadId, input).catch(() => 'solution' as const);
  };
  const questions = await d.questions(interview).catch(() => []);
  // The verdict judges against EVERY technical question of the round and refuses a helper naming any of their functions: which
  // one the pad is working on cannot be told for sure (a renamed function matches none; review 2, item 2).
  const prompts = questions.map((q) => q.prompt.trim()).filter(Boolean);
  const entries = entriesOf(questions);
  let refusal: string | null = null;
  let retryNote: string | undefined;
  let done: ToolSaid | null = null;
  let kind: PadChangeKind = 'tests';
  const out = await d.write(interview.id, async ({ text, language }) => {
    if (text.length > MAX_PAD_TEXT) { refusal = PAD_TOO_LONG; return null; }
    return plan({
      text, language, questions, prompts, entries, judge,
      refuse: (line, note) => { refusal = line; if (note !== undefined) retryNote = note; return null; },
      kind: (k) => { kind = k; },
      done: (line, source) => { done = { line, kind: source }; },
    });
  });
  if (!out.ok) {
    if (refusal) return { line: refusal, kind: 'refusal', ...(retryNote !== undefined ? { retryNote } : {}) };
    console.warn('[interviews] Milo pad write not done', out.code);
    // Part of it reached the pad before the write failed: the attempt is logged, typed and taken out again (deleted the same
    // count) when the gateway confirmed it, with the pad as it then stood (review 1, item 4).
    if (out.typed) {
      const t = out.typed;
      const at = new Date(d.now());
      const clientAt = at.toISOString();
      await d.padLog(interview.id, [
        { kind, clientAt, from: t.from, inserted: t.inserted, deleted: t.removed ? t.inserted : 0, length: t.length, lines: t.lines, language: t.language } as PadEventIn,
        { kind: 'snapshot', clientAt, text: t.text, language: t.language, length: t.length } as PadEventIn,
      ], at).catch((e: unknown) => console.warn('[interviews] Milo\'s failed pad edit not logged', (e as Error)?.name ?? 'error'));
    }
    return { line: PAD_FAILED, kind: 'refusal' };
  }
  const at = new Date(d.now());
  const clientAt = at.toISOString();
  await d.padLog(interview.id, [
    { kind, clientAt, from: out.from, inserted: out.inserted, length: out.length, lines: out.lines, language: out.language } as PadEventIn,
    { kind: 'snapshot', clientAt, text: out.text, language: out.language, length: out.length } as PadEventIn,
  ], at).catch((e: unknown) => console.warn('[interviews] Milo\'s pad edit not logged', (e as Error)?.name ?? 'error'));
  return done ?? { line: PAD_FAILED, kind: 'refusal' };
}

/** The pad tools' arguments as an object (model output: anything else reads as no arguments). */
export const argsOf = (args: unknown): Record<string, unknown> => (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
