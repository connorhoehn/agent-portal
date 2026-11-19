// The request detector (docs/meeting-assistant-design.md, decision 4). Pure state machine: attributed
// caption lines go in, request / cancel / command events come out. No I/O, no timers; time is the
// injected `clock`, and `tick()` is how a quiet speaker's request gets closed.
//
// What the rules are for. The captions service cuts a window after 3 s of audio or 0.6 s of
// silence, so one spoken request arrives as several captions, sometimes with a word cut in half and
// with junk slivers ("Thank you.") between. The detector rebuilds the request for ONE speaker.
//
//   Name.    The assistant's name (`ASSISTANT_NAME`, "Milo") or one of the spellings a transcript writes it with
//            ("Mylo"; `NAME_FORMS`), as a whole word, any case, punctuation around it, "Milo's" tolerated. A name
//            straight followed by a word that makes it part of another name or a common noun ("milo grain") is no
//            mention; with a comma between ("Milo, grain prices are next") it is.
//   Address. A caption is a request only if the name is *addressing* the assistant:
//     A. the name starts the caption or a sentence, or only greeting words precede it
//        ("Hey Milo", "Okay, Milo", "...logic. Milo, please."); or
//     B. mid-sentence, it is followed by a comma / colon / dash ("so, Milo, can you"), or by
//        "please", an imperative verb ("Milo write up ..."), a question word, or "can/could/would/will you".
//     So "I think Milo could help with that budget question" is NOT a request (mid-sentence, "could"
//     not followed by "you"), but "I think Milo, could you help" is. A request after the name's own sentence
//     has ended ("I trust Milo. Show me your solution.") is said to someone else, with one exception: a name
//     set off by a comma that closes its sentence ("So sorry, Milo. I was miles away. Could you repeat that?")
//     is a request when one of the next two sentences asks so, unless it is thanks or a goodbye ("Thanks,
//     Milo. That was great. Could you walk me through it?" asks the candidate).
//   C. the name is the last word of the caption (unless it follows thanks / bye / sorry): the request starts next caption.
//   Mention. Talking about Milo to someone else is never an address: Milo as what the sentence acts on or names ("just ask
//     Milo", "I've brought in Milo, our AI support", "this is Milo"), unless the same sentence goes on to ask it something
//     straight on, or after a pause with "you" ("let me ask Milo, can you add a test"; not "don't ask Milo, write it
//     yourself", nor "we could ask Milo. Show me your solution."); or Milo as the subject in the third person, a modal
//     straight after the name with no person after it ("Milo can help with that"; "Milo can you", "Milo, can help" still
//     address it).
//   Text before the name is dropped. If nothing follows the name ("...Milo.") the request is opened
//   empty and starts with the same speaker's next caption.
//   Stitching. The same speaker's following captions join the request. It closes when the speaker has been
//     quiet for 1.5 s since their last caption arrived; the wait stretches to 4 s when that caption looks
//     cut off (no closing . ? ! or a dangling word like "and") or the request has under three words so far
//     (a bare "Milo, please."). Hard caps: 12 captions or 60 s per request. A request the call's family knows
//     whole by its words ("Milo, introduce yourself") closes at once.
//   Other speakers' captions never join; each speaker has at most one open request.
//   Half-cut words. A caption ending in `pr-` followed by one starting with lowercase `iya` is joined: "priya".
//   Slivers. A caption of at most two words that is exactly a known Whisper filler is not stitched and
//     never becomes a request; the intake still stores it in the transcript.
//   Cancel. "Milo, never mind / cancel / stop" from the asker, while their request is open, cancels it.
//   Commands. "Milo, stop listening" / "Milo, pause" -> pause; "Milo, leave" -> dismiss; any speaker
//     (decision 8: anyone in the call can pause or dismiss).
import { ASSISTANT_NAME } from './chat-types.js';
import type { TranscriptLine } from './types.js';

export interface RequestEvent {
  type: 'request';
  callId: string;
  askedBy: string;
  text: string;
  /** Transcript line numbers that make up the request, in order. */
  lines: number[];
  startedAt: number;
  endedAt: number;
}
export interface CancelEvent {
  type: 'cancel';
  callId: string;
  askedBy: string;
  lines: number[];
  /** `cancelled`: the asker took it back. `empty`: they said the name and nothing followed. */
  reason: 'cancelled' | 'empty';
}
export interface CommandEvent {
  type: 'command';
  callId: string;
  command: 'pause' | 'dismiss';
  by: string;
  line: number;
}
export type DetectorEvent = RequestEvent | CancelEvent | CommandEvent;

