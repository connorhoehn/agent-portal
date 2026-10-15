// The user-search catalog against the dev:mock seed (docs/user-search-goal.md judge 1).
// Run from middleware/ (the fixtures import from there):
//
//   cd middleware && npx tsx ../scripts/user-search-catalog.mts check     # integrity, prints ok|fail lines (TAB-separated)
//   cd middleware && npx tsx ../scripts/user-search-catalog.mts refresh   # rewrite the results' intents from the current catalog (probes untouched)
//
// `check`: every intent has ≥ 3 phrasings, a best surface, a persona whose seed
// grants hold the role, every `keys` id present in a fixture row and at least
// one `text` pattern matching a fixture row; ≥ 15 intents per tenant; every
// tenant × role has ≥ 3 intents; exactly five mapped intents per tenant.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env['MOCK_AURORA'] ??= 'true';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_FILE = resolve(ROOT, 'portal/e2e/user-search-catalog.ts');
const RESULTS = resolve(ROOT, 'docs/user-search-probe-results.json');
const { CATALOG, PERSONAS } = await import(CATALOG_FILE);
type Intent = (typeof CATALOG)[number];

const { serializeIntents } = await import(CATALOG_FILE);

const cmd = process.argv[2] ?? 'check';
if (cmd === 'refresh') {
  const data = JSON.parse(readFileSync(RESULTS, 'utf8'));
  // Only the catalog half: the probes stay as they were measured, and the
  // freshness digest is NOT touched — refreshing intents never makes old probes current.
  data.intents = serializeIntents(CATALOG);
  writeFileSync(RESULTS, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`refreshed ${CATALOG.length} intents`);
  process.exit(0);
}

// ── check ────────────────────────────────────────────────────────────────────
const out: string[] = [];
const ok = (t: string) => out.push(`ok\t${t}`);
const fail = (t: string) => out.push(`fail\t${t}`);
// Load every fixture module so the registry holds the whole seed, then read each default world.
const { fixtureRegistry } = await import(resolve(ROOT, 'middleware/src/mock/core/index.ts'));
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(resolve(ROOT, 'middleware/src/mock')).filter((n) => n.endsWith('.ts'))) {
  try { await import(resolve(ROOT, 'middleware/src/mock', f)); } catch { /* a module that needs the server; its fixtures load through the providers below */ }
}
for (const f of ['projects', 'work-items', 'decisions', 'distillation', 'prompt-library', 'access', 'social-platform', 'pipeline-definitions', 'pipeline-runs', 'bots', 'assessment']) {
  try { await import(resolve(ROOT, 'middleware/src/providers', `${f}.ts`)); } catch { /* optional */ }
}
const { listUsers } = await import(resolve(ROOT, 'middleware/src/providers/identity.ts'));
const rows: string[] = [];
for (const fx of fixtureRegistry.all()) { try { rows.push(JSON.stringify(fx.rows('default'))); } catch { /* a fixture whose default needs a request */ } }
const haystack = rows.join('\n');
const users = await listUsers();

const byTenant = new Map<string, Intent[]>();
for (const i of CATALOG) byTenant.set(i.tenant, [...(byTenant.get(i.tenant) ?? []), i]);
let bad = 0;
for (const i of CATALOG as Intent[]) {
  const problems: string[] = [];
  if (i.phrasings.length < 3) problems.push(`${i.phrasings.length} phrasings`);
  if (!i.bestSurface) problems.push('no best surface');
  const user = users.find((u: { id: string }) => u.id === i.persona);
  if (!user?.grants?.[i.tenant]?.includes(i.role)) problems.push(`persona ${i.persona} does not hold ${i.tenant}:${i.role}`);
  for (const k of i.expected.keys ?? []) { const id = k.slice(k.indexOf(':') + 1); if (!haystack.includes(`"${id}"`)) problems.push(`key ${k} is in no fixture row`); }
  if (!i.expected.text.some((r: RegExp) => new RegExp(r.source, r.flags.replace('g', '')).test(haystack))) problems.push(`no text pattern matches a fixture row (${i.expected.text.map((r: RegExp) => `/${r.source}/`).join(' ')})`);
  if (problems.length) { bad++; fail(`intent ${i.id}: ${problems.join('; ')}`); }
}
if (!bad) ok(`${CATALOG.length} intents: ≥ 3 phrasings, a best surface, a persona holding the role, keys and answers present in the seed`);
for (const [t, is] of byTenant) {
  const mapped = is.filter((i) => i.map).length;
  if (is.length >= 15) ok(`${t}: ${is.length} intents`); else fail(`${t}: ${is.length} intents (< 15)`);
  if (mapped === 5) ok(`${t}: 5 mapped intents`); else fail(`${t}: ${mapped} mapped intents (want 5)`);
}
for (const key of Object.keys(PERSONAS)) {
  const [t, r] = key.split(':');
  const n = CATALOG.filter((i: Intent) => i.tenant === t && i.role === r).length;
  if (n < 3) fail(`${key}: ${n} intents (< 3)`);
}
if (Object.keys(PERSONAS).every((key) => CATALOG.filter((i: Intent) => `${i.tenant}:${i.role}` === key).length >= 3)) ok(`every tenant × role (${Object.keys(PERSONAS).length}) has ≥ 3 intents`);
console.log(out.join('\n'));
process.exit(0);
