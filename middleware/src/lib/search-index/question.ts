// Question → query rewrite for the Work tenant (docs/user-search-goal.md U7,
// the orgiq table): deterministic, pure, no model. It strips question
// scaffolding ("who knows", "find the", "people with"), applies a small synonym
// table (k8s → Kubernetes, OTel ↔ OpenTelemetry), binds "my / me / I" to the
// signed-in person (U6 — the caller resolves the person), and names the
// structured intents a question asks, in priority order. The same parse feeds
// /api/search (lifts the answer records to the top) and the Answer tab's
// index answers (./answers.ts), so the two never disagree.
//
// Vocabulary (skills, team names, people, initiatives) comes from the index, so
// a skill or team added by a writer is understood without a code change.

import { initiativesNamed } from '../local-answers/match.js';

export interface Named { id: string; name: string }
export interface QuestionVocab { skills: string[]; teams: Named[]; people: Named[]; initiatives: Named[] }

export type QuestionIntent =
  | { kind: 'my-work' }
  | { kind: 'decisions'; statuses: string[] }
  | { kind: 'decider'; terms: string[] }
  | { kind: 'collaborators'; people: Named[] }
  | { kind: 'team'; teams: Named[] }
  | { kind: 'initiative-people'; initiatives: Named[] }
  | { kind: 'recent'; initiatives: Named[] }
  | { kind: 'experts'; skills: string[] };

export interface ParsedQuestion {
  /** The search terms after rewriting (empty when the intent alone answers). */
  terms: string[];
  intents: QuestionIntent[];
  /** The question binds "my / me / I" to the signed-in person. */
  mine: boolean;
}

/** Words that never narrow a search (the old providers/search.ts list). */
export const STOPWORDS = new Set('a an and are as at be by can could do does for from has have help how i in is it me my of on or our please should that the their them there these they this to us was we what when where which who why will with would you your finish find show about'.split(' '));
/** Question scaffolding: words that say what KIND of answer is wanted, not what it is about. */
const SCAFFOLD = new Set(('knows know knowing knew expert experts expertise specialist specialists people person persons someone somebody anyone anybody '
  + 'best top strongest strong most skill skills skilled good great am im i\'m mine any still all list get give tell').split(' '));
const TEAM_WORDS = new Set('team teams member members department departments group squad'.split(' '));
const COLLAB_WORDS = new Set('worked works working work closely collaborators collaborator collaborate collaborates collaborated collaboration partners partner'.split(' '));
const DECIDER_WORDS = new Set('decided decide decider deciders made make chose choose picked pick signed off call'.split(' '));
const RECENT_WORDS = new Set('changed change changes recent recently activity updates update updated latest new happened happening week today month'.split(' '));
const MINE_WORDS = new Set('assigned working tasks task items item stories story bugs bug plate open'.split(' '));

/** Phrase synonyms, applied before tokenizing. Each maps to the canonical term (a skill name where there is one). */
const PHRASES: Array<[RegExp, string]> = [
  [/\bk8s\b/gi, 'kubernetes'],
  [/\bretrieval[- ]augmented[- ]generation\b/gi, 'rag'],
  [/\bopen[- ]?telemetry\b/gi, 'opentelemetry otel'],
  [/\botel\b/gi, 'otel opentelemetry'],
  [/\badrs?\b/gi, 'decision'],
  [/\bbus[- ]factor\b/gi, 'bus factor'],
];
const STATUS_WORDS: Array<[RegExp, string[]]> = [
  [/\b(?:open|unresolved|undecided|pending|outstanding|undecided|in flight|not (?:yet )?decided|still open)\b/i, ['open', 'escalated']],
  [/\bescalat(?:ed|ions?)\b/i, ['escalated']],
  [/\bresolved\b(?<!unresolved)/i, ['resolved']],
  [/\brejected\b/i, ['rejected']],
];

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}'/+.-]*[\p{L}\p{N}+]|[\p{L}\p{N}]/gu) ?? [];
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}/+.]+/gu, ' ').trim();
const hasPhrase = (q: string, phrase: string) => phrase.length > 0 && ` ${plain(q)} `.includes(` ${plain(phrase)} `);

export function rewrite(question: string): string {
  let q = question;
  for (const [re, to] of PHRASES) q = q.replace(re, to);
  return q;
}

/** Skills the question names, as whole phrases (case-insensitive), longest first. */
export function skillsNamed(question: string, skills: string[]): string[] {
  const q = rewrite(question);
  const out: string[] = [];
  for (const s of [...new Set(skills)].sort((a, b) => b.length - a.length)) {
    if (hasPhrase(q, s) && !out.some(o => plain(o).includes(plain(s)))) out.push(s);
  }
  return out;
}

