// Approved speech: words the server holds, said aloud on the call's own live session (docs/interviews-tenant-plan.md decision 9).
//
// The one gate and the one relay stay as they are (voice-gate.ts, voice.ts). What this adds is the check in front of them for ONE
// kind of utterance: the session is asked to say a text verbatim (session.ts `sayVerbatim`), and the utterance it produces is held,
// in memory, and checked against the session's own transcript of it. Only frames whose words the transcript has already shown to be
// the text's own words, in order, go to the gate, which opens for them with the reason `approved`: a frame goes out once it is
// APPROVED_STREAM_LAG_MS old and the transcript so far is still the start of the text (`saidSoFar`). The provider writes a word down
// before its audio arrives (measured in the 18 November film: the first words 90 to 390 ms ahead of the first voiced frame), so
// a frame that old is covered by the words checked. The moment the transcript stops being the start of the text (a word changed,
// added or run on) nothing more of the utterance is sent; once it is complete, the rest goes out only when it is the same words as
// the text (case, punctuation and spacing aside). No words, no audio, or nothing complete inside `sayBoundMs`: nothing more is sent.
// The voice starts within about half a second of the provider's first voiced frame, instead of after the whole utterance has
// streamed in (2 to 3 s for a one-sentence answer, measured in the same film).
//
// Pure: no clock, no session, no relay; the orchestrator (`sayHeldText`) does the holding and the sending.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: Array<[number, string]> = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1_000, 'thousand']];

function under1000(n: number): string {
  const out: string[] = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], 'hundred'); n %= 100; }
  if (n >= 20) { out.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]); }
  else if (n > 0 || !out.length) out.push(ONES[n]);
  return out.join(' ');
}

/** A whole number in words ("59" → "fifty-nine"); past a trillion, digit by digit. */
export function numberWords(digits: string): string {
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n >= 1_000_000_000_000) return digits.split('').map((d) => ONES[Number(d)]).join(' ');
  if (n === 0) return 'zero';
  const out: string[] = [];
  let rest = n;
  for (const [size, name] of SCALES) if (rest >= size) { out.push(under1000(Math.floor(rest / size)), name); rest %= size; }
  if (rest > 0) out.push(under1000(rest));
  return out.join(' ');
}

const ORDINAL_IRREGULAR: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** An ordinal in words ("21st" → "twenty-first"). */
export function ordinalWords(digits: string): string {
  const card = numberWords(digits);
  const m = /([a-z]+)$/.exec(card);
  if (!m) return card;
  const last = m[1];
  const ord = ORDINAL_IRREGULAR[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return card.slice(0, card.length - last.length) + ord;
}

/**
 * The text as it is read aloud: numbers, ordinals, decimals and "%" spelled out, everything else as written. Sent to the session in
 * place of the approved text, so the provider reads the words it is asked to (its transcript says numbers in words anyway).
 */
export function speakableText(text: string): string {
  return (text ?? '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+)\s*%/g, '$1 percent')
    .replace(/%/g, ' percent')
    .replace(/\b(\d+)\.(\d+)\b/g, (_m, a: string, b: string) => `${numberWords(a)} point ${b.split('').map((d) => ONES[Number(d)]).join(' ')}`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, d: string) => ordinalWords(d))
    .replace(/\d+/g, (d) => numberWords(d));
}

const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), 'hundred', 'thousand', 'million', 'billion', 'point']);

/**
 * The words of a text, for comparing what was asked with what was said: lower case, letters only, single spaces; numbers and "%"
 * in words, the unambiguous contractions expanded (n't, 're, 'll, 've, 'm), hyphens as spaces, "and" inside a number dropped.
 */
