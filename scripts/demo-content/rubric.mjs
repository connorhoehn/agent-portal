// The mechanical half of the demo-content rubric (docs/demo-content-goal.md).
// Pure functions, no I/O: the probe (portal/e2e/demo-content-probe.spec.ts)
// runs scanRendered over every page's visible text; the judge
// (scripts/validate-demo-content.sh, via scripts/demo-content/judge.mjs) runs
// scanSource over the fixtures and the program seed. A rule here is a pattern
// a peer would notice on screen; anything that needs reading the story stays
// in docs/demo-content-audit.md.

/** Rendered-text rules: each a name, a pattern, and the rubric letter it serves. */
export const RENDERED_RULES = [
  // (b) filler a peer reads as "not real"
  { rule: 'filler', letter: 'b', re: /\b(?:lorem|ipsum|foo|baz|qux|asdf|dummy|placeholder|xxx+|tbd)\b/gi },
  { rule: 'filler', letter: 'b', re: /\b(?:fact|sample|document|doc|example|user) \d{1,3}\b(?![.:%])/gi },
  { rule: 'filler', letter: 'b', re: /\bLoad-corpus\b|\btest (?:user|row|item|doc|run|data|record)s?\b|\bhello world\b/gi },
  { rule: 'more-leak', letter: 'b', re: /\(\+\d+ more\)/g },
  { rule: 'glued', letter: 'b', re: /[a-z]{3}[.!?][A-Z][a-z]{2,}/g },
  { rule: 'junk-literal', letter: 'b', re: /\b(?:undefined|NaN|Infinity)\b|\[object Object\]|\bnull\b(?! and)/g },
  // (d) raw ids, slugs and timestamps where a name or a relative time belongs
  { rule: 'raw-id', letter: 'd', re: /\b(?:p-\d{3}|u-(?:operator|theo|vera|hr|release|rachel|mia|nora|eli|layla|caleb|asha|jonas|farah|mira|lena|sana|ines|kofi|dara|tomas|rhea|omar|priya)(?:-clone-[0-9a-f]+)?|wi-[a-z0-9]+(?:-[a-z0-9]+)+|TEAM-\d{3}|des-[a-z]+(?:-[a-z]+)+|d-[a-z]{4,}(?:-[a-z]+)*|p-[a-z]+(?:-[a-z]+)+|(?:job|run|req|rev|sod|art|bot|deck)-[a-z0-9]{3,}(?:-[a-z0-9]+)*)\b/g },
  { rule: 'raw-id', letter: 'd', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g },
  { rule: 'raw-id', letter: 'd', re: /\b(?:social|orgiq|assessment|pipelines):(?:ch|dm|lobby|team):[\w:-]+/g },
  // timestamped or hash-suffixed run ids (run-20261015T164002Z-draft-review-deck-0ccaf2011b06, run-1760…, …-0ccaf2011b06): a run is shown by title, never by its ledger key
  { rule: 'raw-run-id', letter: 'd', re: /\b(?:run|job|req|rev)-\d{8}T?\d{0,6}Z?(?:-[a-z0-9]+)*\b/gi },
  { rule: 'raw-run-id', letter: 'd', re: /\b[a-z]{3,}(?:-[a-z]{2,})*-(?=\d*[a-f])[0-9a-f]{10,12}\b/g },
  { rule: 'raw-run-id', letter: 'd', re: /\b(?:run|job|exec|trace)[-_][0-9a-f]{8,}\b/gi },
  { rule: 'iso-time', letter: 'd', re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/g },
  { rule: 'iso-time', letter: 'd', re: /\b20\d{2}-[01]\d-[0-3]\d\b(?!T)/g },
  // (c) numbers that cannot be right
  { rule: 'bad-number', letter: 'c', re: /\b(?:10[1-9]|1[1-9]\d|[2-9]\d{2}|\d{4,})(?:\.\d+)?%|\$-\d|\bin -\d+|-\d+ (?:days?|hours?|minutes?) ago\b/g },
  // (g) copy written for a developer, not a customer
  { rule: 'dev-copy', letter: 'g', re: /\b(?:dev:mock|fixtures?|mock(?:ed)? (?:data|provider|mode|BFF|fixture)|seeded|stubbed?|payload|wire string|MOCK_[A-Z_]+|env var|localhost|127\.0\.0\.1|POST \/api|GET \/api|\/api\/[a-z])\b/gi },
];

