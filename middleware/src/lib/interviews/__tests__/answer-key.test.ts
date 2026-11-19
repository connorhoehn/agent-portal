// The answer key never rides on the candidate's side (lib/interviews/answer-key.ts).
import { ANSWER_KEY_FIELDS, candidateQuestion, hasAnswerKey } from '../answer-key.js';
import { blueprintBoard } from '../board/templates.js';
import type { KitQuestion } from '../types.js';

const full: KitQuestion = {
  id: 'q', prompt: 'Design X', followUps: ['a'], competencyId: 'c', roundType: 'technical', board: blueprintBoard(), clarifying: ['b'],
  providedDesign: { name: 'Provided design', elements: [{ id: 'k', type: 'text', text: 'SECRET' }] },
  designQuestions: [{ text: 'Why?', answer: 'SECRET answer' }], redFlags: [{ group: 'naming', text: 'SECRET flag' }],
};

describe('candidateQuestion', () => {
  it('drops the three answer-key fields and keeps the rest, copied', () => {
    const c = candidateQuestion(full);
    for (const k of ANSWER_KEY_FIELDS) expect(k in c).toBe(false);
    expect(JSON.stringify(c)).not.toContain('SECRET');
    expect(c).toEqual({ id: 'q', prompt: 'Design X', followUps: ['a'], competencyId: 'c', roundType: 'technical', board: blueprintBoard(), clarifying: ['b'] });
    expect(c.board).not.toBe(full.board);
    expect(hasAnswerKey(full)).toBe(true);
    expect(hasAnswerKey(c as KitQuestion)).toBe(false);
  });

  it('fails closed: a field it does not name is not copied', () => {
    const later = { ...full, interviewerNotes: 'SECRET later field' } as KitQuestion;
    expect(JSON.stringify(candidateQuestion(later))).not.toContain('SECRET');
  });
});

import { revealable } from '../answer-key.js';
import { roomView } from '../room.js';
import { interviewOpeningsFixture } from '../../../mock/interviews.js';
import type { Interview } from '../types.js';

describe('who reads the seeded "Design Twitter" answer key', () => {
  const opening = structuredClone(interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!);
  const live = { id: 'iv-x', leadId: 'u-hugo', panelIds: ['u-wen'], state: 'live', type: 'technical', roundId: 'rd-design', questionIds: ['q-be-twitter'], minutes: 60,
    scheduledAt: null, endedAt: null, revision: 1, applicationId: 'app-x' } as unknown as Interview;
  const person = (id: string) => ({ id, name: id });

  it('the room gives the lead and the panel the answer key, and nobody without a seat a room at all', () => {
    for (const seat of ['u-hugo', 'u-wen']) {
      const q = roomView(live, opening, 'Mateo', seat, person)!.questions[0]!;
      expect(q.answerKey!.redFlags!.length).toBeGreaterThan(0);
      expect(q.answerKey!.providedDesign!.name).toBe('Provided design');
      expect(JSON.stringify(q.board)).not.toContain('pd-node-');
    }
    expect(roomView(live, opening, 'Mateo', 'u-greta', person)).toBeNull();
  });

  it('only the lead of the live round reveals it, for a chosen question that has one', () => {
    expect(revealable(live, opening, 'u-hugo', 'q-be-twitter')!.name).toBe('Provided design');
    expect(revealable(live, opening, 'u-wen', 'q-be-twitter')).toBeNull();
    expect(revealable({ ...live, state: 'ended' }, opening, 'u-hugo', 'q-be-twitter')).toBeNull();
    expect(revealable({ ...live, questionIds: ['q-be-ledger'] }, opening, 'u-hugo', 'q-be-twitter')).toBeNull();
    expect(revealable({ ...live, questionIds: ['q-be-ledger'] }, opening, 'u-hugo', 'q-be-ledger')).toBeNull();
    expect(revealable(live, opening, 'u-hugo', 42)).toBeNull();
    expect(revealable(live, null, 'u-hugo', 'q-be-twitter')).toBeNull();
  });
});
