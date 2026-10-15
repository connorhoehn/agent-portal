// Deterministic, explainable text similarity (design §2.4 "Dedupe"): normalised
// token sets and Jaccard, the same choice providers/promotions.ts made. No
// embeddings in v1. Used by the linter (R-single-subject), the selector
// (keyword overlap) and proposal dedupe ("Looks like rb-x (0.62: shares …)").
import type { RunbookDoc, RunbookScope } from './types.js';

const STOP = new Set(`a an the of to in on for from with without and or nor not no by at as is are was were be been being it its
this that these those your you we our they their them he she his her i me my before after into onto over under only one every each
any all then than when while so if but do does did done can could should would will shall may might must also just very via per
about above below up down out off again once there here what which who whom whose how why where s t don isn doesn same such own
more most other some both few new now use using`.split(/\s+/).filter(Boolean));

/** One normalised token: lowercase, possessive and plural stripped, -ing/-ed folded. Crude on purpose — explainable beats clever. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ed')) w = undouble(w.slice(0, -2));
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}
function undouble(w: string): string {
  return /(tt|pp|nn|gg|mm)$/.test(w) ? w.slice(0, -1) : w;
}

/** The ordered, de-duplicated content tokens of a text. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (raw.length < 2) continue;
    const lower = raw.toLowerCase();
    if (STOP.has(lower)) continue;
    // camelCase / snake identifiers split above only on non-alphanumerics; keep them whole.
    const t = stem(raw);
    if (t.length < 2 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Jaccard over the normalised token sets of two texts, in [0, 1], rounded to 4 places. */
export function similarity(a: string | readonly string[], b: string | readonly string[]): number {
  const A = new Set(Array.isArray(a) ? a : tokens(a as string));
  const B = new Set(Array.isArray(b) ? b : tokens(b as string));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return round4(inter / (A.size + B.size - inter));
}

/** Tokens both texts share, in the order they appear in `a`. */
export function sharedTokens(a: string | readonly string[], b: string | readonly string[]): string[] {
  const A = Array.isArray(a) ? a : tokens(a as string);
  const B = new Set(Array.isArray(b) ? b : tokens(b as string));
  return A.filter((t) => B.has(t));
}

/** What a runbook is ABOUT for matching: title + use_when + every trigger list. */
export function runbookTerms(doc: RunbookDoc): string[] {
  return tokens([
    doc.title, ...doc.use_when, ...doc.triggers.keywords, ...doc.triggers.work_item_labels, ...doc.triggers.tools,
  ].join(' '));
}

/** Two scopes overlap when they are the same scope, or either is org-wide. */
export function scopesOverlap(a: RunbookScope, b: RunbookScope): boolean {
  if (a.kind === 'org' || b.kind === 'org') return true;
  return a.kind === b.kind && (a.ref ?? '') === (b.ref ?? '');
}

export interface SimilarRunbook { runbook_id: string; score: number; reason: string }

/** Default dedupe threshold for a `new` proposal against published runbooks (design §2.4). */
export const DEDUPE_THRESHOLD = 0.5;

/**
 * Published runbooks in an overlapping scope that look like `doc`, best first
 * (score desc, then id). The reason names the shared terms, so a reviewer sees
 * why: "shares tenant, cutover, cognito".
 */
export function findSimilar(
  doc: RunbookDoc,
  scope: RunbookScope,
  candidates: ReadonlyArray<{ runbook_id: string; scope: RunbookScope; doc: RunbookDoc }>,
  threshold: number = DEDUPE_THRESHOLD,
): SimilarRunbook[] {
  const mine = runbookTerms(doc);
  const out: SimilarRunbook[] = [];
  for (const c of candidates) {
    if (!scopesOverlap(scope, c.scope)) continue;
    const theirs = runbookTerms(c.doc);
    const score = similarity(mine, theirs);
    if (score < threshold) continue;
    out.push({ runbook_id: c.runbook_id, score, reason: `shares ${sharedTokens(mine, theirs).slice(0, 6).join(', ')}` });
  }
  return out.sort((x, y) => y.score - x.score || (x.runbook_id < y.runbook_id ? -1 : x.runbook_id > y.runbook_id ? 1 : 0));
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
