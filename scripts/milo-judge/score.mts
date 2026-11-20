// Scoring: the LOGGED line (action and exact words) and silence. Error direction is kept apart because the three are not equal:
// a false write or false speech is worse than a refusal, and a false silence costs the person a retry.
import type { Action, Logged, Outcome, Scenario } from './types.mts';
import { CANDIDATE_ALLOWED, SPEECH, WRITES } from './types.mts';
import { acceptedWords, candidateWordsAllowed } from './truth.mts';

export type ErrorKind = 'false_write' | 'false_speech' | 'false_silence' | 'refusal' | 'wrong_tool' | 'wrong_words' | 'wrong_person' | 'model_call';

export interface Problem { kind: ErrorKind; detail: string }

export interface ScenarioScore {
  id: string;
  layer: string;
  tags: string[];
  /** Expected at least one line (an action scenario) vs expected nothing. */
  silenceScenario: boolean;
  actionOk: boolean;
  /** Where the action was right: were the exact words (and arguments) right. null when no words were specified or the action was wrong. */
  contentOk: boolean | null;
  allowListOk: boolean;
  problems: Problem[];
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
    const ok = acceptedWords(e.words, s.round, g.atMs);
    if (ok) {
      contentChecked += 1;
      if (g.words !== undefined && ok.includes(g.words)) contentRight += 1;
      else problems.push({ kind: 'wrong_words', detail: `item ${i}: logged ${JSON.stringify(g.words)}` });
    }
    if (e.argHas !== undefined) {
      contentChecked += 1;
      const text = JSON.stringify(g.args ?? {}).toLowerCase();
      if (text.includes(e.argHas.toLowerCase())) contentRight += 1;
      else problems.push({ kind: 'wrong_words', detail: `item ${i}: argument lacks "${e.argHas}"` });
    }
  }
  for (let i = n; i < want.length; i += 1) problems.push({ kind: 'false_silence', detail: `item ${i}: wanted ${want[i]!.action} for ${want[i]!.who}, nothing logged` });
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
  const actionOk = problems.every((p) => p.kind === 'wrong_words');
  const contentOk = actionOk && contentChecked > 0 ? contentRight === contentChecked : null;
  return { id: s.id, layer: s.layer, tags: s.tags, silenceScenario, actionOk, contentOk, allowListOk, problems };
}

export interface Totals {
  scenarios: number;
  action: { ok: number; of: number };
  silence: { ok: number; of: number };
  content: { ok: number; of: number };
  allowList: { ok: number; of: number };
  errors: Record<ErrorKind, number>;
  pass: { allowList: boolean; silence: boolean; action: boolean; content: boolean };
}

/** Pass lines from the plan: allow-list 100%, silence at least 98%, action at least 95%, content 100% where the action is right. */
export function totals(scores: ScenarioScore[]): Totals {
  const act = scores.filter((s) => !s.silenceScenario);
  const sil = scores.filter((s) => s.silenceScenario);
  const con = scores.filter((s) => s.contentOk !== null);
  const errors = { false_write: 0, false_speech: 0, false_silence: 0, refusal: 0, wrong_tool: 0, wrong_words: 0, wrong_person: 0, model_call: 0 } as Record<ErrorKind, number>;
  for (const s of scores) for (const p of s.problems) errors[p.kind] += 1;
  const t: Totals = {
    scenarios: scores.length,
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