export const DETECTOR_LIMITS = {
  quietMs: 1500,
  cutWaitMs: 4000,
  maxCaptions: 12,
  maxMs: 60_000,
  /** Under this many words the request is still an opener and waits the long time. */
  openerWords: 3,
} as const;

/**
 * How a transcript may write the assistant's name, keyed by the name (`ASSISTANT_NAME`, lower case): the spellings a speech-to-text
 * service produces for it, and the words that, straight after it with only a space between, make it part of another name or a
 * common noun rather than an address. A rename adds one entry here; a name without an entry is matched as written, with no exceptions.
 */
export const NAME_FORMS: Readonly<Record<string, { spellings: readonly string[]; notAddress: readonly string[] }>> = {
  milo: {
    spellings: ['milo', 'mylo'],
    // "milo" is also sorghum, the grain ("the milo fields", "Milo grain prices are up"), and a malted drink ("Milo powder").
    // Nouns only: a word someone could ask the assistant to do ("crop", "seed", "field") stays an address.
    notAddress: ['grain', 'sorghum', 'fields', 'crops', 'drink', 'powder'],
  },
};
const forms = NAME_FORMS[ASSISTANT_NAME.toLowerCase()];
/** Every way the name is heard, lower case: the name itself first. */
export const NAME_SPELLINGS: readonly string[] = [...new Set([ASSISTANT_NAME.toLowerCase(), ...(forms?.spellings ?? [])])];
/**
 * The people whose first name is a way the assistant's name is heard ("Milo Park", "Mylo Chen"): the detector cannot tell "Milo, ..."
 * said to them from a request, so the join notice names them (an open limit: nothing else changes). Display names, in order, once each.
 */
export function nameTwins(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const first = (n ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}]+$/u, '') ?? '';
    if (first && NAME_SPELLINGS.includes(first) && !out.includes(n.trim())) out.push(n.trim());
  }
  return out;
}

/** The spellings as a regular-expression alternation, each escaped so it matches as written. */
export const NAME_ALTERNATION = NAME_SPELLINGS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const NAME = new RegExp(`(^|[^\\p{L}\\p{N}_])(${NAME_ALTERNATION})(?:['’]s)?(?![\\p{L}\\p{N}_]|-\\p{L})`, 'giu');
const GREETING_ONLY = /^(?:(?:hey|hi|hello|ok|okay|so|yo|and|but|alright|well|um|uh|oh|there)[\s,.!-]*)+$/i;
const IMPERATIVES = new Set([
  'please', 'write', 'create', 'make', 'summarize', 'summarise', 'assign', 'add', 'draft', 'tell', 'show', 'find',
  'open', 'list', 'remind', 'schedule', 'send', 'give', 'set', 'update', 'check', 'look', 'pull', 'file', 'log',
  'post', 'share', 'put', 'take', 'note', 'what', 'whats', "what's", 'who', 'when', 'where', 'how', 'why', 'which',
]);
/**
 * Whisper's known silence hallucinations, matched whole and only on a caption of two words or fewer.
 * PROVISIONAL: the words now come from a live session's transcript, which may not produce these.
 */
export const WHISPER_FILLERS = new Set([
  'thank you', 'thanks', 'you', 'bye', 'bye bye', 'goodbye', 'thanks for watching', 'okay', 'ok', 'uh', 'um', 'hmm', 'mm', 'mhm', 'the end',
]);
/**
 * Words that make the name what the speaker's sentence acts on or names, not who it speaks to: "just ask Milo", "I've brought in
 * Milo, our AI support", "this is Milo".
 */
