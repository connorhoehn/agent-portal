// Hands-free Milo, lane C: the rules (types.ts `HandsfreeRules`). Who may cause Milo to listen to them, which finished sentences
// are requests, and whether words heard while Milo speaks are his own echo or someone talking over him.
//
// Authority, in order, asked at every trigger (the name or the hold button) before any audio is routed (`admit`):
//   1. Milo is listening in this call (a record, state `listening`). Paused, left, or no record: `deny`.
//   2. The person acknowledged that Milo transcribes them, where their call's policy says (the in-call notice: `acked`; elsewhere:
//      `acknowledgedElsewhere`, an interview's candidate). Not acknowledged: `deny` (nothing of theirs may be heard).
//   3. The call family's own answer (policy `handsfree(call).admit`): an interview routes its panel, routes the candidate only with
//      pad help on (`candidateMayAsk`), gives them fixed lines otherwise, and denies everyone else. No family rule: `route`.
//   Any throw, or no answer within HANDSFREE.admitWaitMs, is `deny`.
//
// The verdict on a finished sentence (`verdict`), judged on the clean text before Milo's first audio is relayed:
//   via name       `findAddress` (detector.ts) must find the name addressing Milo, AND the sentence must not be one of the shapes
//                  that talk about him at its start, which findAddress lets through ("Milo's summary was good", "Milo said
//                  twelve"). Else `mention`. "Milo, never mind": `mention` (nothing to say, the turn is dropped).
//   via follow-up  no name needed, the asker only (the router's window): a question or an ask continues the conversation
//                  (`request`); a sentence turned to someone else, a thank-you or a bare reaction is an `aside` (closes it).
//   then           the family's held answer (an interview's time left / repeat / introduce, run on the server): `fixed` with its
//                  line ('' = handled, nothing to say = `mention`). A `fixed-lines` person never reaches the model: a held line,
//                  else the family's refusal (`fixed`), else `mention`.
//   Any throw: `mention` (fail closed: nothing relayed).
//
// Echo vs barge-in (`overlap`) is pure word matching on the transcripts, never loudness: an open speaker playing Milo back cannot
// fake a barge-in by being loud, only by not being Milo's words.
import { findAddress, NAME_ALTERNATION, parseCommand } from '../detector.js';
import { policyForLobby, type MeetingAssistantPolicy, type PolicyCall } from '../policy.js';
import { assistantStore } from '../store-select.js';
import type { AssistantRecord } from '../types.js';
import { HANDSFREE, type Admission, type HandsfreeRules, type OverlapVerdict, type TriggerVerdict } from './types.js';

export interface HandsfreeRulesDeps {
  /** The call's assistant record (default: the assistant store). */
  record?: (callId: string) => Promise<AssistantRecord | null>;
  /** A call's policy (default: by its lobby). */
  policy?: (call: PolicyCall) => MeetingAssistantPolicy;
  /** The display names of the people in the call, for telling an aside to one of them by name (default: none known). */
  roster?: (callId: string) => readonly string[];
  /** Bound for `admit` (default HANDSFREE.admitWaitMs; tests shorten it). */
  admitWaitMs?: number;
}

/** A promise's value, or `fallback` once `ms` pass or it rejects. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

const ADMISSIONS: ReadonlySet<string> = new Set(['route', 'fixed-lines', 'deny']);

// ── Mention vs request ──────────────────────────────────────────────────────────────────────────────────────────────────

const words = (s: string): string[] => s.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/** The name as a whole word, possessive or not. */
const NAME_SOURCE = `(^|[^\\p{L}\\p{N}])(${NAME_ALTERNATION})(?=$|[^\\p{L}\\p{N}])`;
const NAME_WORD = new RegExp(NAME_SOURCE, 'giu');
const HAS_NAME = new RegExp(NAME_SOURCE, 'iu');

/**
 * Verbs that, straight after the name with nothing between, make the name the sentence's subject: talked about, not to
 * ("Milo said twelve", "Milo is wrong", "Milo got that"). A request to Milo puts a comma there, or an ask ("Milo, what ...",
 * "Milo add ...", "Milo can you ...").
 */
