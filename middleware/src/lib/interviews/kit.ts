// An opening's kit and details, checked before anything is written (docs/interviews-tenant-plan.md,
// rows I1.3 and I1.8; decisions 6, 8, 11, 14 and 20).
//
// Pure functions over plain input, so the route, a later importer and the tests all hold a kit to the
// same rules. Each check answers either the cleaned value (strings trimmed, unknown fields dropped) or
// a list of problems, one plain sentence per field, keyed by a path the editor maps to its field:
//
//   rounds | competencies | questions               the list itself (too few, too many, a removal)
//   rounds.<i>.<field>                              name, type, minutes
//   competencies.<i>.<field>                        name, lookFor, anchors.<1-4>
//   questions.<i>.<field>                           prompt, competencyId, roundType, followUps.<j>, starter.<language>
//   <field>                                         an opening's details: title, level, team, location, ...
//
// <i> is the item's position in the list as sent, so the editor needs no ids to place a message.
//
// What the kit promises the rows that read it unchanged:
//   - I3.3 (the coach) reads competencies with what good looks like, and questions with their follow-ups.
//   - I4.2 (the pad) inserts a technical question's starter code in the pad's language; a behavioural
//     round has no pad (roundHasPad), so a behavioural question never carries code.
//   - I5.3 (the scorecard) rates each competency against its four anchors by competency id.
// Ids are stable across edits and an item an interview or a scorecard points at cannot be removed (or a
// round's or chosen question's type changed), so those rows never meet a dangling id.

import {
  OPENING_STATES, PAD_LANGUAGES, ROUND_TYPES,
  type InterviewsWorld, type KitCompetency, type KitQuestion, type KitRound, type OpeningDetails, type OpeningKit, type OpeningState,
  type PadLanguage, type RoundType,
} from './types.js';

export const KIT_LIMITS = {
  rounds: 6,
  competencies: 12,
  questions: 60,
  followUps: 5,
  name: 60,
  lookFor: 400,
  anchor: 200,
  prompt: 1000,
  followUp: 300,
  starter: 8000,
  minutesMin: 15,
  minutesMax: 180,
} as const;

export const DETAIL_LIMITS = { title: 120, level: 40, team: 60, location: 80, budgetCapUsd: 1000 } as const;

export const PAD_LANGUAGE_LABELS: Readonly<Record<PadLanguage, string>> = {
  python: 'Python', swift: 'Swift', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', go: 'Go', cpp: 'C++',
};

/** Only a technical round has the code pad (decision 11); a behavioural round never does (row I1.8). */
export function roundHasPad(type: RoundType): boolean {
  return type === 'technical';
}

export const EMPTY_KIT: OpeningKit = { rounds: [], competencies: [], questions: [] };

export interface FieldProblem {
  path: string;
  message: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: FieldProblem[] };

/** "The kit was not saved: 2 things need fixing." — the line above the per-field sentences. */
export function problemsLine(what: 'kit' | 'details' | 'opening', count: number): string {
  const noun = what === 'kit' ? 'The kit' : what === 'details' ? 'The details' : 'The opening';
  return `${noun} ${what === 'details' ? 'were' : 'was'} not saved: ${count === 1 ? 'one thing needs' : `${count} things need`} fixing.`;
}

/** What the opening's interviews and scorecards point at, so the kit editor cannot pull it out from under them. */
export interface KitInUse {
  roundIds: ReadonlySet<string>;
  competencyIds: ReadonlySet<string>;
  questionIds: ReadonlySet<string>;
}

export const NOTHING_IN_USE: KitInUse = { roundIds: new Set(), competencyIds: new Set(), questionIds: new Set() };

export function kitInUse(world: Pick<InterviewsWorld, 'applications' | 'interviews' | 'scorecards'>, openingId: string): KitInUse {
  const appIds = new Set(world.applications.filter((a) => a.openingId === openingId).map((a) => a.id));
  const interviews = world.interviews.filter((i) => appIds.has(i.applicationId));
  const interviewIds = new Set(interviews.map((i) => i.id));
  return {
    roundIds: new Set(interviews.map((i) => i.roundId)),
    questionIds: new Set(interviews.flatMap((i) => i.questionIds)),
    competencyIds: new Set(world.scorecards.filter((s) => interviewIds.has(s.interviewId)).flatMap((s) => s.ratings.map((r) => r.competencyId))),
  };
}

