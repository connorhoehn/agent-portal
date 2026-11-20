// The probe writer (probe.ts `writeProbe`): it is independent of the coach's mode. With a key it always asks the text model for a
// real probe (the coach may be the scripted stand-in); only a missing key falls back, and the fallback still names the region.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
jest.mock('../../spend.js', () => ({
  ...jest.requireActual('../../spend.js'),
  reserveInterviewSpend: jest.fn(async () => ({ ok: true, holdId: 'h1', sourceId: 's1', amountUsd: 0.01 })),
  settleInterviewSpend: jest.fn(async () => undefined),
  releaseInterviewSpend: jest.fn(async () => undefined),
}));
import type { TextToolRequest } from '../../../voice/openai-text.js';
import { DEFAULT_PROBE_MODEL, fallbackProbe, setProbeRequest, writeProbe, type ProbeInput } from '../probe.js';

const IV = { id: 'iv-pw', leadId: 'u-hugo' };
const INPUT: ProbeInput = {
  topic: 'the non-functional requirements in this part of the design',
  questions: [{ id: 'q', prompt: 'Design Twitter.' } as never],
  surface: 'board',
  board: { frame: 'High level design', labels: ['Fanout service', 'Timeline cache', 'Tweet store'], elsewhere: ['Requirements'] },
  pad: null,
  heard: [{ side: 'candidate', text: 'Tweets go to the fanout service which writes timelines.' }],
};
const env = { ...process.env };
let asked: TextToolRequest[] = [];

beforeEach(() => {
  asked = [];
  setProbeRequest(async (req) => { asked.push(req); return { call: { name: 'probe', arguments: JSON.stringify({ question: 'What happens to the timeline cache when a celebrity posts?' }) }, usage: { input: 900, output: 20 }, ms: 400 } as never; });
});
afterEach(() => { process.env = { ...env }; setProbeRequest(null); });

describe('the probe writer is independent of the coach', () => {
  it('a scripted coach with a key: the text model writes the probe, from the region\'s labels', async () => {
    process.env['INTERVIEWS_COACH_MODEL'] = 'scripted';
    process.env['OPENAI_API_KEY'] = 'sk-test-not-real';
    delete process.env['MILO_PROBE_MODEL'];
    expect(await writeProbe(IV, INPUT)).toBe('What happens to the timeline cache when a celebrity posts?');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.model).toBe(DEFAULT_PROBE_MODEL);
    expect(asked[0]!.input).toContain('Fanout service');
    expect(asked[0]!.input).toContain('Tweets go to the fanout service');
  });

  it('no key: no model call; the fallback names the region\'s actual labels, not a fixed template', async () => {
    process.env['INTERVIEWS_COACH_MODEL'] = 'scripted';
    delete process.env['OPENAI_API_KEY'];
    const q = await writeProbe(IV, INPUT);
    expect(asked).toHaveLength(0);
    expect(q).toBe(fallbackProbe(INPUT));
    expect(q).toMatch(/Fanout service/);
    expect(q).not.toMatch(/what would you change in/i);
    expect(q!.endsWith('?')).toBe(true);
  });

  it('the fallback without a board: still one question about the topic', () => {
    expect(fallbackProbe({ ...INPUT, board: null })).toMatch(/non-functional requirements.*\?$/);
    expect(fallbackProbe({ ...INPUT, board: null, topic: '' })).toMatch(/\?$/);
  });
});