/** Teams the question names: a full name wins; else a team whose first word (≥ 4 letters) the question uses beside a team word. */
export function teamsNamed(question: string, teams: Named[]): Named[] {
  const full = teams.filter(t => hasPhrase(question, t.name));
  if (full.length) return full.filter(t => !full.some(o => o !== t && plain(o.name).includes(plain(t.name))));
  const ws = new Set(words(question));
  if (![...ws].some(w => TEAM_WORDS.has(w)) && !/\bwho(?:'s| is| are)? (?:on|in)\b/i.test(question) && !ws.has('people')) return [];
  return teams.filter(t => { const first = plain(t.name).split(' ')[0] ?? ''; return first.length >= 4 && ws.has(first); });
}

/** People the question names: full names first; else a first name that is followed by nothing else name-like. */
export function peopleNamed(question: string, people: Named[]): Named[] {
  const full = people.filter(p => hasPhrase(question, p.name));
  if (full.length) return full;
  const ws = new Set(words(question).map(w => w.replace(/'s$/, '')));
  return people.filter(p => { const first = plain(p.name).split(' ')[0] ?? ''; return first.length >= 3 && ws.has(first); });
}

const personAsked = (q: string) => /\bwho(?:'s|m)?\b/i.test(q) || words(q).some(w => SCAFFOLD.has(w) && !['any', 'all', 'list', 'get', 'give', 'tell', 'still', 'most'].includes(w)) || /\bsmes?\b|\bowners?\b|\bleads?\b|\bhelp\b/i.test(q);

export function parseQuestion(question: string, vocab: QuestionVocab): ParsedQuestion {
  const q = rewrite(question.trim());
  const ws = words(q);
  const set = new Set(ws);
  const mine = ws.some(w => w === 'my' || w === 'me' || w === 'i' || w === "i'm" || w === 'mine');
  const intents: QuestionIntent[] = [];
  const strip = new Set<string>([...STOPWORDS, ...SCAFFOLD]);

  // "what am I working on", "my open work items", "work assigned to me"
  if (mine && (ws.some(w => MINE_WORDS.has(w)) || set.has('work'))) {
    intents.push({ kind: 'my-work' });
    for (const w of [...MINE_WORDS, 'work']) strip.add(w);
  }
  // "which decisions are still open", "escalated decisions"
  if (set.has('decision') || set.has('decisions')) {
    const statuses = [...new Set(STATUS_WORDS.filter(([re]) => re.test(q)).flatMap(([, s]) => s))];
    if (statuses.length) {
      intents.push({ kind: 'decisions', statuses });
      for (const w of ['decision', 'decisions', 'open', 'unresolved', 'undecided', 'pending', 'outstanding', 'escalated', 'escalation', 'resolved', 'rejected', 'yet', 'not', 'decided']) strip.add(w);
    }
  }
  // "who decided on X", "who made the X decision", "decider for X"
  if (ws.some(w => DECIDER_WORDS.has(w)) && (set.has('who') || set.has('decider') || set.has('deciders') || set.has('decision'))) {
    const terms = ws.filter(w => !strip.has(w) && !DECIDER_WORDS.has(w) && w !== 'decision' && w !== 'decisions' && w !== 'over' && w !== 'vs');
    if (terms.length) intents.push({ kind: 'decider', terms });
  }
  // "people who worked with Nora", "Nora DaSilva collaborators"
  if (ws.some(w => COLLAB_WORDS.has(w)) && !intents.some(i => i.kind === 'my-work')) {
    const people = peopleNamed(q, vocab.people);
    if (people.length) { intents.push({ kind: 'collaborators', people }); for (const w of COLLAB_WORDS) strip.add(w); }
  }
  // "who is on the platform team", "Platform Engineering people"
  const teams = teamsNamed(q, vocab.teams);
  if (teams.length && !intents.length) { intents.push({ kind: 'team', teams }); for (const w of TEAM_WORDS) strip.add(w); }
  // An initiative named: who works on it, or what changed on it.
  const initiatives = initiativesNamed(q, vocab.initiatives);
  if (initiatives.length && !intents.length) {
    if (ws.some(w => RECENT_WORDS.has(w))) { intents.push({ kind: 'recent', initiatives }); for (const w of RECENT_WORDS) strip.add(w); }
    else if (personAsked(q)) intents.push({ kind: 'initiative-people', initiatives });
  }
  // "who knows Kubernetes", "Terraform skills", "best person for terraform modules"
  const skills = skillsNamed(q, vocab.skills);
  if (skills.length && !intents.length && personAsked(q)) intents.push({ kind: 'experts', skills });

  let terms = [...new Set(ws.filter(w => !strip.has(w)))];
  // A skill question searches for the skill, not the rest of the sentence ("modules").
  const experts = intents.find((i): i is Extract<QuestionIntent, { kind: 'experts' }> => i.kind === 'experts');
  if (experts) terms = [...new Set(experts.skills.flatMap(s => words(s)))];
  if (intents.some(i => i.kind === 'decisions' || i.kind === 'my-work')) terms = [];
  // Never strip a plain keyword search to nothing: "top" alone is a search for "top".
  if (!terms.length && !intents.length) terms = [...new Set(ws.filter(w => !STOPWORDS.has(w)))];
  return { terms, intents, mine };
}