const NAME_AS_OBJECT: ReadonlySet<string> = new Set([
  'ask', 'asking', 'tell', 'telling', 'let', 'have', 'get', 'use', 'using', 'try', 'ping', 'call',
  'to', 'with', 'for', 'from', 'about', 'at', 'by', 'of', 'on', 'in', 'into', 'like', 'than', 'without',
  'is', 'was', "it's", "that's", "here's", "there's",
]);
/** A modal straight after the name says what Milo does ("Milo can help with that"), unless a person follows it ("Milo can you"). */
const MODALS: ReadonlySet<string> = new Set([
  'can', 'could', 'will', 'would', 'should', 'might', 'may', 'must', 'shall',
  "can't", 'cant', 'cannot', "won't", 'wont', "wouldn't", "couldn't", "shouldn't",
]);
const QUESTION_SUBJECTS: ReadonlySet<string> = new Set(['you', 'u', 'ya', 'we', 'i', 'he', 'she', 'they', 'it', 'this', 'that', 'there', 'someone', 'somebody', 'anyone', 'anybody']);
/**
 * Is this mention of the name talk about Milo to someone else (the Mention rule above)? `before` and `after` are the text around
 * the name, `rest` is `after` without the punctuation it starts with, `initial` whether the name starts its sentence. A name the
 * sentence acts on still addresses Milo when the ask follows the name straight on ("hang on Milo what did Priya say"), or after a
 * pause in the same sentence with "you" ("let me ask Milo, can you add a test"). An imperative after the pause ("don't ask Milo,
 * write it yourself") is said to the listener, and an ask after the name's sentence has ended ("we could ask Milo. Show me your
 * solution.") is another sentence, said to whoever the speaker faces.
 */
const talksAboutName = (before: string, after: string, rest: string, initial: boolean): boolean => {
  const [first = '', second = ''] = norm(rest).split(' ');
  const asksMiloHere = /^\s+\p{L}/u.test(after) ? asksSomething(rest) : !closesSentence(after) && asksYou(rest);
  if (!initial && !asksMiloHere && NAME_AS_OBJECT.has(norm(before).split(' ').pop() ?? '')) return true;
  return /^\s+\p{L}/u.test(after) && MODALS.has(first) && !QUESTION_SUBJECTS.has(second);
};
/** Do these words start by asking someone "can/could/would/will you"? */
const asksYou = (text: string): boolean => {
  const [first = '', second = ''] = norm(text).split(' ');
  return ['can', 'could', 'would', 'will'].includes(first) && second === 'you';
};
/** Do these words start by asking something: "please", an imperative, or "can/could/would/will you"? */
const asksSomething = (text: string): boolean => IMPERATIVES.has(norm(text).split(' ')[0] ?? '') || asksYou(text);
/** The name ends its sentence: a full stop, "!" or "?" straight after it (an ellipsis is a pause, not an end). */
const closesSentence = (after: string): boolean => /^\s*[.!?]/.test(after) && !/^\s*\.\./.test(after);
/** Thanks or a goodbye right before the name ("Thanks, Milo"): said to Milo, but never a request, whatever follows. */
const THANKS_OR_BYE = /(thanks|thank you|bye|goodbye|cheers)[\s,.!]*$/i;
/**
 * How many sentences after a name that closes its own sentence after a comma ("So sorry, Milo.") the speaker may still be asking
 * Milo something: "So sorry, Milo. I was miles away. Could you repeat that?" The ask further on is for someone else.
 */
const VOCATIVE_REACH_SENTENCES = 2;
/** The name ends its sentence and a comma sets it off before ("Go for it, Milo!"): said to Milo, as a greeting or thanks may be. */
const closesSentenceSpokenTo = (before: string, after: string): boolean => /,$/.test(before) && /^\s*[.!?…]/.test(after);
const DANGLING = new Set(['and', 'or', 'but', 'to', 'for', 'the', 'a', 'an', 'of', 'with', 'that', 'in', 'on', 'so', 'then', 'about', 'at', 'is', 'it']);

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

export function isFillerSliver(text: string): boolean {
  const n = norm(text);
  return n !== '' && words(n).length <= 2 && WHISPER_FILLERS.has(n);
}