const SUBJECT_VERBS: ReadonlySet<string> = new Set([
  'is', 'was', 'isnt', 'wasnt', 'has', 'had', 'hasnt', 'hadnt', 'said', 'says', 'did', 'does', 'didnt', 'doesnt', 'got', 'gets',
  'thinks', 'thought', 'knows', 'knew', 'made', 'makes', 'wrote', 'writes', 'told', 'tells', 'gave', 'gives', 'seems', 'seemed',
  'sounds', 'sounded', 'looks', 'looked', 'keeps', 'kept', 'missed', 'misses', 'heard', 'hears', 'took', 'takes', 'went', 'goes',
  'came', 'comes', 'wants', 'wanted', 'needs', 'needed', 'likes', 'liked', 'works', 'worked', 'does', 'shouldnt', 'cant', 'wont',
  'might', 'must', 'may', 'should', 'would', 'could', 'will', 'can', 'just', 'already', 'also', 'never', 'always', 'probably',
  'actually', 'really', 'and', 'or', 'too', 'again', 'here', 'there', 'thing', 'stuff', 'bot',
]);
/** Auxiliaries a yes/no question opens with, straight after the name when the comma was not heard. */
const INVERTING: ReadonlySet<string> = new Set(['is', 'was', 'isnt', 'wasnt', 'has', 'had', 'does', 'did', 'doesnt', 'didnt']);
/** Words ending in -ed that are asks, not a past tense ("Milo, need..." is rare; "embed" and "feed" are tools' words). */
const ED_NOT_PAST: ReadonlySet<string> = new Set(['need', 'feed', 'embed', 'proceed', 'seed', 'speed', 'shred', 'red', 'bed', 'heed', 'exceed', 'succeed']);
/** After a modal, these make it a question to Milo after all ("Milo can you ...", "Milo could we ..."). */
const ASKED_SUBJECTS: ReadonlySet<string> = new Set(['you', 'we', 'i', 'u']);
const MODALS: ReadonlySet<string> = new Set(['might', 'must', 'may', 'should', 'would', 'could', 'will', 'can', 'shouldnt', 'cant', 'wont']);

/**
 * Does the sentence, read whole, only talk about Milo? True when every place the name appears is a possessive ("Milo's"), or the
 * name straight followed (no comma) by a verb that makes it the subject. findAddress already refuses most mentions; this catches
 * the ones at the start of a sentence, which it reads as an address.
 */
export function talksAboutMilo(sentence: string): boolean {
  const hits = [...sentence.matchAll(NAME_WORD)];
  if (!hits.length) return false;
  // The name opening a yes/no question ("Milo is a tomato a fruit?", the transcriber dropping the comma) is an address.
  const opening = hits.length === 1 && /^\s*$/.test(sentence.slice(0, (hits[0]!.index ?? 0) + hits[0]![1]!.length));
  if (opening && /\?\s*$/.test(sentence) && INVERTING.has(words(sentence.slice((hits[0]!.index ?? 0) + hits[0]![0].length))[0] ?? '')) return false;
  return hits.every((m) => {
    const end = (m.index ?? 0) + m[0].length;
    const after = sentence.slice(end);
    if (/^['’]s\b/i.test(after)) return true; // "Milo's summary"
    if (!/^\s+\p{L}/u.test(after)) return false; // a comma, a stop or the end: set off, an address
    const [first = '', second = ''] = words(after);
    if (MODALS.has(first)) return !ASKED_SUBJECTS.has(second);
    if (SUBJECT_VERBS.has(first)) return true;
    return first.length > 3 && first.endsWith('ed') && !ED_NOT_PAST.has(first);
  });
}

/** The words a person says to Milo when the sentence addresses him, or null when it does not (a mention). */
export function addressedRequest(sentence: string): string | null {
  const hit = findAddress(sentence);
  if (!hit?.addressed || talksAboutMilo(sentence)) return null;
  return hit.rest;
}

// ── Follow-up: still talking to Milo, or turned to someone else ─────────────────────────────────────────────────────────

const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  'what', 'whats', 'why', 'how', 'hows', 'when', 'where', 'wheres', 'who', 'whos', 'which', 'whose', 'is', 'are', 'was', 'were',
  'can', 'could', 'would', 'will', 'do', 'does', 'did', 'should', 'shall', 'have', 'has', 'any', 'and', 'also', 'plus', 'then',
  'now', 'so', 'but', 'or', 'please', 'actually', 'wait', 'one', 'ok', 'okay', 'oh', 'hmm', 'um', 'uh', 'hm', 'right', 'sorry',
]);
const IMPERATIVES: ReadonlySet<string> = new Set([
  'add', 'make', 'give', 'tell', 'show', 'read', 'find', 'list', 'summarise', 'summarize', 'repeat', 'say', 'create', 'put', 'set',
  'send', 'check', 'look', 'explain', 'translate', 'change', 'remove', 'delete', 'update', 'schedule', 'assign', 'write', 'draft',
  'try', 'do', 'go', 'keep', 'continue', 'compare', 'search', 'book', 'open', 'move', 'rename', 'mark', 'note', 'remind', 'shorten',
  'expand', 'break', 'spell', 'define', 'convert', 'calculate', 'count', 'pull', 'get', 'start', 'stop', 'cancel', 'skip', 'undo',
]);
/** After "and" / "or": the last question carried on ("And in a regular year", "Or for a week"). */
const CONTINUES: ReadonlySet<string> = new Set(['in', 'for', 'on', 'at', 'with', 'without', 'about', 'what', 'whats', 'how', 'hows', 'why', 'when', 'where', 'who', 'which', 'if', 'after', 'before', 'during', 'the', 'a', 'an']);
/** Only a reaction or thanks: nothing asked. */
const REACTION = /^(?:(?:ok|okay|great|cool|nice|perfect|thanks|thank you|thank you so much|thanks a lot|got it|right|sure|good|awesome|brilliant|lovely|fine|alright|all right|yes|yeah|yep|no|nope|mm|hmm|ah|oh|wow|interesting|makes sense|that makes sense|fair|fair enough|sounds good|that helps|that works|appreciate it|cheers)\s*)+$/;
/** Interjections that may open a sentence before a comma without naming anyone. */
const INTERJECTIONS: ReadonlySet<string> = new Set(['so', 'ok', 'okay', 'oh', 'and', 'but', 'well', 'right', 'yes', 'yeah', 'no', 'hmm', 'um', 'uh', 'also', 'actually', 'then', 'now', 'sorry', 'wait', 'hey', 'great', 'cool', 'perfect', 'thanks', 'alright', 'sure', 'fine', 'nice', 'first', 'second', 'next', 'finally', 'honestly', 'anyway', 'look', 'listen']);

