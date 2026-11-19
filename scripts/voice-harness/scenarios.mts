// Scenarios: a list of steps, each one person speaking one clip after a gap. The runner feeds every person's audio as
// its own stream (mixed into the session's input only for the people `route` names) and scores what Milo does.
export interface Step {
  speaker: string;
  clip: string;
  /** Silence before this step: from the previous step's clip end, or from the end of Milo's reply when that step awaited one. */
  gapMs: number;
  /** 'reply' = Milo should answer (latency is measured); 'silent' = he should not (a reply is "spoke when not asked"). */
  expect: 'reply' | 'silent';
  /** Apply the run's end-of-turn method (create / mute / instr / burst) when our VAD sees this step's speech end. */
  trigger?: boolean;
  /** Feed pace: 1 real time (default), 4 = four times real time, 0 = all frames at once (a buffered replay). */
  pace?: number;
  /** Barge-in: stop relaying Milo this long after his first audio (we only record what the session does next). */
  stopRelayAfterMs?: number;
  /** With stopRelayAfterMs: also cut the provider's speech by playing 100 ms of silence as an output fixture
   *  (session.output_audio.fixture.play interrupts model speech and mutes input; we unmute 300 ms later). */
  stopWithFixture?: boolean;
  /** Start this step while Milo is still talking: this long after his first audio of the previous step (overrides gapMs). */
  overMiloAfterMs?: number;
}
export interface Scenario { name: string; about: string; instructions?: string; steps: Step[] }

export const MILO_INSTRUCTIONS = [
  'You are Milo, a voice assistant listening in on a meeting.',
  'Answer only when someone speaks to you by name, or asks a follow-up question right after you answered them.',
  'Answer in one short sentence. When people talk to each other, stay silent.',
].join(' ');

const pad = (n: number) => String(n).padStart(2, '0');

export function scenarios(n: number): Record<string, Scenario> {
  const q = Array.from({ length: Math.min(n, 24) }, (_, i) => `q${pad(i + 1)}`);
  return {
    latency: {
      name: 'latency', about: '(a) one clean voice, a named question per step; speech end -> Milo first audio for the run method',
      steps: q.map((clip) => ({ speaker: 'hugo', clip, gapMs: 1200, expect: 'reply', trigger: true })),
    },
    chatter: {
      name: 'chatter', about: '(b) two people talking to each other, mentions without a request, then requests: does Milo speak unasked?',
      steps: [
        { speaker: 'cand', clip: 'c01', gapMs: 600, expect: 'silent' }, { speaker: 'cand', clip: 'c02', gapMs: 400, expect: 'silent' },
        { speaker: 'hugo', clip: 'c03', gapMs: 700, expect: 'silent' }, { speaker: 'hugo', clip: 'c04', gapMs: 500, expect: 'silent' },
        { speaker: 'cand', clip: 'c05', gapMs: 700, expect: 'silent' }, { speaker: 'hugo', clip: 'm01', gapMs: 900, expect: 'silent' },
        { speaker: 'cand', clip: 'm02', gapMs: 900, expect: 'silent' },
        { speaker: 'hugo', clip: 'q01', gapMs: 1500, expect: 'reply', trigger: true },
        { speaker: 'cand', clip: 'c01', gapMs: 1500, expect: 'silent' }, { speaker: 'hugo', clip: 'c04', gapMs: 600, expect: 'silent' },
        { speaker: 'cand', clip: 'h03', gapMs: 1500, expect: 'reply', trigger: true },
        { speaker: 'cand', clip: 'c05', gapMs: 1500, expect: 'silent' }, { speaker: 'hugo', clip: 'c03', gapMs: 600, expect: 'silent' },
      ],
    },
    'name-last': {
      name: 'name-last', about: '(d) the name last; the sentence replayed from a buffer faster than real time (pace from --pace)',
      steps: ['n01', 'n02', 'n03', 'n04', 'n05', 'h01', 'h02'].map((clip, i) => ({ speaker: i === 2 || i === 4 ? 'cand' : 'hugo', clip, gapMs: 5000, expect: 'reply', trigger: true, pace: -1 })), // gaps long enough to repay the replay's lead (--repay)
    },
    followup: {
      name: 'followup', about: '(f) a follow-up without the name 3 s after Milo answered',
      steps: [
        { speaker: 'hugo', clip: 'q01', gapMs: 800, expect: 'reply', trigger: true }, { speaker: 'hugo', clip: 'f01', gapMs: 3000, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'f02', gapMs: 3000, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'q02', gapMs: 2000, expect: 'reply', trigger: true }, { speaker: 'hugo', clip: 'f03', gapMs: 3000, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'q09', gapMs: 2000, expect: 'reply', trigger: true }, { speaker: 'hugo', clip: 'f04', gapMs: 3000, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'q15', gapMs: 2000, expect: 'reply', trigger: true }, { speaker: 'hugo', clip: 'f04', gapMs: 3000, expect: 'reply', trigger: true },
      ],
    },
    barge: {
      name: 'barge', about: '(g) barge-in: we stop relaying mid-answer; then someone talks over Milo; then a normal question',
      steps: [
        { speaker: 'hugo', clip: 'g01', gapMs: 800, expect: 'reply', trigger: true, stopRelayAfterMs: 1500 },
        { speaker: 'hugo', clip: 'q03', gapMs: 2500, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g02', gapMs: 2000, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g04', gapMs: 0, overMiloAfterMs: 2500, expect: 'silent' },
        { speaker: 'hugo', clip: 'q06', gapMs: 2500, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g01', gapMs: 2000, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g03', gapMs: 0, overMiloAfterMs: 2500, expect: 'silent' },
        { speaker: 'hugo', clip: 'q11', gapMs: 2500, expect: 'reply', trigger: true },
      ],
    },
    barge2: {
      name: 'barge2', about: '(g) stop relaying a long answer: nothing else vs cutting it with a silent output fixture; the next question after each',
      steps: [
        { speaker: 'hugo', clip: 'g02', gapMs: 800, expect: 'reply', trigger: true, stopRelayAfterMs: 1500 },
        { speaker: 'hugo', clip: 'q03', gapMs: 1500, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g01', gapMs: 1500, expect: 'reply', trigger: true, stopRelayAfterMs: 1500, stopWithFixture: true },
        { speaker: 'hugo', clip: 'q06', gapMs: 1500, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g02', gapMs: 1500, expect: 'reply', trigger: true, stopRelayAfterMs: 1500, stopWithFixture: true },
        { speaker: 'hugo', clip: 'q11', gapMs: 1500, expect: 'reply', trigger: true },
        { speaker: 'hugo', clip: 'g01', gapMs: 1500, expect: 'reply', trigger: true, stopRelayAfterMs: 1500 },
        { speaker: 'hugo', clip: 'q13', gapMs: 1500, expect: 'reply', trigger: true },
      ],
    },
    transcribe: {
      name: 'transcribe', about: '(c) provider transcription only: every clip with the name, per person; spoken "Milo" -> its text',
      steps: ['q01', 'q02', 'q03', 'q04', 'q05', 'q06', 'h01', 'h02', 'h03', 'h04', 'n01', 'n02', 'n03', 'n04', 'n05', 'm01', 'm02', 'g01', 'g03', 'q07', 'q08', 'q09', 'q10', 'q11']
        .map((clip) => ({ speaker: clip.startsWith('h03') || clip.startsWith('h04') || clip === 'n03' || clip === 'n05' || clip === 'm02' ? 'cand' : 'hugo', clip, gapMs: 1200, expect: 'silent' as const, trigger: true })),
    },
  };
}
