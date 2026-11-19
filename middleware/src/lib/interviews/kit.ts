// An opening's kit and details, checked before anything is written (docs/interviews-tenant-plan.md,
// rows I1.3 and I1.8; decisions 6, 8, 11, 14 and 20).
//
// Pure functions over plain input, so the route, a later importer and the tests all hold a kit to the
// same rules. Each check answers either the cleaned value (strings trimmed, unknown fields dropped) or
// a list of problems, one plain sentence per field, keyed by a path the editor maps to its field:
//
//   rounds | competencies | questions               the list itself (too few, too many, a removal)
//   rounds.<i>.<field>                              name, type, minutes, surface, competencyIds
//   competencies.<i>.<field>                        name, lookFor, anchors.<1-4>
//   questions.<i>.<field>                           prompt, competencyId, roundType, followUps.<j>, starter.<language>, board, clarifying.<j>
//   <field>                                         an opening's details: title, level, team, location, ...
//
// <i> is the item's position in the list as sent, so the editor needs no ids to place a message.
//
// What the kit promises the rows that read it unchanged:
//   - Each round names the competencies it assesses (`competencyIds`, at least one, each in the kit). Every screen
//     that lists a round's competencies (the room, the scorecard, Prepare, the recap, the debrief, the coach, the
//     export) reads them through `competenciesOfRound`, so a coding round never shows or asks about System design.
//     A round saved before rounds named theirs has no list and assesses every competency, as it did then.
//   - I3.3 (the coach) reads competencies with what good looks like, and questions with their follow-ups.
//   - I4.2 (the pad) inserts a technical question's starter code in the pad's language; a behavioural
//     round has no pad (roundHasPad), so a behavioural question never carries code.
//   - I5.3 (the scorecard) rates each competency against its four anchors by competency id.
// Ids are stable across edits and an item an interview or a scorecard points at cannot be removed (or a
// round's or chosen question's type changed), so those rows never meet a dangling id.

import {
  OPENING_STATES, PAD_LANGUAGES, ROUND_SURFACES, ROUND_TYPES,
  type InterviewsWorld, type KitBoard, type KitCompetency, type KitQuestion, type KitRound, type OpeningDetails, type OpeningKit, type OpeningState,
  type PadLanguage, type RoundSurface, type RoundType,
} from './types.js';
import { boardElement } from './board/elements.js';

export const KIT_LIMITS = {
  rounds: 6,
  competencies: 12,
  questions: 60,
  followUps: 5,
  /** A system design question's expected clarifying questions. */
  clarifying: 5,
  name: 60,
  lookFor: 400,
  anchor: 200,
  prompt: 1000,
  followUp: 300,
  starter: 8000,
  boardName: 40,
  /** A starting board's elements: a blueprint of frames and stickies is well under a hundred. */
  boardElements: 400,
  /** A starting board as JSON, in bytes. */
  boardBytes: 256 * 1024,
  minutesMin: 15,
  minutesMax: 180,
} as const;

/** `budgetCapUsd` is the opening's cap across all its interviews; `interviewCapUsd` the cap per interview (row I0.6). */
export const DETAIL_LIMITS = { title: 120, level: 40, team: 60, location: 80, budgetCapUsd: 5000, interviewCapUsd: 200 } as const;

export const PAD_LANGUAGE_LABELS: Readonly<Record<PadLanguage, string>> = {
  python: 'Python', swift: 'Swift', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', go: 'Go', cpp: 'C++',
};

/** Only a technical round has the code pad (decision 11); a behavioural round never does (row I1.8). */
export function roundHasPad(type: RoundType): boolean {
  return type === 'technical';
}

/**
 * What a round works on: a technical round's saved surface, 'pad' when it has none (a kit saved before the board);
 * null for a behavioural round, which has neither (decision 11).
 */
export function roundSurface(round: Pick<KitRound, 'type' | 'surface'> | null | undefined): RoundSurface | null {
  if (!round || round.type !== 'technical') return null;
  return round.surface === 'board' ? 'board' : 'pad';
}

/**
 * A starting board as the editor sent it: a short name and a list of Excalidraw elements, each a plain object with
 * a string `id` and a type a board keeps (board/elements.ts: no embedded page, iframe or image, `kind` otherwise); links
 * are taken off. The shape and the size are checked.
 */
