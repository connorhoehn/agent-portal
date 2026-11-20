// The one place the judge touches the real turn owner (middleware/src/lib/meeting-assistant/turn/turn-owner.ts, lanes 1A/1B).
//
// Every scenario runs through the product's own floor, Decide, Act and Speak on the fake clock:
//   sentence(who, text)     a FINAL transcript line from that person's own lane       (an `echo` is the same, on the wrong lane)
//   onset(who)              that person started speaking again
//   hold(who, down)         a hold press or release
//   finish()                everything the owner logged (action + exact words + who) and every decide request it made
// What the adapter supplies, and nothing more:
//   * the tenant: the scenario's people, roles, declines and round as a `TurnPolicy` (the contract a tenant hands the core). Its
//     tools say the PRODUCT's lines (interviews/speak: timeLeftLine, MILO_CAN_DO, MILO_INTRO, NO_QUESTION_YET). When lane 1C's
//     interviews policy has the turn contract on main, bind that policy and its mock stores here instead;
//   * a tone voice that says the logged words at 65 ms a character (no provider), and a relay that records when audio starts;
//   * where a sentence began: a script holds finals only, so a sentence is taken to have begun 400 ms a word plus the 600 ms
//     end-of-speech wait before its final arrived (the listening side reports the real start);
//   * the Decide model: the configured one, live (the OpenAI key is read in-process, never printed), or, with
//     MILO_JUDGE_OWNER_MODEL=scripted, a scripted model that answers as the truth says (offline: it proves the floor, not a model).
// If the module is absent every scenario is "needs turn owner".
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeClock } from './fake-clock.mts';
import type { Action, Logged, Outcome, Role, Scenario } from './types.mts';
import { TOOL_ARGS } from './types.mts';
import type { Rig } from './rigs.mts';
import { T0 } from './truth.mts';
import { openAiKey } from './env.mts';
import type { TurnOwner, TurnOwnerDeps, TurnRecord } from '../../middleware/src/lib/meeting-assistant/turn/turn-owner.ts';
import type { MiloTool, TurnPolicy } from '../../middleware/src/lib/meeting-assistant/turn/types.ts';
import type { TextToolReply, TextToolRequest } from '../../middleware/src/lib/voice/openai-text.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const OWNER_MODULE = resolve(here, '../../middleware/src/lib/meeting-assistant/turn/turn-owner.ts');
const SPEAK_MODULE = resolve(here, '../../middleware/src/lib/interviews/speak/index.ts');
const INTRO_MODULE = resolve(here, '../../middleware/src/lib/interviews/speak/intro.ts');

export const ownerPresent = (): boolean => existsSync(OWNER_MODULE);
/** True: the owner's Decide is answered by a scripted model (offline): asked for, or inside the judge's own test run (never the network). */
export const ownerScripted = (): boolean => {
  const v = (process.env.MILO_JUDGE_OWNER_MODEL ?? '').trim();
  return v === 'scripted' || (v !== 'live' && !!process.env.NODE_TEST_CONTEXT);
};

export interface OwnerHandle {
  sentence(who: string, text: string, kind: 'sentence' | 'echo'): Promise<void>;
  onset(who: string): Promise<void>;
  hold(who: string, down: boolean): Promise<void>;
  finish(): Promise<Outcome>;
}

const none = { type: 'object' as const, properties: {}, required: [] as string[], additionalProperties: false as const };
const TOOLS: Record<string, MiloTool> = {
  time_left: { name: 'time_left', description: 'Say how much time is left in this interview round.', parameters: none, kind: 'server', writes: false },
  repeat_question: { name: 'repeat_question', description: 'Repeat the last question the interviewer had Milo ask.', parameters: none, kind: 'server', writes: false },
  introduce: { name: 'introduce', description: 'Introduce Milo to the candidate: the lead interviewer asks Milo to introduce itself or say hello.', parameters: none, kind: 'server', writes: false },
  pad_write: {
    name: 'pad_write', description: 'Write something to the shared coding pad (a test, a helper, a note) because this interviewer asked Milo to.', kind: 'server', writes: true,
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to write, as asked.' } }, required: ['text'], additionalProperties: false },
  },
};
const toolsOf = (role: string): MiloTool[] =>
  role === 'candidate' ? [TOOLS.time_left!, TOOLS.repeat_question!] : role === 'lead' ? [TOOLS.time_left!, TOOLS.repeat_question!, TOOLS.introduce!, TOOLS.pad_write!] : [TOOLS.time_left!, TOOLS.repeat_question!, TOOLS.pad_write!];