// ── small readers ────────────────────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const plain = (n: number) => n.toLocaleString('en-US');

class Problems {
  readonly list: FieldProblem[] = [];
  add(path: string, message: string): void { this.list.push({ path, message }); }
  /** A required string within a length; the cleaned value, or '' after a problem. */
  str(path: string, v: unknown, max: number, missing: string, tooLong: string): string {
    const s = text(v);
    if (!s) this.add(path, missing);
    else if (s.length > max) this.add(path, tooLong);
    return s;
  }
}

const quoted = (name: string, fallback: string) => (name ? `"${name}"` : fallback);

// ── the kit ──────────────────────────────────────────────────────────────────

/**
 * Check a kit sent by the editor. `previous` is the kit as saved and `inUse` what the opening's
 * interviews and scorecards point at; together they refuse removing (or retyping) something in use.
 */
export function checkKit(input: unknown, previous: OpeningKit = EMPTY_KIT, inUse: KitInUse = NOTHING_IN_USE): Checked<OpeningKit> {
  const p = new Problems();
  if (!isRecord(input)) return { ok: false, problems: [{ path: 'kit', message: 'The kit could not be read. Reload the page and try again.' }] };

  // rounds
  const roundsIn = listOf(input['rounds']);
  if (roundsIn.length === 0) p.add('rounds', 'Add at least one round.');
  if (roundsIn.length > KIT_LIMITS.rounds) p.add('rounds', `A kit holds at most ${KIT_LIMITS.rounds} rounds.`);
  const rounds: KitRound[] = roundsIn.map((raw, i) => {
    const r = isRecord(raw) ? raw : {};
    const at = `rounds.${i}`;
    const n = i + 1;
    const id = text(r['id']);
    if (!ID.test(id)) p.add(`${at}.id`, `Round ${n} could not be saved as it is; remove it and add it again.`);
    const name = p.str(`${at}.name`, r['name'], KIT_LIMITS.name, `Round ${n} needs a name.`, `Round ${n}'s name is longer than ${KIT_LIMITS.name} characters.`);
    const type = r['type'] as RoundType;
    if (!ROUND_TYPES.includes(type)) p.add(`${at}.type`, `Round ${n} must be technical or behavioural.`);
    const minutes = r['minutes'];
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < KIT_LIMITS.minutesMin || minutes > KIT_LIMITS.minutesMax) {
      p.add(`${at}.minutes`, `Round ${n} must last between ${KIT_LIMITS.minutesMin} and ${KIT_LIMITS.minutesMax} whole minutes.`);
    }
    return { id, name, type, minutes: Number(minutes) };
  });
  duplicates(p, 'rounds', rounds, 'Round', 'rounds');

  // competencies
  const compsIn = listOf(input['competencies']);
  if (compsIn.length === 0) p.add('competencies', 'Add at least one competency.');
  if (compsIn.length > KIT_LIMITS.competencies) p.add('competencies', `A kit holds at most ${KIT_LIMITS.competencies} competencies.`);
  const competencies: KitCompetency[] = compsIn.map((raw, i) => {
    const c = isRecord(raw) ? raw : {};
    const at = `competencies.${i}`;
    const n = i + 1;
    const id = text(c['id']);
    if (!ID.test(id)) p.add(`${at}.id`, `Competency ${n} could not be saved as it is; remove it and add it again.`);
    const name = p.str(`${at}.name`, c['name'], KIT_LIMITS.name, `Competency ${n} needs a name.`, `Competency ${n}'s name is longer than ${KIT_LIMITS.name} characters.`);
    const lookFor = p.str(`${at}.lookFor`, c['lookFor'], KIT_LIMITS.lookFor,
      `Competency ${n} needs a line on what good looks like.`, `What good looks like for competency ${n} is longer than ${KIT_LIMITS.lookFor} characters.`);
    const a = isRecord(c['anchors']) ? c['anchors'] : {};
    const anchor = (k: 1 | 2 | 3 | 4) => p.str(`${at}.anchors.${k}`, a[String(k)], KIT_LIMITS.anchor,
      `Competency ${n} needs a meaning for a rating of ${k}.`, `The meaning of a ${k} for competency ${n} is longer than ${KIT_LIMITS.anchor} characters.`);
    return { id, name, lookFor, anchors: { 1: anchor(1), 2: anchor(2), 3: anchor(3), 4: anchor(4) } };
  });
  duplicates(p, 'competencies', competencies, 'Competency', 'competencies');

  // questions
  const questionsIn = listOf(input['questions']);
  if (questionsIn.length > KIT_LIMITS.questions) p.add('questions', `A kit holds at most ${KIT_LIMITS.questions} questions.`);
  const competencyIds = new Set(competencies.map((c) => c.id));
  const roundTypes = new Set(rounds.map((r) => r.type));
  const questions: KitQuestion[] = questionsIn.map((raw, i) => {
    const q = isRecord(raw) ? raw : {};
    const at = `questions.${i}`;
    const n = i + 1;
    const id = text(q['id']);
    if (!ID.test(id)) p.add(`${at}.id`, `Question ${n} could not be saved as it is; remove it and add it again.`);
    const prompt = p.str(`${at}.prompt`, q['prompt'], KIT_LIMITS.prompt,
      `Question ${n} needs the words the interviewer will ask.`, `Question ${n} is longer than ${plain(KIT_LIMITS.prompt)} characters.`);
    const competencyId = text(q['competencyId']);
    if (!competencyIds.has(competencyId)) p.add(`${at}.competencyId`, `Question ${n} needs a competency from this kit to gather evidence for.`);
    const roundType = q['roundType'] as RoundType;
    if (!ROUND_TYPES.includes(roundType)) p.add(`${at}.roundType`, `Question ${n} must be for a technical or a behavioural round.`);
    else if (!roundTypes.has(roundType) && rounds.length > 0) {
      p.add(`${at}.roundType`, `Question ${n} is for a ${roundType} round, and the kit has none; add one or change the question.`);
    }
    const followIn = listOf(q['followUps']);
    if (followIn.length > KIT_LIMITS.followUps) p.add(`${at}.followUps`, `Question ${n} has more than ${KIT_LIMITS.followUps} follow-ups.`);
    const followUps = followIn.map((f, j) => p.str(`${at}.followUps.${j}`, f, KIT_LIMITS.followUp,
      `Follow-up ${j + 1} on question ${n} is empty; write it or remove it.`, `Follow-up ${j + 1} on question ${n} is longer than ${KIT_LIMITS.followUp} characters.`));
    const out: KitQuestion = { id, prompt, followUps, competencyId, roundType };
    const starterIn = q['starter'];
    if (starterIn !== undefined && starterIn !== null) {
      const entries = isRecord(starterIn) ? Object.entries(starterIn) : [];
      if (!isRecord(starterIn)) p.add(`${at}.starter`, `Question ${n}'s starter code could not be read; remove it and add it again.`);
      else if (entries.length > 0 && roundType === 'behavioural') {
        p.add(`${at}.starter`, `Question ${n} is for a behavioural round, which has no code pad, so it cannot carry starter code.`);
      } else if (entries.length > 0) {
        const starter: Partial<Record<PadLanguage, string>> = {};
        for (const [lang, code] of entries) {
          if (!PAD_LANGUAGES.includes(lang as PadLanguage)) { p.add(`${at}.starter`, `Question ${n} has starter code in a language the pad does not offer.`); continue; }
          const label = PAD_LANGUAGE_LABELS[lang as PadLanguage];
          // Starter code keeps its indentation: only trailing blank lines are dropped.
          const body = typeof code === 'string' ? code.replace(/\s+$/, '') : '';
          if (!body) p.add(`${at}.starter.${lang}`, `Question ${n}'s ${label} starter code is empty; write some or remove it.`);
          else if (body.length > KIT_LIMITS.starter) p.add(`${at}.starter.${lang}`, `Question ${n}'s ${label} starter code is longer than ${plain(KIT_LIMITS.starter)} characters.`);
          starter[lang as PadLanguage] = `${body}\n`;
        }
        out.starter = starter;
      }
    }
    return out;
  });
  duplicates(p, 'questions', questions, 'Question', 'questions');

  // what the opening's interviews and scorecards point at stays
  const kept = { rounds: new Map(rounds.map((r) => [r.id, r])), competencies: new Set(competencyIds), questions: new Map(questions.map((q) => [q.id, q])) };
  for (const r of previous.rounds) {
    if (!inUse.roundIds.has(r.id)) continue;
    const now = kept.rounds.get(r.id);
    if (!now) p.add('rounds', `The ${quoted(r.name, 'removed')} round has interviews on it, so it stays in the kit.`);
    else if (now.type !== r.type) p.add(`rounds.${rounds.indexOf(now)}.type`, `The ${quoted(r.name, 'this')} round has interviews on it, so it stays ${r.type}.`);
  }
  for (const c of previous.competencies) {
    if (inUse.competencyIds.has(c.id) && !kept.competencies.has(c.id)) {
      p.add('competencies', `${quoted(c.name, 'A removed competency')} is rated on a scorecard, so it stays in the kit.`);
    }
  }
  for (const q of previous.questions) {
    if (!inUse.questionIds.has(q.id)) continue;
    const now = kept.questions.get(q.id);
    const short = q.prompt.length > 48 ? `${q.prompt.slice(0, 48).replace(/\s+\S*$/, '')}…` : q.prompt;
    if (!now) p.add('questions', `"${short}" was chosen for an interview, so it stays in the kit.`);
    else if (now.roundType !== q.roundType) p.add(`questions.${questions.indexOf(now)}.roundType`, `Question ${questions.indexOf(now) + 1} was chosen for an interview, so it stays a ${q.roundType} question.`);
  }

  if (p.list.length) return { ok: false, problems: p.list };
  return { ok: true, value: { rounds, competencies, questions } };
}