export function checkBoard(raw: unknown): { ok: true; board: KitBoard } | { ok: false; why: 'unreadable' | 'name' | 'empty' | 'large' | 'kind' } {
  if (!isRecord(raw)) return { ok: false, why: 'unreadable' };
  const name = text(raw['name']);
  if (!name || name.length > KIT_LIMITS.boardName) return { ok: false, why: 'name' };
  const list = raw['elements'];
  if (!Array.isArray(list)) return { ok: false, why: 'unreadable' };
  if (!list.some((e) => isRecord(e) && e['isDeleted'] !== true)) return { ok: false, why: 'empty' };
  if (list.length > KIT_LIMITS.boardElements) return { ok: false, why: 'large' };
  const ids = new Set<string>();
  const kept: Array<Record<string, unknown>> = [];
  for (const e of list) {
    const el = boardElement(e);
    if (el === null) return { ok: false, why: 'unreadable' };
    if (el === 'kind') return { ok: false, why: 'kind' };
    const id = el['id'] as string;
    if (ids.has(id)) return { ok: false, why: 'unreadable' };
    ids.add(id);
    kept.push(el);
  }
  const elements = kept.filter((e) => e['isDeleted'] !== true);
  if (Buffer.byteLength(JSON.stringify(elements), 'utf8') > KIT_LIMITS.boardBytes) return { ok: false, why: 'large' };
  return { ok: true, board: { name, elements } };
}

export const EMPTY_KIT: OpeningKit = { rounds: [], competencies: [], questions: [] };

/**
 * The competencies round `roundId` assesses, in the kit's order: the ones the round names. A round that names none
 * (saved before rounds named theirs) or an id the kit no longer has reads every competency of the kit, as before.
 * The one place a round's competencies are worked out; no screen filters the kit's list itself.
 */
export function competenciesOfRound(kit: Pick<OpeningKit, 'rounds' | 'competencies'>, roundId: string): KitCompetency[] {
  const named = kit.rounds.find((r) => r.id === roundId)?.competencyIds;
  if (!named?.length) return kit.competencies;
  const want = new Set(named);
  const of = kit.competencies.filter((c) => want.has(c.id));
  return of.length ? of : kit.competencies;
}

/** The ids of `competenciesOfRound`, for the rules that compare ids. */
export const competencyIdsOfRound = (kit: Pick<OpeningKit, 'rounds' | 'competencies'>, roundId: string): string[] =>
  competenciesOfRound(kit, roundId).map((c) => c.id);

