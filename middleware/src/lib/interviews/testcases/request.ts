// The candidate's request for test cases, read from the whole utterance (docs/interviews-tenant-plan.md, "Milo writes test
// cases"; the same way speak/index.ts reads "repeat the question"): a short request with at most a greeting, Milo's name, a
// "can you" and a "please" around it, a verb such as "generate" or "add", an amount, and "test cases" or "tests". A sentence
// that merely mentions tests ("my tests are failing", "how should I test this?") is not one.
//
// The amount: a number (digits or words up to twenty), "a dozen" (12), "half a dozen" (6), "a couple" (2), "a few" (5);
// anything else, or none, is the default. It is capped, so a request never costs more than MAX_TEST_CASES cases' worth.

/** What Milo writes when the request names no amount. */
export const DEFAULT_TEST_CASES = 12;
/** The most Milo writes for one request. */
export const MAX_TEST_CASES = 20;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const NUMBER = `(?:\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

const LEAD = String.raw`(?:(?:um|uh|sorry|so|ok|okay|hey|hi|and|but|also)\s+)*(?:(?:hey\s+)?milo\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+|i\s+(?:would\s+like|d\s+like|need|want)\s+|id\s+like\s+)?`;
const VERB = String.raw`(?:generate|write|add|give\s+me|make|create|come\s+up\s+with|suggest|put\s+in|get\s+me|do|show\s+me)`;
const AMOUNT = String.raw`(?:(?:another|some\s+more|a\s+few\s+more|a\s+few|some|a\s+couple(?:\s+of)?(?:\s+more)?|(?:half\s+a|another|a|${NUMBER})\s+dozen|${NUMBER})\s+)`;
const KIND = String.raw`(?:(?:more|extra|additional|new|other|edge)\s+)*(?:test\s*cases?|tests?|testcases?)`;
const TAIL = String.raw`(?:\s+(?:for\s+me|please|milo|thanks|thank\s+you|for\s+(?:this|it)|for\s+(?:the|my)\s+(?:code|solution|function|problem|question)|(?:to|in|into|at\s+the\s+(?:bottom|end)\s+of)\s+the\s+pad|too|as\s+well))*`;
const TESTS = new RegExp(`^${LEAD}${VERB}\\s+${AMOUNT}?${KIND}${TAIL}$`);

/** Lower case, punctuation as spaces (apostrophes dropped), one space between words: as speak/index.ts reads an utterance. */
const utterance = (text: string): string => text.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** How many test cases the words ask for, within 1 and MAX_TEST_CASES. */
export function amountOf(text: string): number {
  const t = utterance(text);
  const n = /\b(\d{1,3})\b/.exec(t)?.[1] ?? Object.keys(NUMBER_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  const asked = n === undefined ? null
    : /^\d+$/.test(n) ? Number.parseInt(n, 10) : NUMBER_WORDS[n]!;
  const counted = asked !== null && !/\bdozen\b/.test(t) ? asked
    : /\bhalf\s+a\s+dozen\b/.test(t) ? 6
    : /\bdozen\b/.test(t) ? 12 * (asked ?? 1)
    : /\bcouple\b/.test(t) ? 2
    : /\bfew\b/.test(t) ? 5
    : DEFAULT_TEST_CASES;
  return Math.max(1, Math.min(MAX_TEST_CASES, counted));
}

/** Is this utterance (the words after Milo's name, or the whole line) a request for test cases? With how many when it is. */
export function testCaseRequestOf(text: string): { count: number } | null {
  const t = utterance(text);
  return TESTS.test(t) ? { count: amountOf(t) } : null;
}

/** A count as Milo says it: words up to twenty ("twelve"), digits past that. */
export function countWords(n: number): string {
  const word = Object.entries(NUMBER_WORDS).find(([, v]) => v === n)?.[0];
  return word ?? String(n);
}
