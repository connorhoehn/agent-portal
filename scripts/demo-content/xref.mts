// Cross-reference integrity of the dev:mock world (docs/demo-content-goal.md
// check C1/C2). Every id a fixture row mentions — in an id field or inside its
// prose — must exist in the fixture that owns that kind of record, and a name
// stored beside an id (`stewardPersonId` + `stewardName`) must be that record's
// name. A story where Vera owns an initiative but "Sienna" is its steward, or a
// comment cites wi-auth-e9-s9 that no board holds, breaks for a peer on the
// first click.
//   (cd middleware && npx tsx ../scripts/demo-content/xref.mts) [--json]
// Prints one line per problem: `dangling|name-mismatch <fixture> <file:line> <path> <value> — <why>`.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadFixtures, type LoadedFixture } from './fixtures.mts';

type Kind = 'box' | 'person' | 'user' | 'initiative' | 'work-item' | 'decision' | 'sprint' | 'design' | 'team' | 'access-request' | 'access-policy' | 'access-review' | 'catalog-item' | 'channel';

/** Owners: which fixture holds each kind, its id field and its name field. */
const OWNERS: Array<{ kind: Kind; key: string; id: string; name?: string }> = [
  { kind: 'person', key: 'graph-people', id: 'id', name: 'name' },
  { kind: 'person', key: 'access.people', id: 'id', name: 'name' },
  { kind: 'initiative', key: 'initiatives', id: 'id', name: 'name' },
  { kind: 'work-item', key: 'work-items', id: 'id', name: 'title' },
  { kind: 'decision', key: 'graph-decisions', id: 'id', name: 'topic' },
  { kind: 'sprint', key: 'sprints', id: 'id', name: 'name' },
  { kind: 'design', key: 'design-reviews', id: 'id', name: 'title' },
  { kind: 'team', key: 'assessment-teams', id: 'id', name: 'name' },
  { kind: 'access-request', key: 'access.requests', id: 'id' },
  { kind: 'access-policy', key: 'access.policies', id: 'id', name: 'title' },
  { kind: 'access-review', key: 'access.reviews', id: 'id', name: 'title' },
  { kind: 'catalog-item', key: 'access.catalog', id: 'id', name: 'title' },
  { kind: 'channel', key: 'social.channels', id: 'slug', name: 'name' },
  { kind: 'box', key: 'devbox-boxes', id: 'id', name: 'label' },
];

/** Tokens that are unambiguously an id of one kind, wherever they appear (an id field or prose). */
const CAST = 'operator|theo|vera|hr|release|rachel|mia|nora|eli|layla|caleb|asha|jonas|farah|mira|lena|sana|ines|kofi|dara|tomas|rhea|omar|priya';
const TOKENS: Array<{ kind: Kind; re: RegExp }> = [
  { kind: 'person', re: /\bp-\d{3}\b/g },
  { kind: 'person', re: /\bp-(?:rhea|omar|priya)\b/g },
  { kind: 'user', re: new RegExp(`\\bu-(?:${CAST})\\b(?!-)`, 'g') },
  { kind: 'initiative', re: /\bp-(?!rhea\b|omar\b|priya\b)[a-z]+(?:-[a-z]+)*\b(?![-\w])/g },
  { kind: 'work-item', re: /\bwi-[a-z0-9]+(?:-[a-z0-9]+)+\b/g },
  { kind: 'design', re: /\bdes-[a-z0-9]+(?:-[a-z0-9]+)*\b/g },
  { kind: 'team', re: /\bTEAM-\d{3}\b/g },
  { kind: 'access-request', re: /\breq-\d{4}\b/g },
  { kind: 'access-policy', re: /\bsod-\d{3}\b/g },
  { kind: 'access-review', re: /\brev-\d{4}\b/g },
  { kind: 'box', re: /\bbox-mock-\d+\b/g },
];
/** Fields whose value is an id of a kind the token patterns cannot recognise on their own. */
const FIELDS: Array<{ kind: Kind; re: RegExp }> = [
  { kind: 'decision', re: /^(?:decisionId|decision_id)$/ },
  { kind: 'sprint', re: /^(?:sprintId|sprint_id)$/ },
  { kind: 'catalog-item', re: /^itemId$/ },
  { kind: 'initiative', re: /^(?:projectId|orgProjectId|org_project_id|initiativeId|project_id)$/ },
  { kind: 'work-item', re: /^(?:workItemId|work_item_id)$/ },
  // A user id in a who-did-it field (only values shaped u-…; agent ids and role strings are not users).
  { kind: 'user', re: /^(?:createdBy|ownerId|userId|actorId|requesterId|beneficiaryId|decidedBy|openedBy|grantedBy|updatedBy|dispatchedBy|startedBy|callerId|authorId|pinnedBy|addedBy|delegatorId|delegateId|endedBy)$/ },
];
/** Id field → the name field stored beside it, checked against the owner's name. */
const PAIRS: Array<{ id: RegExp; name: (k: string) => string }> = [
  { id: /^(\w*?)(PersonId|UserId|Id)$/, name: (k) => k.replace(/(PersonId|UserId|Id)$/, 'Name') },
];

function usersFromIdentity(): Map<string, { name: string; personId: string | null }> {
  const src = fs.readFileSync(path.join(ROOT, 'middleware/src/providers/identity.ts'), 'utf8');
  const out = new Map<string, { name: string; personId: string | null }>();
  for (const m of src.matchAll(/\{\s*id:\s*'(u-[a-z]+)',\s*displayName:\s*'([^']+)',[^}]*?personId:\s*(?:'([^']+)'|null)/g)) out.set(m[1]!, { name: m[2]!, personId: m[3] ?? null });
  return out;
}

