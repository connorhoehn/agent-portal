// The SearchIndex contract: ONE suite over every implementation. The memory
// index always runs; the kv (DynamoDB-wire) index runs against
// SEARCH_INDEX_DYNAMODB_ENDPOINT (default http://localhost:8000 — DynamoDB
// Local or the managed-nosql-store) when something answers there, in a
// uniquely named table dropped afterwards, and is skipped otherwise.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MemorySearchIndex } from '../memory.js';
import { KvSearchIndex, createKvIndexClient, dropKvIndexTable, ensureKvIndexTable } from '../kv.js';
import type { SearchDoc, SearchIndex } from '../types.js';

jest.setTimeout(60_000);

const ENDPOINT = process.env['SEARCH_INDEX_DYNAMODB_ENDPOINT']?.trim() || 'http://localhost:8000';
function reachable(url: string): boolean {
  const { hostname, port } = new URL(url);
  try {
    execFileSync(process.execPath, ['-e', `const s=require('net').connect(${Number(port) || 80},${JSON.stringify(hostname)});s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000)`], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

interface Backend { name: string; open(): Promise<SearchIndex>; close(): Promise<void> }
const backends: Backend[] = [{ name: 'memory', open: async () => new MemorySearchIndex(), close: async () => undefined }];
if (reachable(ENDPOINT)) {
  let client: DynamoDBClient | null = null;
  const table = `sitest-${randomBytes(5).toString('hex')}-search-index`;
  backends.push({
    name: `kv (${ENDPOINT})`,
    open: async () => {
      if (!client) { client = createKvIndexClient({ endpoint: ENDPOINT, table, region: 'us-east-1' }); await ensureKvIndexTable(client, table); }
      return new KvSearchIndex(client, table);
    },
    close: async () => { if (client) { await dropKvIndexTable(client, table); client.destroy(); client = null; } },
  });
} else {
  // eslint-disable-next-line no-console
  console.info(`search-index contract: no DynamoDB-wire store at ${ENDPOINT}; kv leg skipped`);
}

const doc = (tenant: string, type: string, id: string, over: Partial<SearchDoc> = {}): SearchDoc => ({
  tenant, type, id, title: `${type} ${id}`, text: '', facets: {}, people: [], edges: [], acl: null, updatedAt: null, record: { href: `/x/${id}` }, ...over,
});
const ids = (docs: Array<{ type: string; id: string }>) => docs.map(d => `${d.type}:${d.id}`).sort();

describe.each(backends)('SearchIndex contract: $name', (backend) => {
  let index: SearchIndex;
  let t: string;
  beforeAll(async () => { index = await backend.open(); });
  afterAll(async () => { await backend.close(); });
  beforeEach(() => { t = `t${randomBytes(4).toString('hex')}`; });

  it('round-trips a doc and hands out copies', async () => {
    const d = doc(t, 'person', 'p-1', { title: 'Nora DaSilva', text: 'RAG, Rust', facets: { skill: ['RAG', 'Rust'] }, people: ['p-1'], updatedAt: '2026-10-01T00:00:00.000Z', record: { href: '/iq/p-1', subtitle: 'Engineer' } });
    await index.put(d);
    const [got] = await index.get(t, ['person:p-1', 'person:missing']);
    expect(got).toEqual(d);
    got!.title = 'mutated';
    expect((await index.get(t, ['person:p-1']))[0]!.title).toBe('Nora DaSilva');
  });

  it('finds by title word, title prefix, text word and plural stem, and nothing else', async () => {
    await index.putMany([
      doc(t, 'decision', 'd-otel', { title: 'Self-hosted OTel collectors over vendor agents', text: 'cost and latency' }),
      doc(t, 'knowledge', 'k-1', { title: 'Cold start', text: 'Kubernetes clusters drain slowly' }),
      doc(t, 'person', 'p-7', { title: 'Marcus Müller', text: 'Kubernetes, Docker' }),
    ]);
    const q = async (...terms: string[]) => ids((await index.query({ tenant: t, terms })).docs);
    expect(await q('collectors')).toEqual(['decision:d-otel']);
    expect(await q('collector')).toEqual(['decision:d-otel']);
    expect(await q('coll')).toEqual(['decision:d-otel']);
    expect(await q('kubernetes')).toEqual(['knowledge:k-1', 'person:p-7']);
    expect(await q('cluster')).toEqual(['knowledge:k-1']);
    expect(await q('latency', 'docker')).toEqual(['decision:d-otel', 'person:p-7']);
    expect(await q('drai')).toEqual([]); // text words are not prefix-posted
    expect(await q('zebra')).toEqual([]);
  });

  it('filters by type, by facets (AND across names, OR within, any case) and by acl', async () => {
    await index.putMany([
      doc(t, 'decision', 'd-1', { title: 'Cutover order', facets: { status: ['Escalated'] } }),
      doc(t, 'decision', 'd-2', { title: 'Judge model', facets: { status: ['open'] } }),
      doc(t, 'decision', 'd-3', { title: 'Adopt Aurora', facets: { status: ['resolved'] } }),
      doc(t, 'person', 'p-1', { title: 'Vera Green', facets: { status: ['open'], department: ['platform engineering'] }, acl: 'ViewOrgChart' }),
    ]);
    const open = await index.query({ tenant: t, terms: [], types: ['decision'], facets: { status: ['open', 'escalated'] } });
    expect(ids(open.docs)).toEqual(['decision:d-1', 'decision:d-2']);
    expect(ids((await index.query({ tenant: t, terms: [], facets: { status: ['OPEN'] } })).docs)).toEqual(['decision:d-2']);
    expect(ids((await index.query({ tenant: t, terms: [], facets: { status: ['OPEN'] }, allowedAcls: ['ViewOrgChart'] })).docs)).toEqual(['decision:d-2', 'person:p-1']);
    expect(ids((await index.query({ tenant: t, terms: [], facets: { status: ['open'], department: ['Platform Engineering'] }, allowedAcls: ['ViewOrgChart'] })).docs)).toEqual(['person:p-1']);
    expect(ids((await index.query({ tenant: t, terms: ['green'] })).docs)).toEqual([]);
    expect(ids((await index.query({ tenant: t, terms: [] })).docs)).toEqual(['decision:d-1', 'decision:d-2', 'decision:d-3']);
    expect(ids((await index.query({ tenant: t, terms: ['cutover', 'judge'], types: ['decision'] })).docs)).toEqual(['decision:d-1', 'decision:d-2']);
  });

  it('a re-put replaces postings, facets and edges; a remove drops them', async () => {
    await index.putMany([
      doc(t, 'work', 'w-1', { title: 'Tenant cutover runbook', facets: { status: ['open'] }, edges: [{ id: 'e1', source: 'person:p-1', target: 'work:w-1', label: 'assigned to' }] }),
      doc(t, 'person', 'p-1', { title: 'Vera Green' }),
      doc(t, 'person', 'p-2', { title: 'Owen Brooks' }),
    ]);
    await index.put(doc(t, 'work', 'w-1', { title: 'Rollback drill', facets: { status: ['done'] }, edges: [{ id: 'e2', source: 'person:p-2', target: 'work:w-1', label: 'assigned to' }] }));
    expect(ids((await index.query({ tenant: t, terms: ['cutover'] })).docs)).toEqual([]);
    expect(ids((await index.query({ tenant: t, terms: ['rollback'] })).docs)).toEqual(['work:w-1']);
    expect(ids((await index.query({ tenant: t, terms: [], facets: { status: ['open'] } })).docs)).toEqual([]);
    expect((await index.neighbours(t, ['person:p-1'])).length).toBe(0);
    expect((await index.neighbours(t, ['person:p-2'])).map(n => n.doc.id)).toEqual(['w-1']);
    await index.remove(t, 'work:w-1');
    expect(await index.get(t, ['work:w-1'])).toEqual([]);
    expect(ids((await index.query({ tenant: t, terms: ['rollback'] })).docs)).toEqual([]);
    expect(await index.neighbours(t, ['person:p-2'])).toEqual([]);
    await index.remove(t, 'work:never'); // a no-op
  });

  it('walks edges from either end, optionally through named labels only', async () => {
    await index.putMany([
      doc(t, 'initiative', 'auth', { title: 'Auth Migration', edges: [
        { id: 'own', source: 'person:p-2', target: 'initiative:auth', label: 'owns' },
        { id: 'sme', source: 'person:p-4', target: 'initiative:auth', label: 'SME' },
      ] }),
      doc(t, 'person', 'p-2', { title: 'Vera Green' }),
      doc(t, 'person', 'p-4', { title: 'Nora DaSilva', edges: [{ id: 'c1', source: 'person:p-4', target: 'person:p-13', label: 'collaborates', weight: 0.94 }] }),
      doc(t, 'person', 'p-13', { title: 'Caleb Turner' }),
    ]);
    const all = await index.neighbours(t, ['initiative:auth']);
    expect(all.map(n => `${n.edge.label}:${n.doc.id}`).sort()).toEqual(['SME:p-4', 'owns:p-2']);
    expect((await index.neighbours(t, ['initiative:auth'], ['owns'])).map(n => n.doc.id)).toEqual(['p-2']);
    const back = await index.neighbours(t, ['person:p-13', 'person:p-4'], ['collaborates']);
    expect(back.map(n => `${n.from}->${n.doc.id}@${n.edge.weight}`).sort()).toEqual(['person:p-13->p-4@0.94', 'person:p-4->p-13@0.94']);
    expect((await index.neighbours(t, ['person:p-2'])).map(n => n.doc.id)).toEqual(['auth']);
  });

  it('keeps partitions apart, pages with a cursor, and clears a partition with its meta', async () => {
    const other = `${t}~scope`;
    await index.putMany(Array.from({ length: 5 }, (_, i) => doc(t, 'knowledge', `k-${i}`, { title: `Runbook ${i}` })));
    await index.put(doc(other, 'knowledge', 'k-0', { title: 'Runbook elsewhere' }));
    await index.setMeta(t, { builtAt: '2026-10-15T00:00:00.000Z', partial: ['Knowledge source window is limited'] });
    expect(await index.getMeta(t)).toEqual({ builtAt: '2026-10-15T00:00:00.000Z', partial: ['Knowledge source window is limited'] });
    expect(await index.getMeta(other)).toBeNull();
    const first = await index.query({ tenant: t, terms: ['runbook'], limit: 3 });
    expect(first.docs).toHaveLength(3);
    const second = await index.query({ tenant: t, terms: ['runbook'], limit: 3, cursor: first.cursor });
    expect(second.cursor).toBeNull();
    expect(ids([...first.docs, ...second.docs])).toEqual(['knowledge:k-0', 'knowledge:k-1', 'knowledge:k-2', 'knowledge:k-3', 'knowledge:k-4']);
    expect((await index.get(other, ['knowledge:k-0']))[0]!.title).toBe('Runbook elsewhere');
    await index.clear(t);
    expect(await index.getMeta(t)).toBeNull();
    expect((await index.query({ tenant: t, terms: ['runbook'] })).docs).toEqual([]);
    expect((await index.query({ tenant: other, terms: ['runbook'] })).docs).toHaveLength(1);
  });
});
