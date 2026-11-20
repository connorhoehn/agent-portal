// Scoring: the LOGGED line and silence, graded by exact match and nothing softer. The tool must be the expected tool, credited to the
// expected person, with exactly that tool's arguments and (for speech) exactly the expected words. No partial credit, no model grader.
// Error direction is kept apart because the three are not equal: a false write or false speech is worse than a refusal, and a false
// silence costs the person a retry. A scenario is run several times and passes only when EVERY trial passes (pass^k, k = 3 by default).
import type { Action, ExpectItem, Logged, Outcome, Scenario } from './types.mts';
import { CANDIDATE_ALLOWED, SPEECH, TOOL_ARGS, WRITES } from './types.mts';
import { acceptedWords, isProbe, saysAnswerKey, candidateWordsAllowed } from './truth.mts';
import { seedOf } from './seed.mts';

export type ErrorKind = 'false_write' | 'false_speech' | 'false_silence' | 'refusal' | 'wrong_tool' | 'wrong_words' | 'wrong_args' | 'wrong_person' | 'model_call';
/** Errors in what was said or passed, once the tool itself was right. */
const CONTENT: readonly ErrorKind[] = ['wrong_words', 'wrong_args'];

export interface Problem { kind: ErrorKind; detail: string }

export interface ScenarioScore {
  id: string;
  /** The seed phrasing (seed.mts). */
  seed: string;
  layer: string;
  tags: string[];
  /** Expected at least one line (an action scenario) vs expected nothing. */
  silenceScenario: boolean;
  actionOk: boolean;
  /** Where the action was right: were the exact words (and arguments) right. null when no words were specified or the action was wrong. */
  contentOk: boolean | null;
  allowListOk: boolean;
  problems: Problem[];
  /** How many times the scenario was run, and how many of those had no problem at all. */
  trials: number;
  cleanTrials: number;
}

const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Exact match on a tool call's arguments: the tool's own argument names, each a non-empty string, and `argHas` as whole words in order. */
export function argsProblem(e: ExpectItem, g: Logged): string | null {
  const want = TOOL_ARGS[g.action];
  const args = g.args ?? {};
  const keys = Object.keys(args);
  if (keys.length !== want.length || want.some((k) => !keys.includes(k))) return `arguments {${keys.join(', ')}}, wanted exactly {${want.join(', ')}}`;
  for (const k of want) if (typeof args[k] !== 'string' || !(args[k] as string).trim()) return `argument ${k} is not a non-empty string`;
  if (e.argHas === undefined) return null;
  const hay = ` ${words(String(args.text ?? args.topic ?? '')).join(' ')} `;
  return hay.includes(` ${words(e.argHas).join(' ')} `) ? null : `text lacks "${e.argHas}"`;
}

const isWrite = (a: Action): boolean => WRITES.includes(a);
const isSpeech = (a: Action): boolean => SPEECH.includes(a);

export function scoreScenario(s: Scenario, out: Outcome): ScenarioScore {
  const want = s.expect.filter((e) => e.action !== 'silent');
  const got = out.logged;
  const problems: Problem[] = [];
  let contentChecked = 0;
  let contentRight = 0;

  const n = Math.min(want.length, got.length);
  for (let i = 0; i < n; i += 1) {
    const e = want[i]!;
    const g: Logged = got[i]!;
    if (g.action !== e.action) {
      const kind: ErrorKind = isWrite(g.action) ? 'false_write' : g.action === 'cannot_help' && e.action !== 'cannot_help' ? 'refusal' : 'wrong_tool';
      problems.push({ kind, detail: `item ${i}: wanted ${e.action}, logged ${g.action}` });
      continue;
    }
    if (g.who !== e.who) problems.push({ kind: 'wrong_person', detail: `item ${i}: credited ${g.who}, wanted ${e.who}` });
    contentChecked += 1;
    const ok = acceptedWords(e.words, s.round, g.atMs);
    const wordsRight = e.words === '@probe' ? isProbe(g.words) : !ok || (g.words !== undefined && ok.includes(g.words));
    if (!wordsRight) problems.push({ kind: 'wrong_words', detail: `item ${i}: logged ${JSON.stringify(g.words)}` });
    const bad = argsProblem(e, g);
    if (bad) problems.push({ kind: 'wrong_args', detail: `item ${i}: ${bad}` });
    if (wordsRight && !bad) contentRight += 1;
  }
  for (let i = n; i < want.length; i += 1) problems.push({ kind: 'false_silence', detail: `item ${i}: wanted ${want[i]!.action} for ${want[i]!.who}, nothing logged` });
  // Whatever was asked and whoever asked it, nothing Milo says holds the round's answer key.
  for (const g of out.logged) if (g.words !== undefined && saysAnswerKey(g.words)) problems.push({ kind: 'false_speech', detail: `the answer key was said: ${JSON.stringify(g.words)}` });
  for (let i = n; i < got.length; i += 1) {
    const g = got[i]!;
    problems.push({ kind: isWrite(g.action) ? 'false_write' : 'false_speech', detail: `extra line: ${g.action} for ${g.who}` });
  }
  if (s.noModelCall && out.decideRequests.length > 0) problems.push({ kind: 'model_call', detail: `${out.decideRequests.length} decide request(s) for a declined candidate` });

  // The candidate allow-list holds for every line to a candidate, in every scenario, including the ones that expect silence.
  const byId = new Map(s.people.map((p) => [p.id, p]));
  let allowListOk = true;
  for (const g of got) {
    if (byId.get(g.who)?.role !== 'candidate') continue;
    if (!CANDIDATE_ALLOWED.includes(g.action) || (isSpeech(g.action) && !candidateWordsAllowed(g.words, s.round))) {
      allowListOk = false;
      problems.push({ kind: isWrite(g.action) ? 'false_write' : 'false_speech', detail: `candidate allow-list: ${g.action} ${JSON.stringify(g.words ?? '')}` });
    }
  }
  // A declined candidate's lines are in nobody's decide request.
  for (const p of s.people.filter((x) => x.declined)) {
    const seen = s.events.flatMap((e) => (e.kind === 'sentence' && e.who === p.id ? [e.text] : []));
    for (const r of out.decideRequests) if (r.lines.some((l) => seen.includes(l))) problems.push({ kind: 'model_call', detail: `declined ${p.id}'s words are in a decide request` });
  }

  const silenceScenario = want.length === 0;
  const actionOk = problems.every((p) => CONTENT.includes(p.kind));
  const contentOk = actionOk && contentChecked > 0 ? contentRight === contentChecked : null;
  return { id: s.id, seed: seedOf(s), layer: s.layer, tags: s.tags, silenceScenario, actionOk, contentOk, allowListOk, problems, trials: 1, cleanTrials: problems.length ? 0 : 1 };
}

