// Shapes the Milo judge shares: a timed script of who said what, what the turn owner logged, and what the truth is.

export type Role = 'lead' | 'panellist' | 'candidate';

/** What Milo can do. Speech actions say words; write actions change something; the rest are silence in different clothes. */
export type Action =
  | 'time_left' | 'repeat_question' | 'introduce' | 'cannot_help' // speech
  | 'pad_write' | 'pause_listening' | 'leave_call' | 'cancel' // writes
  | 'stay_silent' | 'keep_listening'; // no line

export const SPEECH: readonly Action[] = ['time_left', 'repeat_question', 'introduce', 'cannot_help'];
export const WRITES: readonly Action[] = ['pad_write', 'pause_listening', 'leave_call', 'cancel'];
export const CANDIDATE_ALLOWED: readonly Action[] = ['time_left', 'repeat_question', 'cannot_help'];

export interface Person { id: string; name: string; role: Role; declined?: boolean }

export interface Round {
  minutes: number;
  /** Round start, ms relative to the script's t0 (negative: started before the script). */
  startedAtMs: number;
  question: string | null;
}

/** One thing that happens on the fake clock. `sentence` is a FINAL transcript line from `who`'s own mic. */
export type ScriptEvent =
  | { atMs: number; kind: 'sentence'; who: string; text: string }
  /** The same words arriving on a lane that is not their speaker's (a remote voice through someone's speaker, or Milo's own audio). */
  | { atMs: number; kind: 'echo'; who: string; text: string; of: 'milo-last-line' | 'other-lane' }
  | { atMs: number; kind: 'hold'; who: string; down: boolean }
  /** `who` starts speaking again (a new onset); the turn owner may merge it with the previous sentence. */
  | { atMs: number; kind: 'onset'; who: string };

/** What the truth says one logged item must be. `words`: a literal, or @time_left / @question / @intro / @can_do, resolved from the round. */
export interface ExpectItem {
  who: string;
  action: Action | 'silent';
  words?: string;
  /** Text the action's argument must hold (a merged split request). */
  argHas?: string;
}

export type Layer = 'decide' | 'floor';

export interface Scenario {
  id: string;
  layer: Layer;
  tags: string[];
  people: Person[];
  round: Round;
  events: ScriptEvent[];
  /** In order. `silent` items name who must get silence; they only check that nothing extra is logged. */
  expect: ExpectItem[];
  /** True when no decide request may be made at all (a declined candidate). */
  noModelCall?: boolean;
  note?: string;
}

/** One line the turn owner logged (what the said log, or the action log, holds). */
export interface Logged { who: string; action: Action; words?: string; args?: Record<string, unknown>; atMs: number }

export interface DecideRequestSeen { who: string; lines: string[] }

export interface Outcome {
  logged: Logged[];
  decideRequests: DecideRequestSeen[];
  /** Audio started at these ms offsets, if the owner reports playout (silence is no audio). */
  audioStartsMs?: number[];
}

export interface Corpus { _readme?: string; scenarios: Scenario[] }
