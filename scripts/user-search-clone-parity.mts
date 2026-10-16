// Clone parity (docs/user-search-goal.md judge 7): every "mine"-scoped catalog
// intent answers the same for the seed persona and for a fresh clone of it —
// "my / me" is keyed by the person (lib/record-owner.ts), never the session's
// user id. Runs in-process against the dev:mock fixtures; prints ok|fail|note
// lines (TAB-separated) for scripts/validate-user-search.sh.
//
//   cd middleware && npx tsx ../scripts/user-search-clone-parity.mts
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env['MOCK_AURORA'] ??= 'true';
process.env['MOCK_AGENTCORE'] ??= 'true';
process.env['DEV_OFFLINE'] ??= 'true';
process.env['POLICY_STORE_ID'] = '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { CATALOG } = await import(resolve(ROOT, 'portal/e2e/user-search-catalog.ts'));
const { searchRecords } = await import(resolve(ROOT, 'middleware/src/providers/search.ts'));
const { answerFromIndex } = await import(resolve(ROOT, 'middleware/src/lib/search-index/answers.ts'));
const { searchTenant } = await import(resolve(ROOT, 'middleware/src/lib/search-index/tenant-query.ts'));
const { cloneIdentity, deleteIdentityClone } = await import(resolve(ROOT, 'middleware/src/providers/identity.ts'));

const MINE = /\b(?:my|me|i|i'm|mine)\b/i;
const out: string[] = [];
let checked = 0;
for (const intent of CATALOG) {
  const mine = intent.phrasings.filter((p: string) => MINE.test(p));
  if (!mine.length) continue;
  const clone = cloneIdentity(intent.persona, { label: 'user-search clone parity' });
  try {
    for (const q of mine) {
      const as = (sub: string) => ({ sub, tenant: intent.tenant, role: intent.role });
      // The Work tenant reads /api/search; the other four read their own tenant index (docs/user-search-goal.md S2).
      const find = (sub: string) => (intent.tenant === 'orgiq' ? searchRecords(as(sub), { q, limit: 10 }) : searchTenant(intent.tenant, as(sub), { q, limit: 10 }));
      const [p, c] = await Promise.all([find(intent.persona), find(clone.id)]);
      const keys = (r: { results: Array<{ type: string; id: string }> }) => r.results.map((x) => `${x.type}:${x.id}`).join(',');
      const [pa, ca] = intent.tenant === 'orgiq'
        ? await Promise.all([answerFromIndex({ question: q, session: as(intent.persona) }), answerFromIndex({ question: q, session: as(clone.id) })])
        : [null, null];
      checked++;
      if (keys(p) !== keys(c)) out.push(`fail\t${intent.id} "${q}": search differs for ${intent.persona} and its clone`);
      else if ((pa?.text ?? null) !== (ca?.text ?? null)) out.push(`fail\t${intent.id} "${q}": the answer differs for ${intent.persona} and its clone`);
      else if (!p.results.length) out.push(`fail\t${intent.id} "${q}": no results for the persona at all`);
    }
  } finally { deleteIdentityClone(clone.id); }
}
if (!out.some((l) => l.startsWith('fail'))) out.unshift(`ok\t${checked} "mine" phrasings answer the same for the persona and a clone (search and the Answer tab)`);
console.log(out.join('\n'));
process.exit(0);
