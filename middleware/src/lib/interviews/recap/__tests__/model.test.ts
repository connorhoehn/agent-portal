// The recap's model (lib/interviews/recap/model.ts; row I5.2, contract E0): the scripted stand-in quotes the answers to the
// asked questions and invents nothing; the Bedrock class runs only over an injected fake client; one switch picks.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { ScriptedCoachModel, BedrockCoachModel, setCoachModelFactory } from '../../coach/model.js';
import { ANSWER_TEXT, BedrockRecapModel, makeRecapModel, ScriptedRecapModel, scriptedRecap } from '../model.js';
import { parseRecapAnswer } from '../parse.js';
import { FIXED_INPUT } from './fixed-input.js';
import type { RecapInput } from '../prompt.js';

afterEach(() => setCoachModelFactory(null));

describe('the scripted recap', () => {
  it('quotes each candidate line after an asked question, under that question\'s competency, and lists the rest as not covered', () => {
    expect(scriptedRecap(FIXED_INPUT)).toEqual({
      competencies: [{ id: 'communication', evidence: [
        { text: ANSWER_TEXT, seq: 2, quote: 'The payments queue backed up, so I paged the on-call lead and we split the work.' },
        { text: ANSWER_TEXT, seq: 4, quote: 'The database owner, about ten minutes in, once we saw the lock waits.' },
      ] }],
      notCovered: ['collaboration'],
    });
  });

  it('the film\'s round: a question\'s answers run past the lead\'s conversation to the next asked question, and two questions share the competency', () => {
    // The final take (18 November): the lead reads Two Sum (8), asks the language (9), the candidate answers it, asks a clarifying
    // question, then answers the problem; later the lead asks the complexity in their own words (20, no question's opening),
    // and Milo reads the testing follow-up (a said-log row, negative number) before the candidate answers it.
    const TWO_SUM = 'Given an array of integers and a target, return the indices of the two numbers that add up to the target. Each input has exactly one answer, and the same element may not be used twice.';
    const TESTING = 'How would you test this function?';
    const input: RecapInput = {
      competencies: [{ id: 'problem-solving', name: 'Problem solving', lookFor: 'Breaks the problem down.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } }],
      questions: [
        { text: TWO_SUM, competencyId: 'problem-solving', how: 'chosen' },
        { text: 'What is the runtime complexity of your solution, in time and in space?', competencyId: 'problem-solving', how: 'ask' },
        { text: TESTING, competencyId: 'problem-solving', how: 'milo-ask' },
      ],
      lines: [
        { seq: 6, side: 'candidate', text: 'Mostly hash maps and queues in our payment services.' },
        { seq: 8, side: 'panel', text: 'Okay, a coding problem. Given an array of integers and a target, return the indices of the two numbers that add up to the target' },
        { seq: 9, side: 'panel', text: 'We usually use Java here, but pick whatever you like. What language would you like to use' },
        { seq: 10, side: 'candidate', text: 'Uh! Python, please' },
        { seq: 11, side: 'panel', text: 'Python it is! I\'m dropping the problem into the pad now' },
        { seq: 12, side: 'candidate', text: 'Quick question, can I use the same number twice? And is there always exactly one answer' },
        { seq: 13, side: 'panel', text: 'Good question! There\'s always exactly one answer, and you can\'t use the same element twice' },
        { seq: 14, side: 'candidate', text: 'Okay. So the brute force is to check every pair. That\'s O of N squared. But I think I can do better with a hash map' },
        { seq: 15, side: 'candidate', text: 'I\'ll use a dictionary to store what I\'ve seen. And for each number! I check whether its complement is already in there' },
        { seq: 16, side: 'candidate', text: 'Here, Milo! How much time is left' },
        { seq: 20, side: 'panel', text: 'Nice! What\'s the runtime complexity' },
        { seq: 21, side: 'candidate', text: 'Right! O of N time, since we only pass through the list once, and O of N space for the map' },
        { seq: -1, side: 'panel', text: TESTING },
        { seq: 23, side: 'candidate', text: 'Milo, can you repeat the question' },
        { seq: 24, side: 'candidate', text: 'Sure! I\'d test the example from the problem. A case with no valid pair. Duplicates like three and three, and negative numbers.' },
      ],
    };
    const out = scriptedRecap(input);
    expect(out.notCovered).toEqual([]);
    const seqs = out.competencies[0]!.evidence.map((e) => e.seq);
    expect(seqs.length).toBeLessThanOrEqual(4);
    // The Two Sum answer (14, 15) and the testing answer (24) are both cited; requests to Milo never are.
    expect(seqs).toEqual(expect.arrayContaining([14, 15, 24]));
    expect(seqs).not.toContain(16);
    expect(seqs).not.toContain(23);
    expect(seqs).not.toContain(6); // before any asked question
    // In timeline order (Milo's row has a negative number, so order is by position, not number).
    const at = (seq: number) => input.lines.findIndex((l) => l.seq === seq);
    expect(seqs.map(at)).toEqual([...seqs.map(at)].sort((a, b) => a - b));
  });

  it('Communication is judged across the whole conversation: a round whose only asked questions are another competency\'s still has Communication evidence', () => {
    const input: RecapInput = {
      competencies: [FIXED_INPUT.competencies[0]!, { ...FIXED_INPUT.competencies[1]!, id: 'system-design', name: 'System design' }],
      questions: [{ text: 'Design Twitter: people post short messages and read a home timeline.', competencyId: 'system-design', how: 'chosen' }],
      lines: [
        { seq: 1, side: 'panel', text: 'Design Twitter: people post short messages and read a home timeline.' },
        { seq: 2, side: 'candidate', text: 'So on every tweet I push it to each follower\'s timeline, and I will explain why as I go.' },
        { seq: 3, side: 'candidate', text: 'Milo, how much time is left' },
        { seq: 4, side: 'candidate', text: 'For big accounts I would skip the fan-out and merge their tweets in at read time instead.' },
      ],
    };
    const out = scriptedRecap(input);
    expect(out.competencies.map((c) => c.id)).toEqual(['communication', 'system-design']);
    expect(out.competencies[0]!.evidence.map((e) => e.seq)).toEqual([2, 4]);
    expect(out.notCovered).toEqual([]);
  });

  it('a board round: the interviewer names the question by its title ("design Twitter"), not word for word; Milo\'s probe stays in its window', () => {
    const input: RecapInput = {
      competencies: [
        { id: 'system-design', name: 'System design', lookFor: 'Designs for scale.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } },
        { id: 'communication', name: 'Communication', lookFor: 'Explains as they go.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } },
      ],
      questions: [{ text: 'Design Twitter: people post short messages, follow other people and read a home timeline of the posts of the people they follow.', competencyId: 'system-design', how: 'chosen' }],
      lines: [
        { seq: 1, side: 'panel', text: 'Hi Mateo, welcome back! The whiteboard is yours.' },
        { seq: 2, side: 'panel', text: "It's a classic: design Twitter." },
        { seq: 3, side: 'candidate', text: 'Is it read heavy or write heavy, and how fresh must the timeline be?' },
        { seq: 4, side: 'candidate', text: 'A post goes to the post service, then the fan-out writes it into each follower timeline in Redis.' },
        { seq: -1, side: 'panel', text: 'What happens to the timeline cache when a celebrity posts?' },
        { seq: 5, side: 'candidate', text: 'For celebrities I would skip fan-out and merge their posts at read time.' },
      ],
    };
    const out = scriptedRecap(input);
    expect(out.notCovered).toEqual([]);
    expect(out.competencies.map((c) => c.id)).toEqual(['system-design', 'communication']);
    expect(out.competencies[0]!.evidence.map((e) => e.seq)).toEqual(expect.arrayContaining([4, 5]));
  });

  it('passes its own parse, and says nothing when no asked question was heard', async () => {
    const raw = (await new ScriptedRecapModel().write(FIXED_INPUT)).raw;
    expect(parseRecapAnswer(raw, { competencyIds: ['communication', 'collaboration'], lines: FIXED_INPUT.lines })).toMatchObject({ ok: true, droppedClaims: 0 });
    expect(scriptedRecap({ ...FIXED_INPUT, questions: [] })).toEqual({ competencies: [], notCovered: ['communication', 'collaboration'] });
  });
});

describe('the Bedrock recap', () => {
  it('sends the request and returns the text and the usage', async () => {
    const send = jest.fn(async (_cmd: ConverseCommand) => ({
      output: { message: { role: 'assistant', content: [{ text: '{"competencies":[],"notCovered":[]}' }] } }, usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
    }));
    const out = await new BedrockRecapModel({ send: send as never, modelId: 'amazon.nova-pro-v1:0' }).write(FIXED_INPUT);
    expect(out).toEqual({ raw: '{"competencies":[],"notCovered":[]}', code: 'ok', sent: true, usage: { inputTokens: 900, outputTokens: 40 } });
    expect((send.mock.calls[0]![0] as unknown as { input: { modelId: string } }).input.modelId).toBe('amazon.nova-pro-v1:0');
  });

  it('turns a failure into a code and logs only the error\'s name', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = jest.fn(async () => { throw Object.assign(new Error('the transcript said …'), { name: 'ThrottlingException' }); });
    const out = await new BedrockRecapModel({ send: send as never }).write(FIXED_INPUT);
    expect(out).toEqual({ raw: null, code: 'error', sent: true, usage: null });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('transcript said');
    warn.mockRestore();
  });

  it('times out as a code', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = jest.fn((_c: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_r, reject) => opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')))));
    expect((await new BedrockRecapModel({ send: send as never, timeoutMs: 5 }).write(FIXED_INPUT)).code).toBe('timeout');
    warn.mockRestore();
  });
});

it('follows the coach\'s one switch', () => {
  setCoachModelFactory(() => new ScriptedCoachModel());
  expect(makeRecapModel().kind).toBe('scripted');
  setCoachModelFactory(() => new BedrockCoachModel({ send: (async () => ({})) as never }));
  expect(makeRecapModel().kind).toBe('bedrock');
});