export interface XrefProblem { type: 'dangling' | 'name-mismatch' | 'name-collision'; fixture: string; file: string | null; path: string; value: string; why: string }

export async function xref(): Promise<{ problems: XrefProblem[]; checked: number }> {
  const fixtures = await loadFixtures();
  const byKey = new Map(fixtures.map((f) => [f.key, f]));
  const ids = new Map<Kind, Map<string, string>>();
  for (const o of OWNERS) {
    const m = ids.get(o.kind) ?? new Map<string, string>();
    for (const r of (byKey.get(o.key)?.rows ?? []) as Array<Record<string, unknown>>) {
      const id = r?.[o.id];
      if (typeof id === 'string') m.set(id, typeof r[o.name ?? ''] === 'string' ? String(r[o.name!]) : id);
    }
    ids.set(o.kind, m);
  }
  const users = usersFromIdentity();
  ids.set('user', new Map([...users].map(([k, v]) => [k, v.name])));
  const problems: XrefProblem[] = [];
  let checked = 0;
  const seen = new Set<string>();
  const report = (p: XrefProblem) => { const k = `${p.type}|${p.fixture}|${p.path.replace(/\[\d+\]/, '[]')}|${p.value}`; if (!seen.has(k)) { seen.add(k); problems.push(p); } };

  const visit = (f: LoadedFixture, v: unknown, at: string, field: string, row: Record<string, unknown> | null) => {
    if (typeof v === 'string') {
      for (const { kind, re } of FIELDS) if (re.test(field) && v && (kind !== 'user' || /^u-[a-z]+$/.test(v))) {
        checked++;
        if (!ids.get(kind)!.has(v) && !(kind === 'initiative' && !/^p-/.test(v))) report({ type: 'dangling', fixture: f.key, file: f.file, path: at, value: v, why: `${field} names a ${kind} no fixture holds` });
      }
      for (const { kind, re } of TOKENS) {
        re.lastIndex = 0;
        for (const m of v.matchAll(re)) {
          checked++;
          if (kind === 'initiative' && /^p-\d/.test(m[0])) continue;
          if (!ids.get(kind)!.has(m[0])) report({ type: 'dangling', fixture: f.key, file: f.file, path: at, value: m[0], why: `mentions a ${kind} no fixture holds` });
        }
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(f, x, `${at}[${i}]`, field, row)); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const [k, x] of Object.entries(o)) {
        visit(f, x, at ? `${at}.${k}` : k, k, o);
        for (const p of PAIRS) {
          if (!p.id.test(k) || typeof x !== 'string') continue;
          const nk = p.name(k), name = o[nk];
          if (typeof name !== 'string' || !name) continue;
          const kind: Kind | null = /^p-\d{3}$|^p-(rhea|omar|priya)$/.test(x) ? 'person' : /^u-/.test(x) ? 'user' : /^p-/.test(x) ? 'initiative' : null;
          if (!kind) continue;
          checked++;
          const want = ids.get(kind)!.get(x);
          if (want && want !== name) report({ type: 'name-mismatch', fixture: f.key, file: f.file, path: at ? `${at}.${nk}` : nk, value: name, why: `${k} ${x} is "${want}", the row says "${name}"` });
        }
      }
    }
  };
  for (const f of fixtures) f.rows.forEach((r, i) => visit(f, r, `[${i}]`, '', null));
  // The cast: each user's person link must exist.
  for (const [u, { personId }] of users) {
    checked++;
    if (personId && !ids.get('person')!.has(personId)) report({ type: 'dangling', fixture: 'identity', file: 'middleware/src/providers/identity.ts', path: u, value: personId, why: 'the user\'s personId is in no people fixture' });
  }
  // One cast: no two sign-in users share a first name, and no initiative's owner, SMEs and sponsor do
  // (a peer cannot tell "Nora" from "Nora" on one page).
  const first = (n: string) => n.split(/\s+/)[0]!;
  const castByFirst = new Map<string, string[]>();
  for (const [u, { name }] of users) if (u !== 'u-operator') castByFirst.set(first(name), [...(castByFirst.get(first(name)) ?? []), `${name} (${u})`]);
  for (const [f, names] of castByFirst) { checked++; if (names.length > 1) report({ type: 'name-collision', fixture: 'identity', file: 'middleware/src/providers/identity.ts', path: 'FALLBACK_USERS', value: f, why: `the sign-in cast has ${names.length} people called ${f}: ${names.join(', ')}` }); }
  const people = ids.get('person')!;
  const initiativeFile = byKey.get('initiatives')?.file ?? null;
  for (const r of (byKey.get('initiatives')?.rows ?? []) as Array<{ id: string; name: string; owner: string; smes: string[]; sponsor: string }>) {
    const team = [r.owner, ...(r.smes ?? []), r.sponsor].filter(Boolean).map((p) => people.get(p) ?? p);
    const seen = new Map<string, string>();
    for (const n of team) {
      checked++;
      const f = first(n);
      if (seen.has(f) && seen.get(f) !== n) report({ type: 'name-collision', fixture: 'initiatives', file: initiativeFile, path: r.id, value: f, why: `${r.name} puts ${seen.get(f)} and ${n} side by side` });
      seen.set(f, n);
    }
  }
  return { problems, checked };
}

const { problems, checked } = await xref();
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ checked, problems }, null, 1) + '\n');
else {
  for (const p of problems) console.log(`${p.type}\t${p.fixture}\t${p.file ?? '?'}\t${p.path}\t${p.value}\t${p.why}`);
  console.log(`# ${checked} references checked, ${problems.length} problems`);
}
