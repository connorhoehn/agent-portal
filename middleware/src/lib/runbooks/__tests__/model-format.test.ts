// lib/runbooks render ⇄ parse: the canonical markdown round-trips exactly —
// over every seed runbook (the model's own good fixtures, plus lane C's
// mock/runbooks.seed.ts once it exists) and over generated docs built from
// the strings most likely to break a line-based parser.
import { formatProblems, parseRunbook, renderRunbook, RunbookFormatError, RunbookParseError, tryParseRunbook } from '../index.js';
import type { RunbookDoc } from '../types.js';
import { tenantCutoverV2 } from './fixtures/good.js';
import { seedDocs } from './fixtures/seeds.js';

describe('round-trip', () => {
  it('round-trip: every seed runbook — parseRunbook(renderRunbook(doc)) deep-equals doc, and the markdown is a fixed point', () => {
    const docs = seedDocs();
    expect(docs.length).toBeGreaterThanOrEqual(4);
    for (const [label, doc] of docs) {
      expect([label, formatProblems(doc)]).toEqual([label, []]);
      const md = renderRunbook(doc);
      expect([label, parseRunbook(md)]).toStrictEqual([label, doc]);
      expect(renderRunbook(parseRunbook(md))).toBe(md);
    }
  });

  it('round-trip: with a header and provenance, the doc is unchanged (presentation is never parsed into it)', () => {
    const md = renderRunbook(tenantCutoverV2, {
      id: 'rb-tenant-cutover', version: 2, scope_label: 'Auth Migration', owner_name: 'Vera Green',
      provenance: 'Distilled from runs on wi-auth-e2-s2.\nv2 added step 2 after a run failed at the flip.',
    });
    expect(md).toContain('> Runbook rb-tenant-cutover · v2 · Auth Migration · owner Vera Green');
    expect(md).toContain('## Where this came from');
    const r = tryParseRunbook(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc).toStrictEqual(tenantCutoverV2);
      expect(r.header).toEqual(['> Runbook rb-tenant-cutover · v2 · Auth Migration · owner Vera Green']);
      expect(r.provenance).toMatch(/^Distilled from runs/);
    }
  });

  it('renders the design §2.2 shape a person reads', () => {
    const md = renderRunbook(tenantCutoverV2);
    expect(md).toMatchInlineSnapshot(`
"# Cut one tenant over from SAML to Cognito

Move one customer tenant's sign-in from the legacy SAML shim to Cognito without signing anyone out, with a five-minute way back.

## Use when

- You are cutting over a single tenant on the Auth Migration initiative.

## Not for

- Deleting the SAML shim: do that only after the last tenant (see the d-legacy-auth decision).

## Before you start

- [ ] The tenant's Cognito app client exists and you know its id (\`$CLIENT_ID\`).
- [ ] The SAML shim is still running behind the per-tenant flag.
- [ ] You know the tenant's portal origin (\`$ORIGIN\`).

## Steps

1. **Confirm sign-in works on the shim before you touch anything.**
   \`\`\`bash
   curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled
   \`\`\`
   Expect \`false\` (the tenant is still on the shim).
2. **Add the Cognito callback for this tenant's origin to its app client.**
   \`\`\`bash
   aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \\
     --client-id "$CLIENT_ID" --callback-urls "$ORIGIN/api/auth/callback"
   \`\`\`
   Expect the response's \`CallbackURLs\` to list \`$ORIGIN/api/auth/callback\`.
   *Why: The second pilot run failed at the flip because the redirect still pointed at the old domain.*
3. **Flip only this tenant's flag, never several tenants in one change.**
4. **Sign in as a test user of this tenant and check no live session was dropped.**
   Expect sign-in on the first try and zero forced logouts in the session log.

## Verify

- \`GET $ORIGIN/api/auth/config\` reports \`ssoEnabled: true\`.
  \`\`\`bash
  curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled
  \`\`\`
- No \`session_epoch\` bump for this tenant's existing users.

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| Sign-in bounces to the old service | Callback list not updated (step 2 skipped) | Roll back, then redo step 2 |
| Users signed out mid-day | Flag flipped for more than one tenant | Roll back every tenant flipped in that change |

## Roll back

1. Flip this tenant's flag back, and the shim answers within one grants refresh (about 2 minutes).

## Selection hints

- Labels: decom, runbook, cutover
- Repos: orgiq-auth-service
- Tools: cognito
- Keywords: tenant, cutover, saml, cognito, sign-in

## Notes

Cutover order between tenants is still escalated (d-cognito-cutover).
Treat the order as a parameter; this runbook covers one tenant.
"
`);
  });
});

