// The question plan's pure parts (row I3.10): the request pinned as text, the strict parse, the scripted stand-in.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { Fence } from '../../../untrusted-text.js';
import { scriptedPlan } from '../model.js';
import { parsePlan } from '../parse.js';
import { buildPlanRequest, PLAN_PROMPT_VERSION, planCap, type PlanInput } from '../prompt.js';

const KIT: PlanInput = {
  roundType: 'behavioural',
  minutes: 30,
  competencies: [
    { id: 'c1', name: 'Leadership', lookFor: 'Owns outcomes.' },
    { id: 'c2', name: 'Delivery', lookFor: 'Ships.' },
  ],
  questions: [
    { id: 'q1', prompt: 'Tell me about a struggling teammate.', competencyId: 'c1' },
    { id: 'q2', prompt: 'Tell me about a missed deadline.', competencyId: 'c2' },
    { id: 'q3', prompt: 'Tell me about hiring.', competencyId: 'c1' },
    { id: 'q4', prompt: 'Tell me about a launch.', competencyId: 'c2' },
  ],
};
const BANK = new Set(KIT.questions.map((q) => q.id));
const raw = (qs: unknown) => JSON.stringify({ questions: qs });

describe('the request', () => {
  it('is pinned as text', () => {
    const req = buildPlanRequest('model-x', KIT, new Fence({ token: 'tok' }));
    expect(PLAN_PROMPT_VERSION).toBe('milo-plan-2026-11-17.1');
    expect(req.inferenceConfig).toEqual({ maxTokens: 700, temperature: 0 });
    expect(req.messages[0]!.content[0]!.text).toBe([
      'Round type: behavioural',
      'Round length: 30 minutes',
      'Choose at most 3 questions.',
      '',
      'Competencies, in the kit\'s order:',
      '- c1: <untrusted-tok kind="competency">Leadership</untrusted-tok>. Look for: <untrusted-tok kind="look-for">Owns outcomes.</untrusted-tok>',
      '- c2: <untrusted-tok kind="competency">Delivery</untrusted-tok>. Look for: <untrusted-tok kind="look-for">Ships.</untrusted-tok>',
      '',
      'The question bank for this round type:',
      '- q1 (c1): <untrusted-tok kind="question">Tell me about a struggling teammate.</untrusted-tok>',
      '- q2 (c2): <untrusted-tok kind="question">Tell me about a missed deadline.</untrusted-tok>',
      '- q3 (c1): <untrusted-tok kind="question">Tell me about hiring.</untrusted-tok>',
      '- q4 (c2): <untrusted-tok kind="question">Tell me about a launch.</untrusted-tok>',
      '',
      'Answer with the JSON object only.',
    ].join('\n'));
    expect(req.system[0]!.text).toContain('You know nothing about any candidate and you never mention one.');
    expect(req.system[0]!.text).toContain('{"questions": [{"questionId": string, "why": string}]}');
  });
});

describe('planCap', () => {
  it('is one a ten minutes, between one and eight', () => {
    expect([planCap(5), planCap(30), planCap(60), planCap(180), planCap(NaN)]).toEqual([1, 3, 6, 8, 1]);
  });
});

describe('the parse', () => {
  it('keeps a clean answer in order', () => {
    const r = parsePlan(raw([{ questionId: 'q2', why: 'Serves Delivery.' }, { questionId: 'q1', why: 'Serves Leadership.' }]), BANK, 3);
    expect(r).toEqual({ ok: true, plan: [{ questionId: 'q2', why: 'Serves Delivery.' }, { questionId: 'q1', why: 'Serves Leadership.' }], drops: { offBank: 0, duplicate: 0, why: 0, overCap: 0 } });
  });
  it('drops an id that is not in the bank, and a repeat', () => {
    const r = parsePlan(raw([{ questionId: 'zz', why: 'Serves Delivery.' }, { questionId: 'q1', why: 'Serves Leadership.' }, { questionId: 'q1', why: 'Again.' }]), BANK, 3);
    expect(r).toEqual({ ok: true, plan: [{ questionId: 'q1', why: 'Serves Leadership.' }], drops: { offBank: 1, duplicate: 1, why: 0, overCap: 0 } });
  });
  it('drops a question whose reason judges, is empty or is too long', () => {
    const r = parsePlan(raw([
      { questionId: 'q1', why: 'This will show a strong candidate.' }, { questionId: 'q2', why: '  ' }, { questionId: 'q3', why: 'x'.repeat(201) }, { questionId: 'q4', why: 'Serves Delivery.' },
    ]), BANK, 3);
    expect(r).toMatchObject({ ok: true, plan: [{ questionId: 'q4', why: 'Serves Delivery.' }], drops: { why: 3 } });
  });
  it('keeps only the cap', () => {
    const r = parsePlan(raw(['q1', 'q2', 'q3'].map((questionId) => ({ questionId, why: 'Serves it.' }))), BANK, 2);
    expect(r).toMatchObject({ ok: true, drops: { overCap: 1 } });
    expect((r as { plan: unknown[] }).plan).toHaveLength(2);
  });
  it('is no plan when nothing is left, and malformed when the shape is wrong', () => {
    expect(parsePlan(raw([{ questionId: 'zz', why: 'ok' }]), BANK, 3)).toMatchObject({ ok: true, plan: null });
    expect(parsePlan(raw([]), BANK, 3)).toMatchObject({ ok: true, plan: null });
    expect(parsePlan('nope', BANK, 3)).toEqual({ ok: false, code: 'malformed' });
    expect(parsePlan(null, BANK, 3)).toEqual({ ok: false, code: 'malformed' });
    expect(parsePlan(JSON.stringify({ questions: [], extra: 1 }), BANK, 3)).toEqual({ ok: false, code: 'malformed' });
    expect(parsePlan(raw([{ questionId: 'q1' }]), BANK, 3)).toEqual({ ok: false, code: 'malformed' });
  });
});

describe('the scripted stand-in', () => {
  it('takes the first question of each competency in the kit\'s order, then the next of each, until the minutes are filled', () => {
    expect(scriptedPlan({ ...KIT, minutes: 20 }).questions.map((q) => q.questionId)).toEqual(['q1', 'q2']);
    expect(scriptedPlan(KIT).questions.map((q) => q.questionId)).toEqual(['q1', 'q2', 'q3']);
    expect(scriptedPlan({ ...KIT, minutes: 90 }).questions.map((q) => q.questionId)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });
  it('names the competency in every reason, and passes the parse with the guard', () => {
    const plan = scriptedPlan(KIT);
    expect(plan.questions[0]!.why).toBe('It gathers evidence for Leadership.');
    expect(parsePlan(JSON.stringify(plan), BANK, 3)).toMatchObject({ ok: true, drops: { why: 0 } });
  });
  it('skips a competency with no question and is empty for an empty bank', () => {
    expect(scriptedPlan({ ...KIT, questions: KIT.questions.filter((q) => q.competencyId === 'c2') }).questions.map((q) => q.questionId)).toEqual(['q2', 'q4']);
    expect(scriptedPlan({ ...KIT, questions: [] }).questions).toEqual([]);
  });
});
