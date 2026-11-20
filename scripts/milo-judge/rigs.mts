// Rigs: the thing a script is run through. A rig takes one scenario and returns what was logged and which decide requests were made.
//   owner     the real turn owner (lanes 1A/1B), driven on the fake clock. NEEDS TURN OWNER until it merges: see owner-adapter.mts.
//   decide    a stand-in: name gate + follow-up window + hold + one minimal decide call. Runs `decide`-layer scenarios only. It is NOT the
//             product path; it exists so the model bake-off and the scorer run today.
//   perfect   the scenario's own expectation replayed as a log; the scorer's self-test.
import { decide, type DecideInput, type DecideResult } from './decide.mts';
import { fakeClock } from './fake-clock.mts';
import type { Action, Logged, Outcome, Scenario, ScriptEvent } from './types.mts';
import { SPEECH } from './types.mts';
import { MILO_CAN_DO, MILO_INTRO, NO_QUESTION_YET, acceptedWords, timeLeftTruth } from './truth.mts';

export type Rig = (s: Scenario) => Promise<Outcome>;

export const FOLLOW_UP_MS = 10_000;
/** Milo's name and the forms the transcriber mishears it as. */
export const NAME_RE = /(^|[^\p{L}\p{N}_])(milo|mylo|nilo|nylo|ilo|milow|mylow|meelo|mielo)(?![\p{L}\p{N}_])/iu;

export const byTime = (events: ScriptEvent[]): ScriptEvent[] => [...events].sort((a, b) => a.atMs - b.atMs);

/** The decide stand-in. `model` is the Decide model under test; `call` is injectable so tests need no network. */
export function decideRig(model: string, call: (m: string, i: DecideInput) => Promise<DecideResult> = decide): Rig {
  return async (s) => {
    const clock = fakeClock();
    const people = new Map(s.people.map((p) => [p.id, p]));
    const logged: Logged[] = [];
    const requests: Outcome['decideRequests'] = [];
    const lines = new Map<string, string[]>();
    const answeredAt = new Map<string, number>();
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
      const at = answeredAt.get(ev.who);
      const followUpAgoMs = at !== undefined && ev.atMs - at <= FOLLOW_UP_MS ? ev.atMs - at : null;
      const held = holds.has(ev.who);
      if (!named && followUpAgoMs === null && !held) continue;

      const input: DecideInput = {
        speaker, sentence: ev.text, named, followUpAgoMs, held, lastLines: history.slice(-3), miloLast,
        state: `Round: ${s.round.minutes} minutes, ${Math.max(0, Math.round((s.round.startedAtMs + s.round.minutes * 60_000 - ev.atMs) / 60_000))} left. ${s.round.question ? `Question Milo last asked: ${JSON.stringify(s.round.question)}.` : 'Milo has asked no question yet.'}`,
      };
      requests.push({ who: ev.who, lines: [ev.text] });
      const r = await call(model, input);
      const action: Action = r.action;
      if (action === 'stay_silent' || action === 'keep_listening') continue;
      // No name and no hold: a refusal is silence (the follow-up window must not make Milo interrupt people).
      if (action === 'cannot_help' && !named && !held) continue;
      let words: string | undefined;
      if (action === 'time_left') words = timeLeftTruth(s.round, ev.atMs);
      else if (action === 'repeat_question') words = s.round.question ?? NO_QUESTION_YET;
      else if (action === 'introduce') { if (introduced) continue; introduced = true; words = MILO_INTRO; }
      else if (action === 'cannot_help') words = speaker.role === 'candidate' ? MILO_CAN_DO : 'I cannot do that.';
      logged.push({ who: ev.who, action, words, args: r.args, atMs: ev.atMs });
      if (SPEECH.includes(action) || action === 'pad_write') answeredAt.set(ev.who, ev.atMs + 4_000);
      miloLast = { line: words ?? '', tool: action, args: action === 'pad_write' ? JSON.stringify(r.args) : undefined };
    }
    return { logged, decideRequests: requests };
  };
}

/** Replays the expectation as a log: the scorer's own check that a perfect owner scores 100%. */
export const perfectRig: Rig = async (s) => {
  const logged: Logged[] = [];
  for (const e of s.expect) {
    if (e.action === 'silent') continue;
    const at = s.events.find((x) => x.kind === 'sentence' && x.who === e.who)?.atMs ?? 0;
    const words = acceptedWords(e.words, s.round, at)?.[0];
    logged.push({ who: e.who, action: e.action, words, args: e.argHas ? { text: e.argHas } : undefined, atMs: at });
  }
  return { logged, decideRequests: [] };
};