/** Is this sentence turned to a named person: "Sarah, what do you think?", "What do you think, Sarah?" (a roster name, or a capitalised vocative). */
function toSomeoneElse(sentence: string, roster: readonly string[]): boolean {
  const s = sentence.trim();
  const firstNames = new Set(roster.map((n) => words(n)[0]).filter((n): n is string => !!n));
  const lead = /^([\p{Lu}][\p{L}'’-]*)\s*,/u.exec(s);
  if (lead && !INTERJECTIONS.has(words(lead[1]!)[0] ?? '')) return true;
  const tail = /,\s*([\p{Lu}][\p{L}'’-]*)\s*[?.!]*$/u.exec(s);
  if (tail && !INTERJECTIONS.has(words(tail[1]!)[0] ?? '')) return true;
  const w = words(s);
  return (!!w[0] && firstNames.has(w[0]) && /^[^,]+,/.test(s)) || (!!w.at(-1) && firstNames.has(w.at(-1)!) && /,[^,]+$/.test(s));
}

/** A follow-up sentence (no name, inside the asker's window): still for Milo, or an aside. */
export function followUpKind(sentence: string, roster: readonly string[] = []): 'request' | 'aside' {
  const w = words(sentence);
  if (!w.length) return 'aside';
  if (REACTION.test(w.join(' '))) return 'aside';
  if (toSomeoneElse(sentence, roster)) return 'aside';
  if (w[0] === 'lets' || w[0] === 'we' || w[0] === 'i' || w[0] === 'im') return /\?\s*$/.test(sentence) ? 'request' : 'aside';
  if (/\?\s*$/.test(sentence)) return 'request';
  // A continuation of the last question ("And in a regular year.", the transcriber's stop for its question mark).
  if ((w[0] === 'and' || w[0] === 'or') && CONTINUES.has(w[1] ?? '')) return 'request';
  if (IMPERATIVES.has(w[0]!) || (w[0] === 'what' || w[0] === 'how') && w[1] === 'about') return 'request';
  // An opener then an ask ("And make it shorter", "Okay, now add two more").
  const rest = w.filter((x, i) => !(i < 3 && QUESTION_OPENERS.has(x) && !IMPERATIVES.has(x)));
  if (rest.length && IMPERATIVES.has(rest[0]!) && w.length - rest.length > 0) return 'request';
  if (QUESTION_OPENERS.has(w[0]!) && ['what', 'whats', 'why', 'how', 'hows', 'when', 'where', 'who', 'which', 'can', 'could', 'would', 'will', 'is', 'are', 'do', 'does', 'did', 'should'].includes(w[0]!)) return 'request';
  return 'aside';
}

// ── Echo vs barge-in ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A one-word interruption that is never Milo's echo when he did not say it. */
const STOP_WORDS: ReadonlySet<string> = new Set(['stop', 'wait', 'hold', 'enough', 'no', 'quiet', 'shush', 'cancel', 'pause', 'thanks']);

/**
 * Is what a mic heard while Milo speaks his own voice coming back (`echo`), someone talking over him (`barge-in`), or too little
 * to tell (`unclear`)? Words only. Milo's output transcript can lag his audio, so heard words that match his words first and only
 * run past them at the end are still `unclear` (his next words may not have arrived yet).
 */
export function overlapOf(heard: string, saying: string): OverlapVerdict {
  const mine = words(heard);
  if (!mine.length) return 'unclear';
  const spoken = words(saying);
  const said = new Set(spoken);
  if (mine.length === 1) return !said.has(mine[0]!) && STOP_WORDS.has(mine[0]!) ? 'barge-in' : 'unclear';
  if (!spoken.length) return mine.length >= 4 ? 'barge-in' : 'unclear';
  const joined = ` ${spoken.join(' ')} `;
  if (joined.includes(` ${mine.join(' ')} `)) return 'echo';
  // A stop word he has not said ("Milo, stop", "okay wait") is someone talking over him, however few the words.
  if (mine.some((x) => STOP_WORDS.has(x) && !said.has(x))) return 'barge-in';
  const hits = mine.map((x) => said.has(x));
  const share = hits.filter(Boolean).length / mine.length;
  if (mine.length >= 3 && share >= 0.8) return 'echo';
  // Milo's words first, then words he has not been transcribed saying yet: wait for the output transcript to catch up.
  const firstMiss = hits.indexOf(false);
  if (firstMiss >= 2 && hits.slice(firstMiss).every((h) => !h) && mine.length - firstMiss <= 3) return 'unclear';
  if (mine.length === 2) return share === 0 ? 'barge-in' : 'unclear';
  if (share <= 0.5) return 'barge-in';
  return mine.length >= 5 ? 'barge-in' : 'unclear';
}

// ── The rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The call's policy: by its lobby, as everywhere else. */
const policyOf = (call: PolicyCall): MeetingAssistantPolicy => policyForLobby(call.lobby);

export function createHandsfreeRules(deps: HandsfreeRulesDeps = {}): HandsfreeRules {
  const recordOf = deps.record ?? ((callId: string) => assistantStore().get(callId));
  const policyFor = deps.policy ?? policyOf;
  const rosterOf = deps.roster ?? (() => [] as const);
  const wait = deps.admitWaitMs ?? HANDSFREE.admitWaitMs;

  async function decideAdmission(call: PolicyCall, userId: string): Promise<Admission> {
    if (typeof userId !== 'string' || !userId) return 'deny';
    const record = await recordOf(call.callId);
    if (!record || record.callId !== call.callId || record.state !== 'listening') return 'deny';
    const policy = policyFor(call);
    const acknowledged = policy.acknowledgement(call, userId) === 'in-call-notice'
      ? record.acked.includes(userId)
      : (await (policy.acknowledgedElsewhere?.(call, [userId]) ?? Promise.resolve([]))).includes(userId);
    if (!acknowledged) return 'deny';
    const family = policy.handsfree?.(call);
    if (!family) return 'route';
    const out = await family.admit(userId);
    return ADMISSIONS.has(out) ? out : 'deny';
  }

  async function decideVerdict(call: PolicyCall, s: { userId: string; text: string; via: 'name' | 'follow-up' }): Promise<TriggerVerdict> {
    const admission = await within(decideAdmission(call, s.userId), wait, 'deny' as Admission);
    if (admission === 'deny') return { kind: 'mention' };
    const text = String(s.text ?? '');
    // The words for Milo: after the name, or the whole sentence inside the window. A follow-up that holds the name is judged as named.
    let request: string;
    const named = HAS_NAME.test(text);
    if (s.via === 'name' || named) {
      const rest = addressedRequest(text);
      if (rest === null) return { kind: s.via === 'follow-up' ? 'aside' : 'mention' };
      request = rest;
    } else {
      // A fixed-lines person has no window: only a sentence with the name reaches their fixed lines.
      if (admission !== 'route' || followUpKind(text, rosterOf(call.callId)) === 'aside') return { kind: 'aside' };
      request = text;
    }
    if (parseCommand(request) === 'cancel') return { kind: 'mention' };
    const family = policyFor(call).handsfree?.(call);
    const held = family?.heldAnswer ? await family.heldAnswer({ askedBy: s.userId, text: request, admission }) : null;
    if (held !== null) return held.trim() ? { kind: 'fixed', line: held } : { kind: 'mention' };
    if (admission === 'route') return { kind: 'request' };
    return family?.refusal ? { kind: 'fixed', line: family.refusal } : { kind: 'mention' };
  }

  return {
    admit: (call, userId) => within(decideAdmission(call, userId), wait, 'deny'),
    verdict: (call, sentence) => decideVerdict(call, sentence).catch((): TriggerVerdict => ({ kind: 'mention' })),
    overlap: (heard, saying) => {
      try { return overlapOf(String(heard ?? ''), String(saying ?? '')); } catch { return 'unclear'; }
    },
  };
}

/** The family's rules for a hands-free session's instructions (instructions.ts `handsfree.familyRules`), or null. */
export function handsfreeFamilyRules(call: PolicyCall, policy: MeetingAssistantPolicy = policyForLobby(call.lobby)): string | null {
  try { return policy.handsfree?.(call).instructions() ?? null; } catch { return null; }
}