/** The bank's questions a round may ask: of its type, for a competency it assesses (competenciesOfRound), in the bank's order. */
export function questionsOfRound(kit: OpeningKit, roundId: string, type: RoundType): KitQuestion[] {
  const assessed = new Set(competencyIdsOfRound(kit, roundId));
  return kit.questions.filter((q) => q.roundType === type && assessed.has(q.competencyId));
}

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
  // Each round's competency ids, checked once the competencies are read below. A round sent without a list keeps the one
  // the saved kit holds for the same round id (checked again like a sent one); with none saved it stays without one.
  const roundCompetencies: Array<unknown> = [];
  const savedLists = new Map(previous.rounds.map((r) => [r.id, r.competencyIds]));
  const rounds: KitRound[] = roundsIn.map((raw, i) => {
    const r = isRecord(raw) ? raw : {};
    const sent = r['competencyIds'];
    roundCompetencies.push(sent === undefined || sent === null ? savedLists.get(text(r['id'])) : sent);
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
    const out: KitRound = { id, name, type, minutes: Number(minutes) };
    // A technical round's surface: the pad unless it says board; an old kit sends none. A behavioural round has neither.
    const surface = r['surface'];
    if (surface !== undefined && surface !== null && !ROUND_SURFACES.includes(surface as RoundSurface)) {
      p.add(`${at}.surface`, `Round ${n} must use the code pad or the whiteboard.`);
    } else if (surface === 'board' && type === 'behavioural') {
      p.add(`${at}.surface`, `Round ${n} is behavioural, which has no whiteboard; make it technical or use no board.`);
    }
    if (type === 'technical') out.surface = surface === 'board' ? 'board' : 'pad';
    return out;
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

  // what each round assesses: at least one competency, each from this kit, kept in the kit's order
  const known = new Set(competencies.map((c) => c.id));
  rounds.forEach((round, i) => {
    const raw = roundCompetencies[i];
    if (raw === undefined || raw === null) return;
    const at = `rounds.${i}.competencyIds`;
    const n = i + 1;
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) { p.add(at, `Round ${n}'s competencies could not be read; choose them again.`); return; }
    const ids = new Set((raw as string[]).map((id) => id.trim()));
    if (ids.size === 0) { p.add(at, `Round ${n} needs at least one competency to assess.`); return; }
    if ([...ids].some((id) => !known.has(id))) { p.add(at, `Round ${n} assesses a competency that is not in this kit; choose its competencies again.`); return; }
    round.competencyIds = competencies.map((c) => c.id).filter((id) => ids.has(id));
  });

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
    const clarifyIn = listOf(q['clarifying']);
    if (clarifyIn.length > 0 && roundType === 'behavioural') {
      p.add(`${at}.clarifying`, `Question ${n} is for a behavioural round; clarifying questions belong to a system design question.`);
    } else if (clarifyIn.length > KIT_LIMITS.clarifying) {
      p.add(`${at}.clarifying`, `Question ${n} has more than ${KIT_LIMITS.clarifying} clarifying questions.`);
    } else if (clarifyIn.length > 0) {
      out.clarifying = clarifyIn.map((c, j) => p.str(`${at}.clarifying.${j}`, c, KIT_LIMITS.followUp,
        `Clarifying question ${j + 1} on question ${n} is empty; write it or remove it.`, `Clarifying question ${j + 1} on question ${n} is longer than ${KIT_LIMITS.followUp} characters.`));
    }
    const boardIn = q['board'];
    if (boardIn !== undefined && boardIn !== null) {
      const checked = checkBoard(boardIn);
      if (roundType === 'behavioural') p.add(`${at}.board`, `Question ${n} is for a behavioural round, which has no whiteboard, so it cannot carry a board.`);
      else if (!checked.ok) {
        p.add(`${at}.board`, {
          unreadable: `Question ${n}'s board could not be read; remove it and draw it again.`,
          name: `Question ${n}'s board needs a short name, up to ${KIT_LIMITS.boardName} characters.`,
          empty: `Question ${n}'s board is empty; draw something on it or remove it.`,
          large: `Question ${n}'s board is too big for a starting board; keep it under ${KIT_LIMITS.boardElements} shapes.`,
          kind: `Question ${n}'s board has an embedded page, an image or another shape a starting board cannot keep; remove it.`,
        }[checked.why]);
      } else out.board = checked.board;
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
  const dollarsOf = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
  const cents = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);
  const budgetCapUsd = dollarsOf(input['budgetCapUsd']);
  const budgetOk = budgetCapUsd === null || (Number.isFinite(budgetCapUsd) && budgetCapUsd >= 0 && budgetCapUsd <= L.budgetCapUsd);
  if (!budgetOk) p.add('budgetCapUsd', `The opening's spending cap must be between $0 and $${plain(L.budgetCapUsd)}.`);
  const interviewCapUsd = dollarsOf(input['interviewCapUsd']);
  if (interviewCapUsd !== null && (!Number.isFinite(interviewCapUsd) || interviewCapUsd < 0 || interviewCapUsd > L.interviewCapUsd)) {
    p.add('interviewCapUsd', `The cap per interview must be between $0 and $${plain(L.interviewCapUsd)}.`);
  } else if (interviewCapUsd !== null && budgetOk && budgetCapUsd !== null && interviewCapUsd > budgetCapUsd) {
    p.add('interviewCapUsd', "The cap per interview cannot be more than the opening's spending cap.");
  }
  if (p.list.length) return { ok: false, problems: p.list };
  return { ok: true, value: { title, level, team, location, hiringManagerId, state, budgetCapUsd: cents(budgetCapUsd), interviewCapUsd: cents(interviewCapUsd) } };
}

/** A new opening's id from its title: `op-<words>`, with a number added while it is taken. */
export function openingIdFor(title: string, taken: ReadonlySet<string>): string {
  const base = `op-${title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'opening'}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
