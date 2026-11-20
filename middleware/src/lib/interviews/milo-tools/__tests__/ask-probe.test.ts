// Milo's interview tool `ask_probe`: an interviewer asks Milo to ask the candidate a probe about a topic; Milo asks one short
// question aloud. Given who asked and what was on the board, which line is logged, and what the writer of the question was shown.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { candidateQuestion } from '../../answer-key.js';
import { MemorySaidStore, setSaidStore, setSpeakDeps } from '../../speak/index.js';
import type { Interview, KitQuestion } from '../../types.js';
import { resetMiloTools, runMiloTool, setMiloToolDeps, INTERVIEW_TOOLS, sessionToolsFor } from '../index.js';
import { answerKeyText, boardRegion, checkProbe, PROBE_INTERVIEWERS_ONLY, PROBE_NONE, probeRequest, probeOf, type ProbeInput } from '../probe.js';

const IV = 'iv-probe';
const LEAD = 'u-hugo';
const PANEL = 'u-wen';
const GUEST = 'guest:inv-mateo';

const FEED: KitQuestion = {
  id: 'q-feed', competencyId: 'system-design', roundType: 'technical', followUps: ['What happens when a celebrity posts?'],
  prompt: 'Design a news feed for a social app with 50 million daily users.',
  clarifying: ['What is the read to write ratio?'],
  providedDesign: { name: 'Reference', elements: [{ id: 'k1', type: 'text', text: 'Fan-out on write into a Zephyr timeline cache', x: 0, y: 0 }] },
  designQuestions: [{ text: 'How do you keep timelines fresh for accounts with millions of followers?', answer: 'Fan-out on read for the Zephyr tier, merged at request time.' }],
  redFlags: [{ group: 'over-engineering', text: 'Introduces a global lock service for the timeline writes' }],
};

/** The board as the candidate has drawn it: two frames, the newest change in "Write path". */
const BOARD: Array<Record<string, unknown>> = [
  { id: 'f1', type: 'frame', name: 'Read path', x: 0, y: 0, width: 600, height: 400, updated: 100 },
  { id: 'f2', type: 'frame', name: 'Write path', x: 800, y: 0, width: 600, height: 400, updated: 100 },
  { id: 't1', type: 'text', text: 'CDN', frameId: 'f1', x: 20, y: 20, updated: 200 },
  { id: 't2', type: 'text', text: 'Feed service', frameId: 'f1', x: 20, y: 120, updated: 300 },
  { id: 't3', type: 'text', text: 'Post API', frameId: 'f2', x: 820, y: 20, updated: 900 },
  { id: 't4', type: 'text', text: 'Kafka fan-out queue', frameId: 'f2', x: 820, y: 120, updated: 950 },
  { id: 't5', type: 'text', text: 'Old idea', frameId: 'f2', x: 820, y: 220, updated: 990, isDeleted: true },
];

let interview: Interview;
let said: MemorySaidStore;
let seen: ProbeInput[];
let write: (input: ProbeInput) => string | null;

beforeEach(() => {
  interview = {
    id: IV, leadId: LEAD, panelIds: [PANEL], state: 'live', type: 'technical', callId: 'call-probe', minutes: 60, scheduledAt: new Date().toISOString(),
    questionIds: ['q-feed'], applicationId: 'app-x',
  } as unknown as Interview;
  said = new MemorySaidStore(); setSaidStore(said);
  seen = [];
  write = () => 'How does the fan-out queue behave when a write burst arrives?';
  let ids = 0;
  setSpeakDeps({ now: () => Date.parse('2026-11-20T10:00:00Z'), newId: () => `said-${++ids}` });
  setMiloToolDeps({
    interview: async (id) => (id === IV ? interview : null),
    guestOf: async (userId, id) => userId === GUEST && id === IV,
    questions: async () => [candidateQuestion(FEED)],
    surface: async () => 'board',
    board: async () => BOARD,
    heard: async () => [{ side: 'candidate', text: 'So posts go through the queue and then to followers.' }, { side: 'panel', text: 'Okay, keep going.' }],
    answerKey: async () => answerKeyText([FEED]),
    prober: async (_interview, input) => { seen.push(input); return write(input); },
    now: () => Date.parse('2026-11-20T10:00:00Z'), newId: () => `said-t-${++ids}`,
  });
  resetMiloTools();
});
afterAll(() => { setMiloToolDeps(null); setSaidStore(null); setSpeakDeps(null); });