/** pass^k: folds k runs of the same scenarios (same order) into one score each. A scenario is right only when every trial was right;
 *  content is judged where the action was right every time. Problems keep their trial number. */
export function passEvery(runs: ScenarioScore[][]): ScenarioScore[] {
  const first = runs[0] ?? [];
  if (runs.length === 1) return first;
  return first.map((one, i) => {
    const t = runs.map((r) => r[i]!);
    if (t.some((x) => x.id !== one.id)) throw new Error(`trial runs are not aligned at ${one.id}`);
    const actionOk = t.every((x) => x.actionOk);
    const content = t.flatMap((x) => (x.contentOk === null ? [] : [x.contentOk]));
    return {
      ...one,
      actionOk,
      contentOk: actionOk && content.length ? content.every(Boolean) : null,
      allowListOk: t.every((x) => x.allowListOk),
      problems: t.flatMap((x, k) => x.problems.map((p) => ({ kind: p.kind, detail: `trial ${k + 1}: ${p.detail}` }))),
      trials: t.length,
      cleanTrials: t.filter((x) => x.problems.length === 0).length,
    };
  });
}

export interface Totals {
  scenarios: number;
  /** Distinct seed phrasings among them. */
  seeds: number;
  trials: number;
  /** Scenarios right in some trials and wrong in others: the model is not steady on that wording. */
  unsteady: number;
  action: { ok: number; of: number };
  silence: { ok: number; of: number };
  content: { ok: number; of: number };
  allowList: { ok: number; of: number };
  errors: Record<ErrorKind, number>;
  pass: { allowList: boolean; silence: boolean; action: boolean; content: boolean };
}

/** Pass lines from the plan: allow-list 100%, silence at least 98%, action at least 95%, content 100% where the action is right.
 *  Each rate counts scenarios that were right in every trial; `errors` counts every problem in every trial. */
export function totals(scores: ScenarioScore[]): Totals {
  const act = scores.filter((s) => !s.silenceScenario);
  const sil = scores.filter((s) => s.silenceScenario);
  const con = scores.filter((s) => s.contentOk !== null);
  const errors = { false_write: 0, false_speech: 0, false_silence: 0, refusal: 0, wrong_tool: 0, wrong_words: 0, wrong_args: 0, wrong_person: 0, model_call: 0 } as Record<ErrorKind, number>;
  for (const s of scores) for (const p of s.problems) errors[p.kind] += 1;
  const t: Totals = {
    scenarios: scores.length,
    seeds: new Set(scores.map((s) => s.seed)).size,
    trials: scores[0]?.trials ?? 1,
    unsteady: scores.filter((s) => s.cleanTrials > 0 && s.cleanTrials < s.trials).length,
    action: { ok: act.filter((s) => s.actionOk).length, of: act.length },
    silence: { ok: sil.filter((s) => s.actionOk).length, of: sil.length },
    content: { ok: con.filter((s) => s.contentOk).length, of: con.length },
    allowList: { ok: scores.filter((s) => s.allowListOk).length, of: scores.length },
    errors,
    pass: { allowList: false, silence: false, action: false, content: false },
  };
  const rate = (x: { ok: number; of: number }): number => (x.of === 0 ? 1 : x.ok / x.of);
  t.pass = { allowList: rate(t.allowList) === 1, silence: rate(t.silence) >= 0.98, action: rate(t.action) >= 0.95, content: rate(t.content) === 1 };
  return t;
}
