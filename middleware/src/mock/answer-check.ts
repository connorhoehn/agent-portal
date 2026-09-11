// The offline judge — a real reading of a real answer, with no model.
//
// WHY THIS EXISTS. `lib/judge.ts` and `lib/harness-runner.ts`'s private
// `judge()` are both live Bedrock `Converse` calls. Offline they throw, both
// callers swallow the throw into `null`, and a `dev:mock` harness run therefore
// reported every case as unjudged: the pass/fail column was decided entirely by
// the deterministic tag check, the rubric editor on /iq/evaluations was
// decorative, and no judge branch was ever exercised.
//
// THE ONE THING THIS MUST NOT BE is a rubber stamp. A mock judge that returns
// 0.9 for any input is strictly worse than the 500 it replaces: it makes every
// harness run green, and the entire premise of the harness is that an answer is
// not trustworthy just because an agent produced it. So this is not a canned
// score — it is a small analyser that reads the answer it was actually handed,
// measures things that are actually in it, and reports the counts it measured.
// Its number then flows into the real thresholds unchanged: `runCase` still
// fails a case whose score is below the case's own `pass_threshold`, and
// `weightedComposite` still folds the dimensions using the operator's weights.
//
// WHAT IT MEASURES. Five properties of the (prompt, answer) pair, each of them
// a fact about the text:
//
//   1. COVERAGE — how many of the prompt's content words the answer actually
//      addresses. "Did it talk about what was asked?" This is the same device
//      `harness-runner.referenceSimilarity` already uses and defends: a cheap
//      lexical signal, called coverage rather than correctness so nobody
//      mistakes it for meaning.
//   2. SPECIFICITY — how many concrete anchors the answer contains: names,
//      numbers, ids. An answer with no name, no number and no id cannot be
//      checked against the graph by anyone, which is a real defect in an
//      organizational-intelligence answer and the closest an offline reader can
//      honestly get to "groundedness".
//   3. REFUSAL / ERROR SHAPE — whether the text is an apology, a "no data
//      available", or a stack-trace fragment. This is a CAP, not a component:
//      a refusal cannot score well however long and well-formatted it is.
//   4. CONCISION — length, banded. An 8-character answer and a 6,000-character
//      one are both failures of "concise and actionable for a business user".
//   5. STRUCTURE — list markers, headings, a table, or more than one sentence.
//      A single unpunctuated fragment is not an answer shaped like an answer.
//
// WHAT IT IS NOT. It is not a model and never claims to be: it reports itself
// as `offline/lexical-answer-check`, never as a Bedrock model id, so a judged
// row can always be told apart from one Nova scored. It CANNOT tell whether the
// people it names are the right people, whether a number is right, or whether
// the answer is true — which is the first thing the real system prompt asks
// for. It is a floor, not a substitute, and `POST /api/observability/
// calibration/runs` still refuses offline for exactly that reason: a
// mean-absolute-error against a judge nobody ran would be a fabrication.
//
// An empty answer is scored as NOTHING TO JUDGE (`null`), never as 0 — the same
// distinction `mock/observability.ts` draws for a blocked or errored row, where
// "judged badly" and "not judged" must stay different or a NULL-skipping
// percentile silently becomes a zero-averaging one.

import type { JudgeRubricDimension } from '../lib/judge-config.js';

/** The model id this judge records. Deliberately not a Bedrock model id. */
export const OFFLINE_JUDGE_MODEL = 'offline/lexical-answer-check';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * Words that carry no subject. Kept small and boring on purpose: a long list
 * would start deciding what a prompt is about, and the point of coverage is
 * that it does not.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'our', 'with', 'from', 'this',
  'that', 'they', 'have', 'has', 'had', 'was', 'were', 'been', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'does', 'did', 'doing',
  'about', 'into', 'over', 'under', 'than', 'then', 'them', 'their', 'there',
  'here', 'some', 'any', 'all', 'each', 'every', 'more', 'most', 'other',
  'please', 'give', 'show', 'tell', 'list', 'best', 'good', 'new', 'get',
]);