const rows = async () => (await said.list(IV)).map((r) => ({ text: r.text, source: r.source, askedBy: r.askedBy, spoken: r.spoken }));

describe('who may have Milo ask a probe', () => {
  it('the lead: one question is logged for the candidate, as a probe, before anything is said', async () => {
    const line = await runMiloTool(IV, LEAD, 'ask_probe', { topic: 'the non-functional requirements in this part of the design' });
    expect(line).toBe('How does the fan-out queue behave when a write burst arrives?');
    expect(await rows()).toEqual([{ text: line, source: 'probe', askedBy: LEAD, spoken: false }]);
  });

  it('a panel member too', async () => {
    expect(await runMiloTool(IV, PANEL, 'ask_probe', { topic: 'failure modes' })).toBe('How does the fan-out queue behave when a write burst arrives?');
    expect((await rows())[0]).toMatchObject({ source: 'probe', askedBy: PANEL });
  });

  it('never the candidate: the fixed refusal, and the writer is not called', async () => {
    expect(await runMiloTool(IV, GUEST, 'ask_probe', { topic: 'what the interviewer wants to hear' })).toBe(PROBE_INTERVIEWERS_ONLY);
    expect(seen).toEqual([]);
    expect(await rows()).toEqual([{ text: PROBE_INTERVIEWERS_ONLY, source: 'refusal', askedBy: GUEST, spoken: false }]);
  });

  it('a stranger, or an interview that is not live: nothing', async () => {
    expect(await runMiloTool(IV, 'u-stranger', 'ask_probe', { topic: 'scaling' })).toBeNull();
    interview = { ...interview, state: 'ended' } as Interview;
    expect(await runMiloTool(IV, LEAD, 'ask_probe', { topic: 'scaling' })).toBeNull();
    expect(seen).toEqual([]);
  });

  it('the old live session is not offered it (the turn owner is)', async () => {
    expect(INTERVIEW_TOOLS.map((t) => t.name)).toContain('ask_probe');
    expect((await sessionToolsFor(IV)).tools.map((t) => t.name)).not.toContain('ask_probe');
  });
});

