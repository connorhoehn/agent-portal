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
