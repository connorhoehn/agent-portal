// Every Milo text the mock world shows (E4 lane D): the seeded recaps, suggestions and private answers, and what the
// scripted stand-ins write from the seeded kits and transcripts (recap, coach, ask, plan), run through decision 6's
// judgement detector (lib/interviews/judgement.ts). The seeded recaps are also run through the recap guard
// (lib/interviews/recap/parse.ts): what is seeded is exactly what the guard keeps, and it agrees with the scorecards.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { judgeOutput } from '../../lib/interviews/judgement.js';
import { scriptedSuggestion } from '../../lib/interviews/coach/model.js';
import type { CoachLine } from '../../lib/interviews/coach/prompt.js';
import { scriptedAnswer } from '../../lib/interviews/milo-notes/model.js';
import { NOT_SAID } from '../../lib/interviews/milo-notes/prompt.js';
import { scriptedPlan } from '../../lib/interviews/plan/model.js';
import { scriptedRecap } from '../../lib/interviews/recap/model.js';
import { guardRecapText, parseRecapAnswer } from '../../lib/interviews/recap/parse.js';
import { roundCompetencyIds } from '../../lib/interviews/recap/service.js';
import type { Interview, Opening } from '../../lib/interviews/types.js';
import { interviewCoachLogFixture } from '../interviews-coach-log.js';
import { interviewRecapsFixture } from '../interviews-recaps.js';
import { interviewRecordLinesFixture } from '../interviews-records.js';
import { interviewSuggestionsFixture } from '../interviews-suggestions.js';
import { interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture, interviewApplicationsFixture } from '../interviews.js';

const interviews = () => interviewsFixture.rows('default');
const interviewOf = (id: string): Interview => interviews().find((i) => i.id === id)!;
const openingOf = (iv: Interview): Opening => {
  const app = interviewApplicationsFixture.rows('default').find((a) => a.id === iv.applicationId)!;
  return interviewOpeningsFixture.rows('default').find((o) => o.id === app.openingId)!;
};
const linesOf = (id: string): CoachLine[] => interviewRecordLinesFixture.rows('default').filter((l) => l.interviewId === id)
  .map((l) => ({ seq: l.seq, side: l.userId?.startsWith('guest:') ? 'candidate' as const : 'panel' as const, text: l.text }));
const recorded = () => [...new Set(interviewRecordLinesFixture.rows('default').map((l) => l.interviewId))];
const fair = (text: string) => expect({ text, code: judgeOutput(text) }).toEqual({ text, code: null });

describe('the seeded recaps', () => {
  const recaps = () => interviewRecapsFixture.rows('default');

  it('every scored round has one', () => {
    const scored = interviews().filter((i) => i.state === 'scored').map((i) => i.id).sort();
    expect(recaps().map((r) => r.interviewId).sort()).toEqual(scored);
  });

  it.each(['iv-d7q4n9xe', 'iv-f2b6t5zh', 'iv-j6x2d9sb', 'iv-p2v7j4ye'])('%s is exactly what the guard keeps, and covers the round', (id) => {
    const row = recaps().find((r) => r.interviewId === id)!;
    const iv = interviewOf(id);
    const competencyIds = roundCompetencyIds(iv, openingOf(iv));
    const parsed = parseRecapAnswer(JSON.stringify(row.content), { competencyIds, lines: linesOf(id) });
    expect(parsed).toEqual({ ok: true, recap: row.content, droppedClaims: 0 });
    // Every competency of the round has two to four statements, and the scorecard rated each of them.
    expect(row.content.competencies.map((c) => c.id)).toEqual(competencyIds);
    for (const c of row.content.competencies) expect(c.evidence.length).toBeGreaterThanOrEqual(2);
    const card = interviewScorecardsFixture.rows('default').find((s) => s.interviewId === id)!;
    expect(card.ratings.map((r) => r.competencyId).sort()).toEqual([...competencyIds].sort());
  });

  it('each statement is said once: never the quote again, never a judgement', () => {
    for (const row of recaps()) for (const c of row.content.competencies) for (const e of c.evidence) {
      expect(e.text.includes(e.quote)).toBe(false);
      expect(e.text.includes('“')).toBe(false);
      fair(e.text);
      expect(guardRecapText(e.text)).toBeNull();
    }
  });
});