/** How many prompt terms coverage looks at. Deterministic prefix, not a sample. */
const MAX_TERMS = 24;

/** Content words of a piece of text: lowercase, ≥3 chars, not a stopword. */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * Does the answer address this term?
 *
 * Substring, plus a one-character singular/plural fold, for the same reason
 * `harness-runner.checkTags` matches case-insensitively: the term is a required
 * CONCEPT ("expertise", "scores"), and a check that fails on a trailing `s`
 * teaches the reader nothing about the answer.
 */
export function mentions(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true;
  if (term.length > 3 && term.endsWith('s') && haystack.includes(term.slice(0, -1))) return true;
  if (term.length >= 3 && haystack.includes(`${term}s`)) return true;
  return false;
}

// ─── Anchors ────────────────────────────────────────────────────────────────

const NUMBER_RE = /^\d+(?:[.,]\d+)?%?$/;
/** `p-obs-rollout`, `nova-pro-v1`, `sha-1a2b3c` — an id, not a hyphenated word. */
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const CAPITALISED_RE = /^[A-Z][a-z]{2,}$/;

/** Strip markdown and punctuation from the edges of a token. */
function bare(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9%]+$/, '');
}

/**
 * The concrete things an answer names: capitalised words that are not
 * sentence-initial (people, teams, products), numbers, and ids.
 *
 * Sentence-initial capitals are excluded because every sentence has one and
 * counting them would reward punctuation rather than substance.
 */
export function anchorsIn(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let sentenceStart = true;
  for (const token of (text ?? '').split(/\s+/)) {
    if (!token) continue;
    const word = bare(token);
    const endsSentence = /[.!?:]$/.test(token) || token.includes('\n');
    const atStart = sentenceStart;
    sentenceStart = endsSentence || /\n/.test(token);
    if (!word) continue;
    const isAnchor =
      NUMBER_RE.test(word)
      || ID_RE.test(word.toLowerCase()) && word.includes('-')
      || (!atStart && CAPITALISED_RE.test(word));
    if (!isAnchor) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(word);
  }
  return found;
}

/** Anchors needed before specificity saturates. Six names/numbers is a dense answer. */
const ANCHOR_TARGET = 6;

// ─── Refusal / error shape ──────────────────────────────────────────────────