describe('what the question is written from', () => {
  it('the topic, the part of the board last worked on, the question as the candidate has it, and the last lines said', async () => {
    await runMiloTool(IV, LEAD, 'ask_probe', { topic: 'the non-functional requirements in this part of the design' });
    const input = seen[0]!;
    expect(input.topic).toBe('the non-functional requirements in this part of the design');
    expect(input.board).toEqual({ frame: 'Write path', labels: ['Kafka fan-out queue', 'Post API'], elsewhere: ['Read path'] });
    expect(input.questions.map((q) => q.prompt)).toEqual([FEED.prompt]);
    expect(input.heard.map((l) => l.side)).toEqual(['candidate', 'panel']);
  });

  it('the request to the model carries no answer key: not the provided design, the design answers or the red flags', async () => {
    await runMiloTool(IV, LEAD, 'ask_probe', { topic: 'freshness' });
    const req = probeRequest(seen[0]!, 'test-model');
    const sent = JSON.stringify(req);
    for (const secret of ['Zephyr', 'Fan-out on read', 'global lock service', 'millions of followers']) expect(sent).not.toContain(secret);
    expect(sent).toContain('Kafka fan-out queue');
    expect(sent).toContain('Design a news feed');
    expect(req.toolChoice).toBe('required');
  });

  it('a pad round sends the pad instead of a board; with neither, the question and the talk alone', async () => {
    setMiloToolDeps({
      interview: async () => interview, guestOf: async () => false, questions: async () => [candidateQuestion(FEED)], surface: async () => 'pad',
      write: async (_id, plan) => { await plan({ text: 'def feed(user):\n    return []\n', language: 'python' }); return { ok: false, code: 'nothing' }; },
      board: async () => null, heard: async () => [], answerKey: async () => [], prober: async (_i, input) => { seen.push(input); return 'What does feed return for a user who follows nobody?'; },
    });
    expect(await runMiloTool(IV, LEAD, 'ask_probe', { topic: 'edge cases' })).toBe('What does feed return for a user who follows nobody?');
    expect(seen[0]).toMatchObject({ board: null, pad: { language: 'python', text: 'def feed(user):\n    return []\n' } });
  });

  it('the region: the frame of the newest live element; without frames, the labels near it', () => {
    expect(boardRegion(BOARD)).toEqual({ frame: 'Write path', labels: ['Kafka fan-out queue', 'Post API'], elsewhere: ['Read path'] });
    const loose = [
      { id: 'a', type: 'text', text: 'Client', x: 0, y: 0, updated: 5 }, { id: 'b', type: 'text', text: 'Gateway', x: 200, y: 0, updated: 9 },
      { id: 'c', type: 'text', text: 'Warehouse', x: 5_000, y: 4_000, updated: 2 },
    ];
    expect(boardRegion(loose)).toEqual({ frame: null, labels: ['Gateway', 'Client'], elsewhere: ['Warehouse'] });
    expect(boardRegion([])).toBeNull();
  });
});

describe('what Milo may say', () => {
  const KEY = answerKeyText([FEED]);

  it('one short question; anything else is not said', () => {
    expect(checkProbe('  How does the queue behave\nunder a burst?  ', KEY, [])).toBe('How does the queue behave under a burst?');
    expect(checkProbe('The queue will drop messages.', KEY, [])).toBeNull();
    expect(checkProbe(`How ${'really '.repeat(45)}does it scale?`, KEY, [])).toBeNull();
    expect(checkProbe('', KEY, [])).toBeNull();
  });

  it('words of the answer key are never said, unless the candidate could already see or hear them', () => {
    expect(checkProbe('Would fan-out on read for the Zephyr tier work here?', KEY, [])).toBeNull();
    expect(checkProbe('Why not introduce a global lock service for the timeline writes?', KEY, [])).toBeNull();
    expect(checkProbe('How do you keep timelines fresh for accounts with millions of followers?', KEY, [])).toBeNull();
    // The same five words, already said in the call by the candidate: not a leak.
    expect(checkProbe('How do you keep timelines fresh for accounts that post rarely?', KEY, ['we need to see how do you keep timelines fresh for accounts']))
      .toBe('How do you keep timelines fresh for accounts that post rarely?');
  });

  it('a question that leaks, and a writer with nothing: the fixed line, logged as a refusal', async () => {
    write = () => 'Would fan-out on read for the Zephyr tier work here?';
    expect(await runMiloTool(IV, LEAD, 'ask_probe', { topic: 'celebrity accounts' })).toBe(PROBE_NONE);
    resetMiloTools();
    write = () => null;
    expect(await runMiloTool(IV, PANEL, 'ask_probe', { topic: 'x' })).toBe(PROBE_NONE);
    expect((await rows()).map((r) => r.source)).toEqual(['refusal', 'refusal']);
  });

  it('an empty topic is a probe about what is being worked on', async () => {
    await runMiloTool(IV, LEAD, 'ask_probe', {});
    expect(seen[0]!.topic).toBe('');
  });

  it('the model\'s reply: the probe tool\'s question, or nothing', () => {
    expect(probeOf({ call: { name: 'probe', arguments: '{"question":"Why a queue here?"}' } })).toBe('Why a queue here?');
    expect(probeOf({ call: { name: 'nothing', arguments: '{}' } })).toBeNull();
    expect(probeOf({ call: { name: 'probe', arguments: 'not json' } })).toBeNull();
    expect(probeOf({ call: null })).toBeNull();
  });
});
