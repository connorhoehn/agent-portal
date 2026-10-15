// Which local intent a question asks, if any. Pure and import-free (apart from
// the scope type) so routes/agents.ts can decide "local or agent" before it
// loads a single provider module — a question that matches nothing never pays
// for, or depends on, the data layer.
//
// The matcher is deliberately narrow: a bounded set of question forms over the
// program data. Anything else falls through to the agent path unchanged, which
// is the honest outcome for a question these rows cannot answer.

import type { AnswerScope } from './scope.js';

export type LocalIntent = 'budget' | 'spend' | 'status' | 'owners' | 'work' | 'sprints';

export interface IntentMatch {
  intent: LocalIntent;
  /** Which status facets the question names (blocked / critical / behind). */
  facets: { blocked: boolean; critical: boolean; behind: boolean };
}

/** LOCAL_ANSWERS (default on): `false` sends every question to the agent path. */
export function localAnswersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['LOCAL_ANSWERS'] ?? 'true').trim().toLowerCase() !== 'false';
}

// A request to change something is not a question about the data — the
// composer asks advise-only, and these never become a local read-out.
const IMPERATIVE_RE = /^\s*(?:please\s+)?(?:create|add|move|assign|reassign|change|update|edit|delete|remove|dispatch|start|run|approve|set|allocate|grant|cancel|close|reopen|draft|write)\b/i;

const MONEY_RE = /\b(?:budgets?|allocat(?:ion|ions|ed)|over\s*spen[dt]|overspen(?:d|t|ding)|unbudgeted|unallocated|maintenance floor)\b/i;
const MONEY_SHAPE_RE = /\b(?:over|overruns?|under|near(?:ly)?|close to|within|exceed(?:s|ed|ing)?|above|blown|burn(?:ed|t|ing)?)\b|\bunbudgeted\b|\bno (?:budget|allocation)\b|\bmaintenance\b/i;
const SPEND_RE = /\bspen(?:d|t|ding)\b|\bburn(?:ed|t)?\b|\bcost (?:so far|this month|mtd)\b/i;
const SPEND_SHAPE_RE = /\bhow much\b|\bwhat (?:did|has|is)\b|\btotal\b|\bthis month\b|\bmtd\b|\bso far\b|\bmost\b|\btop\b/i;
const PROGRAM_NOUN_RE = /\b(?:initiatives?|projects?|programs?|programmes?)\b/i;
const BLOCKED_RE = /\bblock(?:ed|ers?|ing)?\b|\bstuck\b/i;
const CRITICAL_RE = /\bcritical\b|\burgent\b|\bp0\b|\bon fire\b/i;
const BEHIND_RE = /\bbehind\b|\blate\b|\bslipp(?:ing|ed)\b|\bat risk\b|\boff track\b|\bon track\b/i;
const SPRINT_RE = /\bsprints?\b/i;
const OWNER_RE = /\bwho(?:'s| is| are)?\b[^?]*\b(?:owns?|runs?|leads?|steward(?:s|ing)?|on|working on|works? on|accountable for|responsible for|in charge of)\b|\bowners?\b|\bcontributors? (?:on|to|of)\b|\bsmes?\b/i;
const OPEN_WORK_RE = /\b(?:open|left|remaining|outstanding|in progress|in flight|to do|todo)\b|\bwork items?\b|\bbugs?\b|\bstories\b/i;
const WHAT_ON_RE = /\bwhat(?:'s| is| are)?\b[^?]*\b(?:on|for|in)\b/i;

/**
 * The intent a question asks, or null when none of the supported forms fit.
 * `hasEntity` says whether the question names an initiative the caller could
 * resolve (the scope's own initiative counts) — "who owns it?" with nothing to
 * own is not a local question.
 */
export function matchIntent(question: string, scope: AnswerScope | null, hasEntity = false): IntentMatch | null {
  const q = question.trim();
  if (!q || q.length > 2_000 || IMPERATIVE_RE.test(q)) return null;
  const facets = { blocked: BLOCKED_RE.test(q), critical: CRITICAL_RE.test(q), behind: BEHIND_RE.test(q) };
  const scoped = scope != null;
  const subject = hasEntity || (scope != null && scope.kind !== 'initiatives');
  const programWide = PROGRAM_NOUN_RE.test(q) || scope?.kind === 'initiatives';

  if (MONEY_RE.test(q) && (MONEY_SHAPE_RE.test(q) || programWide || subject)) return { intent: 'budget', facets };
  if (SPRINT_RE.test(q)) return { intent: 'sprints', facets };
  if (SPEND_RE.test(q) && (SPEND_SHAPE_RE.test(q) || subject || programWide)) return { intent: 'spend', facets };
  if (OWNER_RE.test(q) && /\bwho\b|\bowners?\b|\bcontributors?\b|\bsmes?\b/i.test(q) && (subject || programWide)) {
    return { intent: 'owners', facets };
  }
  const anyFacet = facets.blocked || facets.critical || facets.behind;
  if (subject && (anyFacet || OPEN_WORK_RE.test(q) || WHAT_ON_RE.test(q) && /\bopen|work|items?|bugs?|stories\b/i.test(q))) {
    return { intent: 'work', facets };
  }
  if (anyFacet && (programWide || scoped || /\b(?:which|what)\b/i.test(q))) return { intent: 'status', facets };
  return null;
}

/** Words that never identify one initiative on their own ("platform", "system"). */
const GENERIC = new Set(['platform', 'system', 'systems', 'app', 'application', 'pipeline', 'program', 'project', 'initiative', 'migration', 'the', 'and', 'of', 'for', 'data', 'design', 'network']);

/**
 * The initiatives a question names: by exact name, by id, or by a distinctive
 * first word ("observability", "inference") that names exactly one of them.
 * Longest name first so "Design System API" wins over "Design System v3".
 */
export function initiativesNamed<T extends { id: string; name: string }>(question: string, initiatives: T[]): T[] {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
  const has = (phrase: string) => phrase.length > 0 && q.includes(` ${phrase} `);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, ' ').trim();
  const out: T[] = [];
  const byLength = [...initiatives].sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    const name = norm(p.name);
    if (has(name) || has(p.id.toLowerCase()) || has(norm(p.id.replace(/^p-/, '').replace(/-/g, ' ')))) {
      if (!out.some(o => norm(o.name).includes(name))) out.push(p);
    }
  }
  if (out.length) return out;
  // A distinctive first word, unique across the portfolio.
  const firstWords = new Map<string, T[]>();
  for (const p of initiatives) {
    const w = norm(p.name).split(' ')[0] ?? '';
    if (w.length < 5 || GENERIC.has(w)) continue;
    firstWords.set(w, [...(firstWords.get(w) ?? []), p]);
  }
  for (const [w, ps] of firstWords) if (ps.length === 1 && has(w)) out.push(ps[0]!);
  return out;
}