export function spokenWords(text: string | null | undefined): string {
  const t = speakableText((text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\bcannot\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\bshan't\b/g, 'shall not')
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\b([a-z]+)n't\b/g, '$1 not')
    .replace(/'re\b/g, ' are')
    .replace(/'ll\b/g, ' will')
    .replace(/'ve\b/g, ' have')
    .replace(/\bi'm\b/g, 'i am')
    .replace(/'/g, '');
  const words = t.replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.filter((w, i) => !(w === 'and' && NUMBER_WORDS.has(words[i - 1] ?? '') && NUMBER_WORDS.has(words[i + 1] ?? ''))).join(' ');
}

/**
 * Is what the session has said so far the start of these words? Its letters, word breaks ignored, are a non-empty prefix of the
 * text's (both sides normalised by spokenWords), so a word cut part way ("fif") still counts and anything changed or added does not.
 */
export function saidSoFar(asked: string, transcript: string | null | undefined): boolean {
  const b = spokenWords(transcript).replace(/ /g, '');
  return b.length > 0 && spokenWords(asked).replace(/ /g, '').startsWith(b);
}
/** How old a held frame of approved speech must be before it goes out, while the transcript so far is the start of the text. */
export const APPROVED_STREAM_LAG_MS = 400;
/**
 * The most audio one checked character may account for while the line streams (review 1, item 5): audio goes out only as far as
 * the words already checked could have taken to say, at a fast 20 characters a second (speech runs at about 15), so the audio
 * never runs ahead of the checked words, and a transcript that stops advancing stops the audio until it moves again.
 */
export const APPROVED_MS_PER_CHAR = 50;
/** Milliseconds of 24 kHz PCM16 mono audio in `bytes` (voice.ts). */
export const pcmMs = (bytes: number): number => bytes / 48;
/** The words of `checked` that `releasedMs` of audio can have carried, at APPROVED_MS_PER_CHAR (whole words only). */
export function heardPart(checked: string, releasedMs: number): string {
  const max = Math.floor(releasedMs / APPROVED_MS_PER_CHAR);
  const text = checked.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return at > 0 ? cut.slice(0, at) : '';
}
/**
 * Did the session say these words? The same words in the same order once both sides are normalised (spokenWords), or, failing
 * that, the same letters with the word breaks ignored ("failover" said as "fail over"). Any word added, dropped or changed still
 * fails: it errs on withholding. Empty never matches.
 */
export function saidVerbatim(asked: string, transcript: string | null | undefined): boolean {
  const a = spokenWords(asked);
  if (!a.length) return false;
  const b = spokenWords(transcript);
  return a === b || a.replace(/ /g, '') === b.replace(/ /g, '');
}

/**
 * What the session is sent for a line to say verbatim. Spoken context (`session.commentary.append`) on its own is something the voice
 * talks ABOUT: given an approved question it answered the question, and given the time left it said "Sure, and just so you know,
 * there's still about fifty-nine minutes left" (17 November, real provider). So the line goes as a quoted line to read aloud, and the
 * session's instructions (instructions.ts READ_ALOUD_RULE) say that such a line is read word for word and nothing else is said.
 */
export function readAloudContent(text: string): string {
  return `${READ_ALOUD_MARK} ${JSON.stringify(text.trim())}`;
}
/** The words that open every line the system hands the voice to read aloud. */
export const READ_ALOUD_MARK = 'READ ALOUD, word for word, exactly this line and nothing else:';

/** The shortest and longest time an approved utterance may take, from the request to its last frame and its final transcript. */
export const SAY_MIN_BOUND_MS = 8_000;
export const SAY_MAX_BOUND_MS = 45_000;
/** Allowed per character on top of the minimum (speech runs at about 15 characters a second; this is half that speed). */
export const SAY_MS_PER_CHAR = 70;

/**
 * How long an approved line may wait, unsent, for quiet (nobody speaking, nothing of Milo's running) before it stays in the chat
 * only: a repeat or a time answer said much later would interrupt what came after it. The bound (`sayBoundMs`) starts once it is sent.
 */
export const SAY_QUIET_WAIT_MS = 5_000;

/** How long the orchestrator waits for the utterance of `text` before it withholds it whole. */
export function sayBoundMs(text: string): number {
  return Math.min(SAY_MAX_BOUND_MS, SAY_MIN_BOUND_MS + SAY_MS_PER_CHAR * text.length);
}

/** What became of an approved utterance: relayed (`spoken`), or in chat only (`posted`); `no-call` when Milo has no run in the call. */
export type SayOutcome = 'spoken' | 'posted' | 'no-call';

/** Why an approved utterance was not relayed: codes only, for the trace and for the caller's receipt. */
export type SayWithheldWhy = 'empty' | 'no-say' | 'voice-off' | 'paused' | 'refused' | 'timeout' | 'not-quiet' | 'no-words' | 'mismatch' | 'no-audio' | 'not-relayed' | 'session-changed' | 'closed';

/** An approved utterance's outcome with why it was not relayed (null when it was, or when Milo has no run in the call). */
/** `partly`: some of its audio went out before it was cut (a later word did not match, or it was stopped): the words heard. */
export interface SayResult { outcome: SayOutcome; why: SayWithheldWhy | null; partly?: string }

/** The one plain sentence the lead reads when the words could not be said aloud. */
export const NOT_SAID_ALOUD = 'Milo could not say it aloud. The question is in the call chat.';