/** Two items with one id, or two rounds or competencies with one name. */
function duplicates(p: Problems, list: string, items: Array<{ id: string; name?: string }>, noun: string, plural: string): void {
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  items.forEach((item, i) => {
    if (item.id && ids.has(item.id)) p.add(`${list}.${i}.id`, `${noun} ${i + 1} repeats ${noun.toLowerCase()} ${ids.get(item.id)! + 1}; remove one of them.`);
    else if (item.id) ids.set(item.id, i);
    const name = item.name?.toLowerCase();
    if (name && names.has(name)) p.add(`${list}.${i}.name`, `Two ${plural} are called "${item.name}"; rename one.`);
    else if (name) names.set(name, i);
  });
}

// ── an opening's details ─────────────────────────────────────────────────────

/** Check the details an opening is created or edited with. `hiringManagers` are the users who may be named. */
export function checkOpeningDetails(input: unknown, hiringManagers: ReadonlySet<string>): Checked<OpeningDetails> {
  const p = new Problems();
  if (!isRecord(input)) return { ok: false, problems: [{ path: 'details', message: 'The details could not be read. Reload the page and try again.' }] };
  const L = DETAIL_LIMITS;
  const title = p.str('title', input['title'], L.title, 'Give the opening a title.', `The title is longer than ${L.title} characters.`);
  const level = p.str('level', input['level'], L.level, 'Say the level, for example Senior.', `The level is longer than ${L.level} characters.`);
  const team = p.str('team', input['team'], L.team, 'Name the team the opening is for.', `The team is longer than ${L.team} characters.`);
  const location = p.str('location', input['location'], L.location, 'Say where the person will work.', `The location is longer than ${L.location} characters.`);
  const hm = input['hiringManagerId'];
  const hiringManagerId = hm === null || hm === undefined || hm === '' ? null : text(hm);
  if (hiringManagerId !== null && !hiringManagers.has(hiringManagerId)) p.add('hiringManagerId', 'Choose a hiring manager from the list, or leave it unnamed for now.');
  const state = (input['state'] ?? 'open') as OpeningState;
  if (!OPENING_STATES.includes(state)) p.add('state', 'The opening must be open, paused or closed.');
  const cap = input['budgetCapUsd'];
  const budgetCapUsd = cap === null || cap === undefined || cap === '' ? null : Number(cap);
  if (budgetCapUsd !== null && (!Number.isFinite(budgetCapUsd) || budgetCapUsd < 0 || budgetCapUsd > L.budgetCapUsd)) {
    p.add('budgetCapUsd', `The cap per interview must be between $0 and $${plain(L.budgetCapUsd)}.`);
  }
  if (p.list.length) return { ok: false, problems: p.list };
  return { ok: true, value: { title, level, team, location, hiringManagerId, state, budgetCapUsd: budgetCapUsd === null ? null : Math.round(budgetCapUsd * 100) / 100 } };
}

/** A new opening's id from its title: `op-<words>`, with a number added while it is taken. */
export function openingIdFor(title: string, taken: ReadonlySet<string>): string {
  const base = `op-${title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'opening'}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