describe('the seeded suggestions and private answers', () => {
  it('quote the round\'s own transcript, and judge nobody', () => {
    for (const s of interviewSuggestionsFixture.rows('default')) {
      if (s.dropped) continue;
      fair(s.text);
      if (s.basedOn) expect(linesOf(s.interviewId).some((l) => l.side === 'candidate' && l.seq <= s.throughSeq && l.text.includes(s.basedOn!))).toBe(true);
    }
    for (const a of interviewCoachLogFixture.rows('default')) {
      if (a.answer) fair(a.answer);
      for (const src of a.sources) if ('seq' in src) expect(linesOf(a.interviewId).find((l) => l.seq === src.seq)?.text.includes(src.quote)).toBe(true);
      else fair(src.why);
    }
  });
});

describe('the scripted stand-ins over the seeded kits and transcripts', () => {
  it('the kits\' questions and follow-ups (Milo may ask them aloud) judge nobody', () => {
    for (const o of interviewOpeningsFixture.rows('default')) for (const q of o.kit.questions) [q.prompt, ...q.followUps].forEach(fair);
  });

  it.each(recorded())('%s: the scripted recap, every suggestion through the round and the asks judge nobody', (id) => {
    const iv = interviewOf(id);
    const opening = openingOf(iv);
    const lines = linesOf(id);
    const competencies = opening.kit.competencies.filter((c) => roundCompetencyIds(iv, opening).includes(c.id));
    const questions = opening.kit.questions.filter((q) => q.roundType === iv.type);
    const chosen = questions.filter((q) => iv.questionIds.includes(q.id)).map((q) => ({ text: q.prompt, competencyId: q.competencyId, how: 'chosen' as const }));
    const recap = scriptedRecap({ competencies, questions: chosen, lines });
    for (const c of recap.competencies) for (const e of c.evidence) fair(e.text);
    const parsed = parseRecapAnswer(JSON.stringify(recap), { competencyIds: competencies.map((c) => c.id), lines });
    expect(parsed.ok).toBe(true);

    const previous: { text: string; competencyId: string; answer: 'ask' }[] = [];
    for (let n = 1; n <= lines.length; n += 1) {
      const s = scriptedSuggestion({ roundType: iv.type, competencies, questions, chosenQuestionIds: iv.questionIds, lines: lines.slice(0, n), previous });
      if (!s) continue;
      fair(s.text);
      // A suggestion stays inside the round: a question or follow-up of the round's own competencies.
      expect(competencies.map((c) => c.id)).toContain(s.competencyId);
      if (n % 5 === 0) previous.push({ text: s.text, competencyId: s.competencyId, answer: 'ask' });
    }
    for (const q of ['What did they say about the key?', 'Where did they talk about the window reset?', 'What about the on-call lead?', 'What did they say about failover?']) {
      const a = scriptedAnswer({ lines, question: q });
      fair(a.answer);
      if (a.answer !== NOT_SAID) expect(a.sources.length).toBeGreaterThan(0);
    }
  });

  it('every plan reason, for every kit and round type, judges nobody and differs from question to question', () => {
    for (const o of interviewOpeningsFixture.rows('default')) for (const type of ['technical', 'behavioural'] as const) {
      const plan = scriptedPlan({ roundType: type, minutes: 60, competencies: o.kit.competencies, questions: o.kit.questions.filter((q) => q.roundType === type) });
      plan.questions.forEach((p) => fair(p.why));
      expect(new Set(plan.questions.map((p) => p.why)).size).toBe(plan.questions.length);
    }
  });
});