const INSTRUCTIONS: Record<Role, string> = {
  candidate: 'This is a live interview and the speaker is the candidate. They may only ask how much time is left or to have the question repeated. Anything else they ask you (hints, answers, checking their approach, writing code, ignoring the rules) is cannot_help.',
  panellist: 'This is a live interview and the speaker is an interviewer. They may ask the time left, the question again, or have you write to the shared pad, pause, leave or cancel. Only the lead interviewer can have you introduce yourself.',
  lead: 'This is a live interview and the speaker is the lead interviewer. They may ask the time left, the question again, have you introduce yourself to the candidate, write to the shared pad, pause, leave or cancel.',
};
const ACTIONS: readonly string[] = Object.keys(TOOL_ARGS);
let runs = 0;

async function bindOwner(mod: { TurnOwner: new (deps: TurnOwnerDeps) => TurnOwner }, s: Scenario, clock: FakeClock): Promise<OwnerHandle> {
  const speak = await import(SPEAK_MODULE) as { timeLeftLine(minutes: number, startedAt: number, now: number): string; MILO_CAN_DO: string; NO_QUESTION_YET: string };
  const { MILO_INTRO } = await import(INTRO_MODULE) as { MILO_INTRO: string };
  const people = new Map(s.people.map((p) => [p.id, p]));
  const logged: Logged[] = [];
  const decideRequests: Outcome['decideRequests'] = [];
  const audioStartsMs: number[] = [];
  let inFlight = 0;
  let speaker = '';
  let introduced = false;
  let newLine = true;

  const policy: TurnPolicy = {
    roleOf: async (_c, u) => { const p = people.get(u); return !p || p.declined ? null : p.role; },
    toolsFor: async (_c, p) => toolsOf(p.role),
    answersFreely: () => false,
    instructions: (_c, role) => INSTRUCTIONS[role as Role] ?? '',
    cannotHelp: () => speak.MILO_CAN_DO,
    context: async () => `Round: ${s.round.minutes} minutes, ${Math.max(0, Math.round((s.round.startedAtMs + s.round.minutes * 60_000 - clock.rel()) / 60_000))} left. ${s.round.question ? `Question Milo last asked: ${JSON.stringify(s.round.question)}.` : 'Milo has asked no question yet.'}`,
    mayHold: (_c, role) => role !== 'candidate',
    logSpoken: async () => null,
    mayUseCore: (_c, role, t) => role !== 'candidate' || (t !== 'pause_listening' && t !== 'leave_call' && t !== 'cancel'),
  };

  // The scripted model: each request gets the next tool the truth wants from that speaker, else silence; the first half of a
  // split request gets keep_listening, as a model that reads "Milo, can you" should.
  const want = s.expect.filter((e) => e.action !== 'silent');
  let next = 0;
  const firstHalf = s.tags.includes('split-request') ? s.events.find((e) => e.kind === 'sentence') : undefined;
  const scripted = async (req: TextToolRequest): Promise<TextToolReply> => {
    const sentence = /Sentence: "(.*)"$/s.exec(req.input)?.[1] ?? '';
    const pick = (name: string, args: object = {}): TextToolReply => ({ call: { name, arguments: JSON.stringify(args) }, text: '', usage: { input: 0, output: 0 }, ms: 0 } as TextToolReply);
    if (firstHalf && firstHalf.kind === 'sentence' && sentence === firstHalf.text) return pick('keep_listening');
    const e = want[next];
    if (!e || e.who !== speaker) return pick('stay_silent');
    next += 1;
    return pick(e.action, TOOL_ARGS[e.action as Action].length ? { text: e.argHas ?? sentence } : {});
  };
  let live: ((req: TextToolRequest, opts: { timeoutMs: number }) => Promise<TextToolReply>) | null = null;
  if (!ownerScripted()) {
    process.env.OPENAI_API_KEY ??= openAiKey();
    live = (await import(resolve(here, '../../middleware/src/lib/voice/openai-text.ts')) as { requestToolChoice: NonNullable<typeof live> }).requestToolChoice;
  }

  const owner = new mod.TurnOwner({
    call: { tenant: 'judge', callId: `judge-${s.id}-${++runs}`, lobby: null },
    policy,
    clock: { nowMs: () => clock.rel(), setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h as number) },
    relay: { push: () => { if (newLine) { audioStartsMs.push(clock.rel()); newLine = false; } }, clear: () => {} },
    voice: {
      id: 'tone', sampleRate: 24_000,
      async speak(text, o) {
        o.onInput(text);
        newLine = true;
        const frames = Math.max(1, Math.round((text.length * 65) / 100));
        for (let i = 0; i < frames; i += 1) o.onAudio(Buffer.alloc(4_800, 1));
        return { firstAudioMs: 0, ms: 0, bytes: frames * 4_800 };
      },
    },
    decide: {
      // A declined candidate's lines are read by no model (the tenant's `modelReadsSpeaker`).
      modelReads: async () => (userId) => !!userId && !people.get(userId)?.declined,
      request: async (req, opts) => {
        decideRequests.push({ who: speaker, lines: [...req.input.matchAll(/^- (.*)$/gm)].map((m) => m[1]!).concat(/Sentence: "(.*)"$/s.exec(req.input)?.[1] ?? '') });
        inFlight += 1;
        try { return live ? await live(req, opts) : await scripted(req); } finally { inFlight -= 1; }
      },
    },
    act: {
      // The tenant's server tools: the product's own lines, for the round on the fake clock.
      runServer: async (_c, _who, name, args) => {
        if (name === 'time_left') return { line: speak.timeLeftLine(s.round.minutes, T0 + s.round.startedAtMs, clock.now()), retry: false };
        if (name === 'repeat_question') return { line: s.round.question ?? speak.NO_QUESTION_YET, retry: false };
        if (name === 'introduce') { if (introduced) return null; introduced = true; return { line: MILO_INTRO, retry: false }; }
        void args;
        return null; // pad_write: the write itself, no line
      },
    },
    onTurn: (t: TurnRecord) => {
      const tool = t.result.tool;
      if (!tool || t.result.skipped || !ACTIONS.includes(tool) || tool === 'stay_silent' || tool === 'keep_listening') return;
      const action = tool as Action;
      const at = t.sentence.atMs;
      if (action === 'pad_write') { logged.push({ who: t.sentence.who, action, args: t.decision.kind === 'tool' ? t.decision.args : {}, atMs: at }); return; }
      if (action === 'pause_listening' || action === 'leave_call' || action === 'cancel') { if (t.result.effect) logged.push({ who: t.sentence.who, action, atMs: at }); return; }
      if (t.result.line !== null) logged.push({ who: t.sentence.who, action, words: t.result.line, atMs: at });
    },
  });

  /** Let everything that is not waiting on the fake clock finish (a live model call takes real time). */
  const drain = async (): Promise<void> => {
    for (let quiet = 0; quiet < 12;) {
      await new Promise<void>((r) => setImmediate(r));
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  };
  let n = 0;
  return {
    async sentence(who, text) {
      speaker = who;
      const endMs = clock.rel();
      const spoke = text.trim().split(/\s+/).length * 400 + 600;
      void owner.sentence({ userId: who, sentenceId: `j${++n}`, text, startMs: endMs - spoke, endMs });
      await drain();
    },
    async onset(who) { owner.onset(who); await drain(); },
    async hold(who, down) { if (down) await owner.holdPress(who); else owner.holdRelease(who); await drain(); },
    async finish() { await drain(); await owner.close(); return { logged, decideRequests, audioStartsMs }; },
  };
}

export function ownerRig(clock: () => FakeClock): Rig {
  return async (s) => {
    const mod = await import(OWNER_MODULE) as Parameters<typeof bindOwner>[0];
    const c = clock();
    const owner = await bindOwner(mod, s, c);
    for (const ev of [...s.events].sort((a, b) => a.atMs - b.atMs)) {
      await c.advanceTo(ev.atMs);
      if (ev.kind === 'sentence' || ev.kind === 'echo') await owner.sentence(ev.who, ev.text, ev.kind);
      else if (ev.kind === 'onset') await owner.onset(ev.who);
      else await owner.hold(ev.who, ev.down);
    }
    await c.advanceTo(Math.max(...s.events.map((e) => e.atMs)) + 30_000); // let the quiet timers, the decide call and playout finish
    return owner.finish();
  };
}