/** Every rendered-text hit: { rule, letter, match, context }. */
export function scanRendered(text) {
  const hits = [];
  for (const { rule, letter, re } of RENDERED_RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (rule === 'glued' && /\b(?:e\.g|i\.e|vs|etc|Mr|Ms|Dr|St|No)\.[A-Z]/.test(text.slice(Math.max(0, m.index - 3), m.index + m[0].length))) continue;
      if (rule === 'glued' && /\.(?:[A-Z][a-z]+)\b/.test(m[0]) && /[\w-]+\.(?:md|ts|tsx|js|json|py|sql|yaml|yml|txt|csv|pdf|png)\b/i.test(text.slice(m.index, m.index + 30))) continue;
      const at = m.index ?? 0;
      hits.push({ rule, letter, match: m[0], context: text.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' ') });
      if (hits.length > 200) return hits;
    }
  }
  return hits;
}

/** Source rules over fixture string literals (only text a page can render). */
export const SOURCE_RULES = [
  { rule: 'filler', re: /\b(?:lorem|ipsum|foo|baz|qux|asdf|dummy|placeholder text|xxx+)\b/gi },
  { rule: 'filler', re: /\b(?:Fact|Item|Sample|Test|Example|Row|Document|Team|Story|Run|User|Person) \$\{\w+(?: \+ 1)?\}/g },
  { rule: 'filler', re: /\b(?:fact|sample|example) \d{1,3}\b(?![.:%])/gi },
  { rule: 'filler', re: /\bLoad-corpus\b|\btest (?:user|row|item|doc|run)s?\b/gi },
  { rule: 'more-leak', re: /\(\+\$\{[^}]+\} more\)|\(\+\d+ more\)/g },
];

/** Hits inside the string literals of one source text: { rule, match, line }. */
export function scanSource(src) {
  const hits = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--') || t.startsWith('#')) return;
    const literals = [...line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    for (const lit of literals) {
      if (lit.length < 4 || !/\s/.test(lit)) continue; // keys and enums are not copy
      for (const { rule, re } of SOURCE_RULES) {
        re.lastIndex = 0;
        for (const m of lit.matchAll(re)) hits.push({ rule, match: m[0], line: i + 1, text: lit.slice(0, 120) });
      }
    }
  });
  return hits;
}

/** A sentence's template: digits, quoted words and capitalised names folded, so "Fact 3" and "Fact 7" match. */
export const templateOf = (s) => s.toLowerCase().replace(/"[^"]*"|“[^”]*”|'[^']*'/g, '"…"').replace(/\d+(?:\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim();

/**
 * Repeated prose: every string of ≥ minLen characters whose template appears
 * more than `max` times across the given strings. One template repeated over
 * fifty evidence rows is filler however well the first one reads.
 */
export function repeatedTemplates(strings, { minLen = 40, max = 5 } = {}) {
  const by = new Map();
  for (const s of strings) {
    if (typeof s !== 'string' || s.length < minLen || !/\s/.test(s)) continue;
    // Split prose into sentences: a template is a sentence, not a paragraph.
    for (const sentence of s.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      if (sentence.length < minLen) continue;
      const t = templateOf(sentence);
      const e = by.get(t) ?? { template: t, example: sentence.slice(0, 140), n: 0 };
      e.n++; by.set(t, e);
    }
  }
  return [...by.values()].filter((e) => e.n > max).sort((a, b) => b.n - a.n);
}

/** Literal calendar dates in fixture copy (rule 3 covers ISO timestamps; these are the prose and slash forms it misses). */
export const LITERAL_DATE = /\b(?:20\d{2}-\d{2}-\d{2}(?!T)|\d{1,2}\/\d{1,2}\/20\d{2}|20\d{6}T\d{6}Z|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? 20\d{2})\b/g;
