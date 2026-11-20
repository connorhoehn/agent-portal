// Rigs: the thing a script is run through. A rig takes one scenario and returns what was logged and which decide requests were made.
//   owner     the real turn owner (lanes 1A/1B), driven on the fake clock. NEEDS TURN OWNER until it merges: see owner-adapter.mts.
//   decide    a stand-in: name gate + hold + one minimal decide call (the name is required: no follow-up window). Runs `decide`-layer scenarios only. It is NOT the
//             product path; it exists so the model bake-off and the scorer run today.
//   scripted  the decide rig with a scripted model in place of the network: it answers each request with the tool the truth names.
//             Offline. It proves the corpus, the gates and the scorer agree; it says nothing about any model.
//   perfect   the scenario's own expectation replayed as a log; the scorer's self-test.
import { decide, type DecideInput, type DecideResult } from './decide.mts';
import { fakeClock } from './fake-clock.mts';
import type { Action, Logged, Outcome, Scenario, ScriptEvent } from './types.mts';
import { TOOL_ARGS } from './types.mts';
import { NAME_SPELLINGS } from './seed.mts';
import { MILO_CAN_DO, MILO_INTRO, NO_QUESTION_YET, acceptedWords, timeLeftTruth } from './truth.mts';

export type Rig = (s: Scenario) => Promise<Outcome>;
/** The probe the stand-in rigs log (they have no writer): a question that passes truth.mts `isProbe`. */
const STAND_IN_PROBE = 'What would you change in this part, and why?';

/** Milo's name and the forms the transcriber mishears it as, as a whole word. */
export const NAME_RE = new RegExp(`(^|[^\\p{L}\\p{N}_])(${NAME_SPELLINGS.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

export const byTime = (events: ScriptEvent[]): ScriptEvent[] => [...events].sort((a, b) => a.atMs - b.atMs);

/** The decide stand-in. `model` is the Decide model under test; `call` is injectable so tests need no network. */
export function decideRig(model: string, call: (m: string, i: DecideInput) => Promise<DecideResult> = decide): Rig {
  return async (s) => {
    const clock = fakeClock();
    const people = new Map(s.people.map((p) => [p.id, p]));
    const logged: Logged[] = [];
    const requests: Outcome['decideRequests'] = [];
    const lines = new Map<string, string[]>();
    const holds = new Set<string>();
    let miloLast: DecideInput['miloLast'] = null;
    let introduced = false;

    for (const ev of byTime(s.events)) {
      await clock.advanceTo(ev.atMs);
      if (ev.kind === 'hold') { if (ev.down) holds.add(ev.who); else holds.delete(ev.who); continue; }
      if (ev.kind !== 'sentence') continue;
      const speaker = people.get(ev.who)!;
      const history = lines.get(ev.who) ?? [];
      lines.set(ev.who, [...history, ev.text]);
      if (speaker.declined) continue;
      const named = NAME_RE.test(ev.text);
      const held = holds.has(ev.who);
      // The name is required (owner decision, 20 November): without it, and without a hold, no model is asked, whatever came before.
      if (!named && !held) continue;

      const input: DecideInput = {
        speaker, sentence: ev.text, named, held, lastLines: history.slice(-3), miloLast,
        state: `Round: ${s.round.minutes} minutes, ${Math.max(0, Math.round((s.round.startedAtMs + s.round.minutes * 60_000 - ev.atMs) / 60_000))} left. ${s.round.question ? `Question Milo last asked: ${JSON.stringify(s.round.question)}.` : 'Milo has asked no question yet.'}`,
      };
      requests.push({ who: ev.who, lines: [...input.lastLines, ev.text] });
      const r = await call(model, input);
      const action: Action = r.action;
      if (action === 'stay_silent' || action === 'keep_listening') continue;
      let words: string | undefined;
      if (action === 'time_left') words = timeLeftTruth(s.round, ev.atMs);
      else if (action === 'repeat_question') words = s.round.question ?? NO_QUESTION_YET;
      else if (action === 'introduce') { if (introduced) continue; introduced = true; words = MILO_INTRO; }
      else if (action === 'cannot_help') words = speaker.role === 'candidate' ? MILO_CAN_DO : 'I cannot do that.';
      else if (action === 'ask_probe') words = STAND_IN_PROBE;
      logged.push({ who: ev.who, action, words, args: r.args, atMs: ev.atMs });
      miloLast = { line: words ?? '', tool: action, args: action === 'pad_write' ? JSON.stringify(r.args) : undefined };
    }
    return { logged, decideRequests: requests };
  };
}

/** The decide rig offline: a scripted model that gives each request the next tool the truth wants from that speaker, else stays silent. */
export const scriptedRig: Rig = (s) => {
  const want = s.expect.filter((e) => e.action !== 'silent');
  let next = 0;
  return decideRig('scripted', async (model, input) => {
    const e = want[next];
    if (!e || e.who !== input.speaker.id) return { action: 'stay_silent', args: {}, ms: 0, model };
    next += 1;
    const action = e.action as Action;
    return { action, args: Object.fromEntries(TOOL_ARGS[action].map((k) => [k, e.argHas ?? input.sentence])), ms: 0, model };
  })(s);
};

/** Replays the expectation as a log: the scorer's own check that a perfect owner scores 100%. */
export const perfectRig: Rig = async (s) => {
  const logged: Logged[] = [];
  for (const e of s.expect) {
    if (e.action === 'silent') continue;
    const at = s.events.find((x) => x.kind === 'sentence' && x.who === e.who)?.atMs ?? 0;
    const words = e.words === '@probe' ? STAND_IN_PROBE : acceptedWords(e.words, s.round, at)?.[0];
    logged.push({ who: e.who, action: e.action, words, args: TOOL_ARGS[e.action].length ? Object.fromEntries(TOOL_ARGS[e.action].map((k) => [k, e.argHas ?? 'as asked'])) : undefined, atMs: at });
  }
  return { logged, decideRequests: [] };
};