// ── Property-style: generated docs from adversarial pools ──────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINES = [
  'Confirm the flag is off.', 'Run the migration with `--dry-run` first', 'a | b | c', 'back\\slash and pipe \\| here',
  '**bold** inside', 'ends with stars**', '**starts with stars', 'Expect nothing', '*Why: not a why*', '- looks like a bullet',
  '1. looks like an item', '## looks like a heading', '> looks like a quote', 'unicode — ✓ “quotes” café', 'tabs\tinside',
  'semi; colon', '`code` at the start', 'x', '[ ] a box', '[x] checked', ': leading colon', 'trailing colon:', 'Labels: not a hint',
];
const SUMMARIES = ['One sentence about what this does.', 'Move a tenant — safely.', 'x', 'Uses `cmd` | pipes and \\ slashes.'];
const COMMANDS = [
  'echo hi', 'curl -s "$ORIGIN/api/auth/config" | jq .', 'line one\n\nline three after a blank', '  indented first line\nsecond',
  'has ``` a fence inside\nand ```` a longer one', '## not a heading\n1. not an item\n- not a bullet', 'trailing spaces   \n   \nend',
  'SELECT 1;', 'GET /api/runbooks', '\ttab first',
];
const WORDS = ['tenant', 'cutover', 'sso', 'aurora-data-api', 'orgiq-auth-service', 'cognito', 'p-auth-migration'];
const NOTES = ['A note.', 'Line one.\n\n## A heading inside notes\n\n- a list\n\n```bash\necho inside notes\n```', '  indented first line\nthen more'];

function genDoc(r: () => number): RunbookDoc {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const some = <T,>(xs: readonly T[], max: number): T[] => Array.from({ length: Math.floor(r() * (max + 1)) }, () => pick(xs));
  const maybe = <T,>(v: T): T | undefined => (r() < 0.5 ? v : undefined);
  const cmd = () => ({ lang: pick(['bash', 'sql', 'http', 'text'] as const), text: pick(COMMANDS) });
  const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const doc: RunbookDoc = {
    title: pick(LINES),
    summary: pick(SUMMARIES),
    use_when: some(LINES, 3),
    not_for: some(LINES, 2),
    triggers: { work_item_labels: some(WORDS, 3), repos: some(WORDS, 2), tools: some(WORDS, 2), keywords: some(WORDS, 4) },
    preconditions: some(LINES, 3),
    // Up to 12 steps, so the two-digit marker ("10. ") indentation is exercised.
    steps: Array.from({ length: Math.floor(r() * 13) }, () => strip({ do: pick(LINES), command: maybe(cmd()), expect: maybe(pick(LINES)), why: maybe(pick(LINES)) })),
    verify: Array.from({ length: Math.floor(r() * 3) }, () => strip({ check: pick(LINES), command: maybe(cmd()) })),
    failure_modes: Array.from({ length: Math.floor(r() * 3) }, () => ({ symptom: pick(LINES), cause: pick(LINES), response: pick(LINES) })),
    rollback: Array.from({ length: Math.floor(r() * 3) }, () => strip({ do: pick(LINES), command: maybe(cmd()) })),
  };
  if (r() < 0.5) doc.notes = pick(NOTES);
  return doc;
}

describe('round-trip: property', () => {
  it('round-trip: property — 500 generated docs survive render → parse → render byte-for-byte', () => {
    const r = rng(20261014);
    let checked = 0;
    for (let k = 0; k < 500; k += 1) {
      const doc = genDoc(r);
      const problems = formatProblems(doc);
      if (problems.length > 0) { expect(() => renderRunbook(doc)).toThrow(RunbookFormatError); continue; }
      const md = renderRunbook(doc);
      const back = parseRunbook(md);
      expect(back).toStrictEqual(doc);
      expect(renderRunbook(back)).toBe(md);
      checked += 1;
    }
    // Generated summaries never start like a heading, so most docs are renderable; the bound proves the property ran.
    expect(checked).toBeGreaterThan(300);
  });
});

describe('format guards', () => {
  it('refuses to render what could not parse back exactly', () => {
    expect(formatProblems({ ...tenantCutoverV2, summary: 'two\nlines' })).toContain('summary spans lines');
    expect(formatProblems({ ...tenantCutoverV2, title: ' padded' })).toContain('title has leading or trailing whitespace');
    expect(formatProblems({ ...tenantCutoverV2, triggers: { ...tenantCutoverV2.triggers, keywords: ['a,b'] } })).toContain('triggers.keywords[0] contains a comma');
    expect(formatProblems({ ...tenantCutoverV2, notes: '\nleading blank' })).toContain('notes has leading blank lines or trailing whitespace');
    expect(() => renderRunbook({ ...tenantCutoverV2, summary: '# heading' })).toThrow(RunbookFormatError);
  });

  it('reads hand-written markdown leniently but never drops a line', () => {
    const md = [
      '# Restart the collector', '', 'Restart one collector without dropping spans.', '',
      '## Steps', '', '1. Drain the collector first.', '   Expect: zero in-flight batches.', '2. **Restart it.**', '   ```sh', '   kubectl rollout restart ds/collector', '   ```', '',
      '## Verify', '', '* Spans arrive again.', '',
      '## Before you start', '', '- [x] You are on call.',
    ].join('\r\n');
    const doc = parseRunbook(md);
    expect(doc.steps).toEqual([
      { do: 'Drain the collector first.', expect: 'zero in-flight batches.' },
      { do: 'Restart it.', command: { lang: 'bash', text: 'kubectl rollout restart ds/collector' } },
    ]);
    expect(doc.preconditions).toEqual(['You are on call.']);
    expect(doc.verify).toEqual([{ check: 'Spans arrive again.' }]);

    const bad = tryParseRunbook('# T\n\nSummary.\n\n## Steps\n\n1. **Do it.**\n   stray prose under a step\n\n## Mystery\n\n- x\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.line)).toEqual([8, 10]);
      expect(bad.errors[1]!.message).toMatch(/unknown section "## Mystery"/);
    }
    expect(() => parseRunbook('no title')).toThrow(RunbookParseError);
  });
});