/** A caption that was probably cut by the window, not finished by the speaker. */
export function looksCut(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[a-z]-$/i.test(t)) return true;
  if (!/[.!?]["')\]]*$/.test(t)) return true;
  const last = norm(t).split(' ').pop() ?? '';
  return DANGLING.has(last);
}

/**
 * Words that, straight after the assistant's name with only a space between, make it part of something else (`NAME_FORMS`),
 * not an address. A small explicit list: an address has a comma, a pause or a request after the name.
 */
const NAME_PHRASE_SECOND_WORDS: ReadonlySet<string> = new Set(forms?.notAddress ?? []);
/**
 * Is the text right after the name the second word of something named with it ("milo grain")? Judged however the transcript
 * writes it: any case, or a possessive ("Milo powder's"). A comma between them is an address ("Milo, grain prices are next").
 */
const namePhraseFollows = (after: string): boolean => {
  const m = /^\s+([\p{L}'’]+)/u.exec(after);
  return !!m && NAME_PHRASE_SECOND_WORDS.has(m[1]!.toLowerCase().replace(/['’]s$/, '').replace(/[^\p{L}]+$/u, ''));
};

interface NameHit { addressed: boolean; rest: string }

/** The first mention of the name that is addressing the assistant, and what follows it. */
export function findAddress(text: string): NameHit | null {
  for (const m of text.matchAll(NAME)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const end = (m.index ?? 0) + m[0].length;
    const before = text.slice(0, start).trim();
    const after = text.slice(end);
    const rest = after.replace(/^[\s,:;.\-–—!?…]+/, '').trim();
    const initial = before === '' || /[.!?;…]["')\]]*$/.test(before) || GREETING_ONLY.test(before);
    if (namePhraseFollows(after) || talksAboutName(before, after, rest, initial)) continue;
    let addressed = initial;
    // Name as the very last word: the request is coming in the speaker's next caption, unless it is a thank-you or an apology.
    if (!addressed && rest === '' && !THANKS_OR_BYE.test(before) && !/sorry[\s,.!]*$/i.test(before)) addressed = true;
    if (!addressed) {
      if (/^\s*([,:;—–-]|\.\.\.|…)/.test(after)) addressed = true;
      // Mid-sentence, the name straight followed by the ask ("so Milo please summarise the call").
      else if (!closesSentence(after)) addressed = asksSomething(rest);
      // Spoken to Milo at the end of a sentence, not in thanks: a request only when one of the next sentences asks it something.
      else if (closesSentenceSpokenTo(before, after) && !THANKS_OR_BYE.test(before)) {
        addressed = rest.split(/(?<=[.!?…])\s+/).slice(0, VOCATIVE_REACH_SENTENCES).some(asksSomething);
      }
    }
    if (addressed) return { addressed, rest };
  }
  return null;
}

const CANCEL = /^(?:never ?mind|cancel|stop|forget it|scratch that|cancel that|stop that|never ?mind that|forget that)(?: please| thanks)?$/;
const PAUSE = /^(?:please )?(?:stop listening|pause|pause listening|stop recording)(?: please| now)?$/;
const DISMISS = /^(?:please )?(?:leave|leave now|leave the call|leave the meeting|leave us)(?: please| now)?$/;

export function parseCommand(rest: string): 'cancel' | 'pause' | 'dismiss' | null {
  const n = norm(rest);
  if (PAUSE.test(n)) return 'pause';
  if (DISMISS.test(n)) return 'dismiss';
  if (CANCEL.test(n)) return 'cancel';
  return null;
}

interface Open {
  askedBy: string;
  parts: string[];
  lines: number[];
  startedAt: number;
  endedAt: number;
  startedClock: number;
  lastClock: number;
  lastLooksCut: boolean;
  captions: number;
}

/** Join a half-cut word across a caption boundary: "...assign it to pr-" + "iya". */
export function appendText(parts: string[], text: string): void {
  const last = parts[parts.length - 1];
  if (last !== undefined && /[A-Za-z]-$/.test(last) && /^[a-z]/.test(text)) parts[parts.length - 1] = last.slice(0, -1) + text;
  else parts.push(text);
}

export class RequestDetector {
  private readonly open = new Map<string, Open>();
  constructor(private readonly callId: string, private readonly clock: () => number = Date.now) {}

  /** The speaker's open request, if any (for tests and the intake's counters). */
  hasOpen(userId: string): boolean { return this.open.has(userId); }

  /**
   * `whole`: the words after the name on this line are a request the call's family knows whole (a fixed phrase, intake.ts
   * `onWholeRequest`), so it closes now, however few words it has.
   * `turnEnded`: the provider itself ended the speaker's turn with this line (it began answering or handed the request on), so a
   * request with enough words closes now instead of waiting out `cutWaitMs`. The Live API puts a sentence's closing punctuation at
   * the START of the next delta, so a finished request ("Milo, how much time is left") looks cut by its text alone.
   */
  push(line: TranscriptLine, opts: { turnEnded?: boolean; whole?: boolean } = {}): DetectorEvent[] {
    const events = this.expire();
    // A piece nobody's audio was voiced for has no speaker to ask anything: it is stored but never a request or a command.
    const userId = line.userId;
    if (userId === null) return events;
    const now = this.clock();
    const text = line.text.trim();
    if (!text) return events;
    const sliver = isFillerSliver(text);

    const hit = sliver ? null : findAddress(text);
    if (hit) {
      const command = parseCommand(hit.rest);
      if (command === 'pause' || command === 'dismiss') {
        events.push({ type: 'command', callId: this.callId, command, by: userId, line: line.seq });
        return events;
      }
      if (command === 'cancel') {
        const o = this.open.get(userId);
        if (o) {
          this.open.delete(userId);
          events.push({ type: 'cancel', callId: this.callId, askedBy: userId, lines: [...o.lines, line.seq], reason: 'cancelled' });
        }
        return events;
      }
      // A fresh mention closes the same speaker's earlier request first.
      const previous = this.open.get(userId);
      if (previous) events.push(...this.close(previous));
      const o: Open = { askedBy: userId, parts: [], lines: [line.seq], startedAt: line.at, endedAt: line.at,
        startedClock: now, lastClock: now, lastLooksCut: true, captions: 1 };
      if (hit.rest) { appendText(o.parts, hit.rest); o.lastLooksCut = looksCut(hit.rest); }
      this.open.set(userId, o);
      // Words the call's family knows as a whole request (`whole`, judged on this line's words after the name) need no more.
      if (opts.whole === true && hit.rest) { events.push(...this.close(o)); return events; }
      return this.capped(o, events, now, opts.turnEnded === true);
    }

    const o = this.open.get(userId);
    if (!o || sliver) return events;
    appendText(o.parts, text);
    o.lines.push(line.seq);
    o.endedAt = line.at;
    o.lastClock = now;
    o.lastLooksCut = looksCut(text);
    o.captions += 1;
    return this.capped(o, events, now, opts.turnEnded === true);
  }

  /** Close every request whose quiet time or cap has passed on the clock. */
  tick(): DetectorEvent[] { return this.expire(); }

  private deadline(o: Open): number {
    const text = o.parts.join(' ');
    const wait = o.lastLooksCut || words(text).length < DETECTOR_LIMITS.openerWords ? DETECTOR_LIMITS.cutWaitMs : DETECTOR_LIMITS.quietMs;
    return Math.min(o.lastClock + wait, o.startedClock + DETECTOR_LIMITS.maxMs);
  }
  private capped(o: Open, events: DetectorEvent[], now: number, turnEnded = false): DetectorEvent[] {
    const complete = turnEnded && words(o.parts.join(' ')).length >= DETECTOR_LIMITS.openerWords;
    if (complete || o.captions >= DETECTOR_LIMITS.maxCaptions || now - o.startedClock >= DETECTOR_LIMITS.maxMs) events.push(...this.close(o));
    return events;
  }
  private expire(): DetectorEvent[] {
    const now = this.clock();
    const events: DetectorEvent[] = [];
    for (const o of [...this.open.values()]) if (now >= this.deadline(o)) events.push(...this.close(o));
    return events;
  }
  private close(o: Open): DetectorEvent[] {
    this.open.delete(o.askedBy);
    const text = o.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return [{ type: 'cancel', callId: this.callId, askedBy: o.askedBy, lines: o.lines, reason: 'empty' }];
    return [{ type: 'request', callId: this.callId, askedBy: o.askedBy, text, lines: o.lines, startedAt: o.startedAt, endedAt: o.endedAt }];
  }
}

/**
 * Name lock: did `userId` say the name in the `windowMs` before `atMs`? True when any line attributed to
 * that person (as `userId` or listed in `speakers`, so an overlapped line counts for each of them) ending in
 * [atMs - windowMs, atMs] contains an addressing mention of the name by `findAddress`. A line's end is
 * `at`. Pure; the audio side of the gate is a later package.
 */
export function nameLock(lines: readonly TranscriptLine[], userId: string, atMs: number, windowMs = 20_000): boolean {
  return lines.some((l) => (l.userId === userId || l.speakers?.includes(userId) === true)
    && l.at <= atMs && l.at >= atMs - windowMs && findAddress(l.text) !== null);
}