const REFUSAL_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bi(?:'m| am)? ?(?:can(?:no|')?t|cannot|unable to)\b/i, label: 'a refusal' },
  { re: /\bi (?:do not|don't) have (?:access|enough|any|the)\b/i, label: 'a refusal' },
  { re: /\bno (?:information|data|results?|records?)\b/i, label: 'a not-found answer' },
  { re: /\bas an ai\b/i, label: 'a boilerplate disclaimer' },
  { re: /\bi(?:'m| am) sorry\b/i, label: 'an apology' },
  { re: /\b(?:exception|traceback|timed out|timeout after|failed:)\b/i, label: 'an error string' },
];

/** The score ceiling a refusal or an error string cannot rise above. */
const REFUSAL_CEILING = 0.15;

// ─── Measurement ────────────────────────────────────────────────────────────

export interface AnswerMeasurement {
  /** Nothing to judge — no verdict is produced for this. */
  empty: boolean;
  /** What the text reads as, when it reads as a non-answer. Null otherwise. */
  refusal: string | null;
  chars: number;
  askedTerms: string[];
  coveredTerms: string[];
  /** 0–1. Share of the prompt's content words the answer addresses. */
  coverage: number;
  anchors: string[];
  /** 0–1. Anchor density, saturating at `ANCHOR_TARGET`. */
  specificity: number;
  /** 0–1. Length, banded. */
  concision: number;
  /** 0–1. Shaped like an answer. */
  structure: number;
  /** Content words of the reference answer, when the caller supplied one. */
  referenceTerms: string[];
  referenceCovered: string[];
  /** 0–1, or null when there is no reference to compare against. */
  referenceCoverage: number | null;
}

function round3(n: number): number {
  return Number(n.toFixed(3));
}

function concisionOf(chars: number): number {
  if (chars === 0) return 0;
  if (chars < 80) return round3(chars / 80);
  if (chars <= 1500) return 1;
  return round3(Math.max(0.3, 1 - (chars - 1500) / 3000));
}

function structureOf(text: string): number {
  const markup = /(^|\n)\s*(?:[-*•]|\d+\.)\s/.test(text)
    || /\*\*/.test(text)
    || /(^|\n)#{1,6}\s/.test(text)
    || /\|[^\n]*\|/.test(text);
  if (markup) return 1;
  const sentences = (text.match(/[.!?](?:\s|$)/g) ?? []).length;
  if (sentences >= 2) return 0.75;
  if (sentences === 1) return 0.5;
  return 0.25;
}

/**
 * Read one answer. Pure, deterministic, and the only place any of these
 * numbers is computed — both callers score the same measurement so a trace and
 * a harness result can never disagree about the same text.
 */
export function measureAnswer(
  prompt: string,
  response: string,
  reference?: string | null,
): AnswerMeasurement {
  const text = (response ?? '').trim();
  const hay = text.toLowerCase();
  const askedTerms = contentTerms(prompt ?? '');
  const coveredTerms = askedTerms.filter((t) => mentions(hay, t));
  const anchors = anchorsIn(text);
  const referenceTerms = reference ? contentTerms(reference) : [];
  const referenceCovered = referenceTerms.filter((t) => mentions(hay, t));

  let refusal: string | null = null;
  for (const p of REFUSAL_PATTERNS) {
    if (p.re.test(text)) { refusal = p.label; break; }
  }

  return {
    empty: text.length === 0,
    refusal,
    chars: text.length,
    askedTerms,
    coveredTerms,
    // A prompt with no content words asks for nothing in particular, so there
    // is nothing the answer can fail to cover.
    coverage: askedTerms.length === 0 ? 1 : round3(coveredTerms.length / askedTerms.length),
    anchors,
    specificity: round3(Math.min(1, anchors.length / ANCHOR_TARGET)),
    concision: concisionOf(text.length),
    structure: structureOf(text),
    referenceTerms,
    referenceCovered,
    referenceCoverage: referenceTerms.length === 0
      ? null
      : round3(referenceCovered.length / referenceTerms.length),
  };
}

// ─── The verdict ────────────────────────────────────────────────────────────

/**
 * The blend `lib/judge.ts`'s fixed rubric asks for, mapped onto what an offline
 * reader can measure:
 *
 *   relevance to the prompt        → coverage        (0.40)
 *   groundedness (checkable facts) → specificity     (0.35)
 *   concise and actionable         → concision       (0.15)
 *                                    structure       (0.10)
 */
function blend(m: AnswerMeasurement): number {
  return 0.40 * m.coverage + 0.35 * m.specificity + 0.15 * m.concision + 0.10 * m.structure;
}

export interface OfflineVerdict {
  score: number;
  rationale: string;
}

/**
 * Score an answer, or return null when there is nothing to score.
 *
 * Null for an empty answer rather than 0: "not judged" and "judged badly" are
 * different rows, the schema makes `judge_score` nullable to keep them
 * different, and a percentile that skips a NULL would happily average in a 0.
 */
export function offlineVerdict(m: AnswerMeasurement): OfflineVerdict | null {
  if (m.empty) return null;
  const raw = blend(m);
  const score = m.refusal ? Math.min(raw, REFUSAL_CEILING) : raw;
  const parts = [
    `covers ${m.coveredTerms.length}/${m.askedTerms.length} asked terms`,
    `${m.anchors.length} concrete anchor${m.anchors.length === 1 ? '' : 's'}`,
    `${m.chars} chars`,
  ];
  if (m.referenceCoverage !== null) {
    parts.push(`${m.referenceCovered.length}/${m.referenceTerms.length} reference terms`);
  }
  if (m.refusal) parts.push(`reads as ${m.refusal}, capped at ${REFUSAL_CEILING}`);
  return {
    score: round3(Math.max(0, Math.min(1, score))),
    rationale: `${OFFLINE_JUDGE_MODEL}: ${parts.join('; ')}. No model was called.`.slice(0, 500),
  };
}

// ─── The operator's rubric ──────────────────────────────────────────────────

/**
 * Per-dimension scores on the 0–10 scale the harness judge speaks, for whatever
 * rubric keys the operator declared on /iq/evaluations.
 *
 * Each known key maps to the measurement that is honestly closest to it, and
 * the mapping is stated rather than implied:
 *
 *   helpfulness/relevance  — did it address the question, and is it shaped
 *                            like an answer.
 *   factuality/groundedness— how checkable it is (anchors), and how much of the
 *                            reference answer's vocabulary it reached. NOT
 *                            whether it is true; nothing offline can know that.
 *   tone/style/safety      — ABSTAINS unless there is something to say. A
 *                            refusal or an error string is a real tone failure
 *                            and is scored as one; register, warmth and hedging
 *                            are not measured at all, so for every other answer
 *                            the key is OMITTED rather than given full marks.
 *   conciseness/brevity    — length band and structure.
 *
 * Abstention is the whole difference between this and a rubber stamp. Awarding
 * 10/10 for a dimension nothing was measured on hands the answer that
 * dimension's entire weight for free — with the default rubric that is 20% of
 * the composite, enough to lift an answer covering two of eight asked terms
 * over a 0.65 pass threshold, which is precisely the "make a broken thing look
 * green" failure. `weightedComposite` renormalises over the dimensions it was
 * given scores for, so an omitted key costs the composite nothing and buys the
 * answer nothing. An empty result means nothing at all could be measured, and
 * the caller must report "not judged" rather than 0.
 *
 * An unrecognised key gets the same blend `offlineVerdict` uses, so a custom
 * rubric dimension still moves with the answer instead of being dropped.
 */
export function offlineRubricScores(
  m: AnswerMeasurement,
  dims: JudgeRubricDimension[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dims) {
    const key = d.key.toLowerCase();
    let unit: number;
    if (/help|relevan|complete|useful/.test(key)) {
      unit = 0.6 * m.coverage + 0.4 * m.structure;
    } else if (/fact|ground|accura|correct|hallucin/.test(key)) {
      unit = m.referenceCoverage === null
        ? m.specificity
        : 0.5 * m.specificity + 0.5 * m.referenceCoverage;
    } else if (/tone|style|safe|polite/.test(key)) {
      if (!m.refusal) continue; // abstain — nothing offline can hear register
      unit = 0.2;
    } else if (/concis|brev|length/.test(key)) {
      unit = 0.7 * m.concision + 0.3 * m.structure;
    } else {
      unit = blend(m);
    }
    if (m.refusal) unit = Math.min(unit, REFUSAL_CEILING * 2);
    out[d.key] = Number((Math.max(0, Math.min(1, unit)) * 10).toFixed(2));
  }
  return out;
}

/** The one-sentence rationale a rubric-scored answer carries. */
export function offlineRubricRationale(m: AnswerMeasurement): string {
  const bits = [
    `covers ${m.coveredTerms.length}/${m.askedTerms.length} asked terms`,
    `${m.anchors.length} anchors`,
    m.referenceCoverage === null
      ? 'no reference answer'
      : `${m.referenceCovered.length}/${m.referenceTerms.length} reference terms`,
    `${m.chars} chars`,
  ];
  if (m.refusal) bits.push(`reads as ${m.refusal}`);
  return `${OFFLINE_JUDGE_MODEL}: ${bits.join('; ')}. No model was called.`.slice(0, 500);
}
