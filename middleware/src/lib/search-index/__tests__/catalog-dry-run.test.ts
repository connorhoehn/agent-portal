// A fast, browser-free view of the user-search catalog against one tenant's
// projection: every phrasing of every intent goes through `searchTenant` as the
// intent's persona (authz mocked open, so ACL is NOT judged here), and the top
// rows are matched against the intent's expected text, the way the palette
// probe grades a record option. Skipped unless SEARCH_DRYRUN names a tenant.
//
//   SEARCH_DRYRUN=access npx jest src/lib/search-index/__tests__/catalog-dry-run.test.ts
//   SEARCH_DRYRUN=social SEARCH_DRYRUN_VERBOSE=1 ...   (print the top rows of every miss)
//
// The catalog is read from docs/user-search-probe-results.json (the intents the
// last probe ran: phrasings, expected text, persona, best surface).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { __resetSearchIndex } from '../registry.js';
import { searchTenant } from '../tenant-query.js';

const tenant = process.env['SEARCH_DRYRUN'] as 'assessment' | 'social' | 'pipelines' | 'access' | undefined;
const run = tenant ? describe : describe.skip;

interface CatalogIntent { id: string; tenant: string; role: string; persona: string; phrasings: string[]; bestSurface: string; cloneBlind?: string; expected: { text: Array<{ source: string; flags: string }>; wrong?: Array<{ source: string; flags: string }> } }

run(`catalog dry run: ${tenant}`, () => {
  beforeAll(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });
  test('every phrasing', async () => {
    const data = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/user-search-probe-results.json'), 'utf8')) as { intents: CatalogIntent[] };
    const rows: string[] = [];
    let intentsHit = 0, intents = 0;
    for (const intent of data.intents.filter(i => i.tenant === tenant)) {
      intents++;
      const res = intent.expected.text.map(t => new RegExp(t.source, t.flags));
      let hit = 0;
      const misses: string[] = [];
      for (const q of intent.phrasings) {
        const out = await searchTenant(tenant!, { sub: intent.persona, tenant: tenant!, role: intent.role }, { q, limit: 8 });
        const texts = out.results.map(r => `${r.kind} ${r.title} ${r.subtitle ?? ''} ${r.description ?? ''}`);
        if (texts.some(t => res.some(r => r.test(t)))) hit++;
        else misses.push(`    "${q}" -> ${out.results.length ? out.results.slice(0, 3).map(r => `${r.type}:${r.id} ${r.title}`).join(' | ') : '(nothing)'}`);
      }
      if (hit) intentsHit++;
      rows.push(`${hit ? 'ok  ' : 'MISS'} ${intent.id.padEnd(26)} ${hit}/${intent.phrasings.length} (best: ${intent.bestSurface})${hit < intent.phrasings.length && process.env['SEARCH_DRYRUN_VERBOSE'] ? `\n${misses.join('\n')}` : ''}`);
    }
    console.log(`${tenant}: ${intentsHit}/${intents} intents reach their record in the top 8\n${rows.join('\n')}`);
  });
});
test('dry run is opt-in', () => { expect(true).toBe(true); });
