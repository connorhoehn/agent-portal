jest.mock('../../config.js', () => ({ config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } } }));
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import express from 'express';
import request from '../../test-support/http.js';
import { mockControlRouter } from '../../routes/mock-control.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivedDeckHistoryFixture, initializeInitiativeDeckDurability, recoverArchivedInitiativeDeck, mergeDurableInitiativeDecks, validateDurableInitiativeDecks } from '../initiative-deck-durability.js';
import { initiativeDecksFixture, initiativeDeckRevisionsFixture } from '../initiative-decks.js';
import { initiativeDeckRevisions, initiativeDeckStore, getDeck, getRevisionSpec, createDeck } from '../../providers/initiative-decks.js';

const raw = readFileSync(join(__dirname, 'fixtures/initiative-deck-archive.json'));
const expectedSha = '4dd2d77c981c21d4af36a69f049b1f946f26fdff6620a11c9f929d63ff05126b';
const archive = recoverArchivedInitiativeDeck(raw, expectedSha);
const empty = () => ({ schema: 'orgiq-local-initiative-decks/v1' as const, decks: [], revisions: [], archivedHistory: [], provenance: [] });
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'initiative-deck-durability-'));
  process.env['NODE_ENV'] = 'development'; process.env['DEV_OFFLINE'] = 'true';
  process.env['MOCK_INITIATIVE_DECKS_PATH'] = join(dir, 'decks.json');
  delete process.env['MOCK_INITIATIVE_DECK_ARCHIVE']; delete process.env['MOCK_INITIATIVE_DECK_ARCHIVE_SHA256'];
  initiativeDecksFixture.reset(); initiativeDeckRevisionsFixture.reset(); archivedDeckHistoryFixture.reset();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MOCK_INITIATIVE_DECKS_PATH']; delete process.env['MOCK_INITIATIVE_DECK_ARCHIVE']; delete process.env['MOCK_INITIATIVE_DECK_ARCHIVE_SHA256']; });
function restore() {
  process.env['MOCK_INITIATIVE_DECK_ARCHIVE'] = join(__dirname, 'fixtures/initiative-deck-archive.json');
  process.env['MOCK_INITIATIVE_DECK_ARCHIVE_SHA256'] = expectedSha;
  initializeInitiativeDeckDurability();
}
it('recovers the exact original identity, dates and head body, retaining six unavailable metadata versions', () => {
  const observed = JSON.parse(raw.toString());
  expect(archive.decks[0]).toMatchObject({ id: observed.data.id, headRevisionId: observed.data.activeRevisionId, createdAt: observed.data.createdAt, updatedAt: observed.data.updatedAt, createdBy: null });
  expect(archive.revisions).toHaveLength(1); expect(archive.revisions[0].spec).toEqual(observed.spec); expect(archive.revisions[0].seq).toBe(7);
  expect(archive.archivedHistory).toHaveLength(6); expect(archive.archivedHistory.map(r => r.seq)).toEqual([6, 5, 4, 3, 2, 1]);
  expect(archive.archivedHistory.every(r => r.specAvailable === false && !('spec' in r))).toBe(true);
  expect(archive.provenance[0].headSpecSha256).toBe(createHash('sha256').update(JSON.stringify(observed.spec)).digest('hex'));
});
it.each(['hash', 'identity', 'head', 'body', 'chronology'])('refuses invalid %s without adopting any row', kind => {
  const observed = JSON.parse(raw.toString());
  if (kind === 'identity') observed.data.id = 'idk-bad';
  if (kind === 'head') observed.data.activeRevisionId = observed.data.revisions[1].id;
  if (kind === 'body') observed.spec.slides[0].type = 'invented';
  if (kind === 'chronology') observed.data.updatedAt = '2000-01-01T00:00:00.000Z';
  const bytes = Buffer.from(JSON.stringify(observed)), sha = kind === 'hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
  expect(() => recoverArchivedInitiativeDeck(bytes, sha)).toThrow(); expect(initiativeDecksFixture.rows()).toEqual([]);
});
it('merges only a missing original deck and refuses a conflicting head without changing either input', () => {
  const other = structuredClone(archive); other.decks[0]!.id = 'idk-11111111-1111-1111-1111-111111111111';
  for (const r of [...other.revisions, ...other.archivedHistory]) { r.deckId = other.decks[0]!.id; r.id = r.id.replace(/^irev-./, 'irev-f'); }
  other.decks[0]!.headRevisionId = other.revisions[0]!.id; other.provenance[0]!.deckId = other.decks[0]!.id; other.provenance[0]!.originalHeadRevisionId = other.revisions[0]!.id;
  const before = JSON.stringify(other); const merged = mergeDurableInitiativeDecks(other, archive);
  expect(merged.decks).toHaveLength(2); expect(JSON.stringify(other)).toBe(before);
  expect(mergeDurableInitiativeDecks(archive, archive)).toEqual(archive);
  const changed = structuredClone(archive); changed.decks[0]!.title = 'An unrelated live change';
  expect(() => mergeDurableInitiativeDecks(changed, archive)).toThrow(/conflict/); expect(changed.decks[0]!.title).toBe('An unrelated live change');
});
it('a fresh second boot accepts exact replayed relational rows using the existing durable origin proof', () => {
  const path = process.env['MOCK_INITIATIVE_DECKS_PATH']!;
  writeFileSync(path, JSON.stringify(archive), { mode: 0o600 });
  const before = readFileSync(path, 'utf8');
  // New module state is essential: a first boot's in-memory provenance would
  // conceal the failure after an already-restored runtime snapshot is replayed.
  jest.isolateModules(() => {
    const rows = require('../initiative-decks.js') as typeof import('../initiative-decks.js');
    const durable = require('../initiative-deck-durability.js') as typeof import('../initiative-deck-durability.js');
    rows.initiativeDecksFixture.rows().splice(0, rows.initiativeDecksFixture.rows().length, ...structuredClone(archive.decks));
    rows.initiativeDeckRevisionsFixture.rows().splice(0, rows.initiativeDeckRevisionsFixture.rows().length, ...structuredClone(archive.revisions));
    durable.archivedDeckHistoryFixture.rows().splice(0, durable.archivedDeckHistoryFixture.rows().length, ...structuredClone(archive.archivedHistory));
    durable.initializeInitiativeDeckDurability();
    expect(rows.initiativeDecksFixture.rows()).toEqual(archive.decks);
    expect(rows.initiativeDeckRevisionsFixture.rows()).toEqual(archive.revisions);
    expect(durable.archivedDeckHistoryFixture.rows()).toEqual(archive.archivedHistory);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(rows.initiativeDeckRevisionsFixture.rows()[0]!.baseRevisionId).toBeNull();
  });
});
it('a fresh second boot retains an accepted native revision above the proven recovered head', async () => {
  restore();
  const original = archive.revisions[0]!, id = initiativeDeckRevisions.newRevisionId();
  const appended = await initiativeDeckRevisions.append({ ...original, id, baseRevisionId: original.id,
    label: 'Edited', producedBy: 'person:existing-author', createdBy: 'existing-author',
    spec: { ...original.spec, subtitle: 'An accepted local revision above the archive' } });
  expect(appended.ok).toBe(true);
  const path = process.env['MOCK_INITIATIVE_DECKS_PATH']!, before = readFileSync(path, 'utf8');
  const saved = validateDurableInitiativeDecks(JSON.parse(before));
  expect(saved.decks[0]!.headRevisionId).toBe(id);
  jest.isolateModules(() => {
    const rows = require('../initiative-decks.js') as typeof import('../initiative-decks.js');
    const durable = require('../initiative-deck-durability.js') as typeof import('../initiative-deck-durability.js');
    rows.initiativeDecksFixture.rows().splice(0, rows.initiativeDecksFixture.rows().length, ...structuredClone(saved.decks));
    rows.initiativeDeckRevisionsFixture.rows().splice(0, rows.initiativeDeckRevisionsFixture.rows().length, ...structuredClone(saved.revisions));
    durable.archivedDeckHistoryFixture.rows().splice(0, durable.archivedDeckHistoryFixture.rows().length, ...structuredClone(saved.archivedHistory));
    durable.initializeInitiativeDeckDurability();
    expect(rows.initiativeDecksFixture.rows()).toEqual(saved.decks);
    expect(rows.initiativeDeckRevisionsFixture.rows()).toEqual(saved.revisions);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(JSON.parse(before).provenance).toEqual(archive.provenance);
    expect(rows.initiativeDeckRevisionsFixture.rows().find(row => row.id === id)!.baseRevisionId).toBe(original.id);
  });
});
it.each(['body', 'metadata', 'manufactured base'])('replayed %s cannot borrow durable proof to conceal a conflict', kind => {
  const replay = { ...structuredClone(archive), provenance: [] };
  if (kind === 'body') replay.revisions[0]!.spec.subtitle = 'Changed since the saved origin';
  if (kind === 'metadata') replay.decks[0]!.title = 'Changed title';
  if (kind === 'manufactured base') replay.revisions[0]!.baseRevisionId = replay.archivedHistory[0]!.id;
  const before = JSON.stringify(replay);
  expect(() => mergeDurableInitiativeDecks(replay, archive)).toThrow();
  expect(JSON.stringify(replay)).toBe(before);
});
it('replayed recovered rows still require durable origin proof for their own deck', () => {
  const replay = { ...structuredClone(archive), provenance: [] };
  expect(() => mergeDurableInitiativeDecks(replay, empty())).toThrow(/unproven missing/);
});
it('native reads expose all seven versions while only the authentic head is available', async () => {
  restore(); const deck = archive.decks[0]!; const viewer = { canReadBudgets: false };
  const detail = await getDeck(deck.id, viewer);
  expect(detail?.revisions).toHaveLength(7); expect(detail?.activeRevisionId).toBe(deck.headRevisionId);
  expect(detail?.revisions.slice(1).every(r => r.specAvailable === false)).toBe(true);
  expect(await getRevisionSpec(deck.id, deck.headRevisionId!, viewer)).toEqual(archive.revisions[0]!.spec);
  expect(await getRevisionSpec(deck.id, archive.archivedHistory[0]!.id, viewer)).toBeNull();
  expect(statSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!).mode & 0o777).toBe(0o600);
});
it('a real CAS append persists v8 and its authentic authorship, then reloads without manufacturing history', async () => {
  restore(); const head = archive.revisions[0]!; const id = initiativeDeckRevisions.newRevisionId();
  const next = { ...head, id, baseRevisionId: head.id, producedBy: 'person:existing-author', createdBy: 'existing-author', label: 'Edited', spec: { ...head.spec, subtitle: 'An actual local edit' } };
  const result = await initiativeDeckRevisions.append(next); expect(result.ok).toBe(true); if (result.ok) expect(result.revision.seq).toBe(8);
  const onDisk = validateDurableInitiativeDecks(JSON.parse(readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8')));
  expect(onDisk.decks[0]!.headRevisionId).toBe(id); expect(onDisk.revisions).toHaveLength(2); expect(onDisk.archivedHistory).toHaveLength(6);
  const before = readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8');
  expect((await initiativeDeckRevisions.append({ ...next, id: initiativeDeckRevisions.newRevisionId() })).ok).toBe(false);
  expect(readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8')).toBe(before);
  initiativeDecksFixture.reset(); initiativeDeckRevisionsFixture.reset(); archivedDeckHistoryFixture.reset(); initializeInitiativeDeckDurability();
  expect(initiativeDecksFixture.rows()[0]!.headRevisionId).toBe(id); expect(initiativeDeckRevisionsFixture.rows().map(r => r.seq)).toEqual([7, 8]);
});
it('failed atomic persistence rolls the CAS change back and preserves the prior head/body', async () => {
  restore(); const head = archive.revisions[0]!, before = structuredClone(initiativeDeckRevisionsFixture.rows());
  const blocked = join(dir, 'destination-is-a-directory'); mkdirSync(blocked); process.env['MOCK_INITIATIVE_DECKS_PATH'] = blocked;
  await expect(initiativeDeckRevisions.append({ ...head, id: initiativeDeckRevisions.newRevisionId(), baseRevisionId: head.id })).rejects.toThrow();
  expect(initiativeDecksFixture.rows()[0]!.headRevisionId).toBe(head.id); expect(initiativeDeckRevisionsFixture.rows()).toEqual(before);
});
it('explicit reset can persist empty state; the one-time archive does not reappear from an existing destination', () => {
  restore(); initiativeDecksFixture.reset(); initiativeDeckRevisionsFixture.reset(); archivedDeckHistoryFixture.reset();
  // The control plane calls this same persistence seam after explicit reset.
  const { persistInitiativeDecks } = require('../initiative-deck-durability.js'); persistInitiativeDecks(); initializeInitiativeDeckDurability();
  expect(initiativeDecksFixture.rows()).toEqual([]); expect(initiativeDeckRevisionsFixture.rows()).toEqual([]); expect(archivedDeckHistoryFixture.rows()).toEqual([]);
});
it('rejects fake unavailable bodies or a corrupt persisted anchor', () => {
  const bad = structuredClone(archive); (bad.archivedHistory[0] as unknown as Record<string, unknown>).spec = archive.revisions[0]!.spec;
  expect(() => validateDurableInitiativeDecks(bad)).toThrow();
  const missing = structuredClone(archive); missing.decks[0]!.headRevisionId = missing.archivedHistory[0]!.id;
  expect(() => validateDurableInitiativeDecks(missing)).toThrow();
  expect(validateDurableInitiativeDecks(empty())).toEqual(empty());
});

it.each(['base id', 'provenance body', 'older head', 'forward base', 'missing base'])('refuses inconsistent durable %s on later restart', kind => {
  const value = structuredClone(archive);
  if (kind === 'base id') value.revisions[0]!.baseRevisionId = 'not-a-revision';
  if (kind === 'provenance body') value.revisions[0]!.spec.subtitle = 'Tampered, although syntactically valid';
  if (['older head', 'forward base', 'missing base'].includes(kind)) {
    const original = value.revisions[0]!;
    const next = { ...structuredClone(original), id: 'irev-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', seq: 8, baseRevisionId: original.id, createdAt: '2026-10-10T00:00:00.000Z' };
    value.revisions.push(next);
    if (kind !== 'older head') { value.decks[0]!.headRevisionId = next.id; value.decks[0]!.updatedAt = next.createdAt; }
    if (kind === 'forward base') original.baseRevisionId = next.id;
    if (kind === 'missing base') next.baseRevisionId = null as never;
  }
  expect(() => validateDurableInitiativeDecks(value)).toThrow();
});

it.each(['orgiq.decks', 'orgiq.deck-revisions', 'orgiq.deck-archive-history'])('rejects coupled partial reset/scenario of %s before any RAM/disk mutation', async key => {
  restore(); const app = express(); app.use(express.json()); app.use(mockControlRouter);
  const before = readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8'); const rows = structuredClone({ decks: initiativeDecksFixture.rows(), revisions: initiativeDeckRevisionsFixture.rows(), history: archivedDeckHistoryFixture.rows() });
  expect((await request(app).post('/api/__mock/reset').send({ fixture: key })).status).toBe(409);
  expect((await request(app).post('/api/__mock/scenario').send({ fixture: key, scenario: 'empty' })).status).toBe(409);
  expect({ decks: initiativeDecksFixture.rows(), revisions: initiativeDeckRevisionsFixture.rows(), history: archivedDeckHistoryFixture.rows() }).toEqual(rows);
  expect(readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8')).toBe(before);
});
it('failed first-creation persistence removes only the new head-null orphan, preserving the real recovered deck', async () => {
  restore(); const before = structuredClone({ decks: initiativeDecksFixture.rows(), revisions: initiativeDeckRevisionsFixture.rows() });
  const blocked = join(dir, 'creation-destination-is-directory'); mkdirSync(blocked); process.env['MOCK_INITIATIVE_DECKS_PATH'] = blocked;
  await expect(createDeck('p-observability', { narrative: false, includeBudget: false }, { canReadBudgets: false }, 'existing-author')).rejects.toThrow();
  expect({ decks: initiativeDecksFixture.rows(), revisions: initiativeDeckRevisionsFixture.rows() }).toEqual(before);
});

it('rejects duplicate recovery provenance and manufactured unknown original authorship/base', () => {
  const duplicate = structuredClone(archive); duplicate.provenance.push(duplicate.provenance[0]!); expect(() => validateDurableInitiativeDecks(duplicate)).toThrow();
  const fabricated = structuredClone(archive); fabricated.revisions[0]!.createdBy = 'inferred-from-producedBy'; expect(() => validateDurableInitiativeDecks(fabricated)).toThrow();
  const inferredBase = structuredClone(archive); inferredBase.revisions[0]!.baseRevisionId = inferredBase.archivedHistory[0]!.id; expect(() => validateDurableInitiativeDecks(inferredBase)).toThrow();
});

it.each([1, 2])('concurrent native first-creates preserve only accepted heads when append %s fails', async failAt => {
  initializeInitiativeDeckDurability(); let calls = 0; const original = initiativeDeckRevisions.config.mock.afterAppend!;
  initiativeDeckRevisions.config.mock.afterAppend = () => { if (++calls === failAt) throw Error('one local disk commit fails'); original(); };
  try {
    const outcomes = await Promise.allSettled([createDeck('p-observability', { narrative: false, includeBudget: false, title: 'Parallel A' }, { canReadBudgets: false }, 'existing-author'), createDeck('p-observability', { narrative: false, includeBudget: false, title: 'Parallel B' }, { canReadBudgets: false }, 'existing-author')]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const saved = validateDurableInitiativeDecks(JSON.parse(readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8')));
    expect(saved.decks).toHaveLength(1); expect(saved.revisions).toHaveLength(1); expect(saved.decks.every(deck => !!deck.headRevisionId)).toBe(true);
    expect(saved.decks).toEqual(initiativeDecksFixture.rows()); expect(saved.revisions).toEqual(initiativeDeckRevisionsFixture.rows());
  } finally { initiativeDeckRevisions.config.mock.afterAppend = original; }
});
it('an existing head save cannot cross-commit a pending create, while a legitimate preexisting empty artifact survives', async () => {
  restore(); const original = initiativeDeckStore.insertDeck.bind(initiativeDeckStore);
  const emptyId = 'idk-cccccccc-cccc-cccc-cccc-cccccccccccc';
  initiativeDecksFixture.rows().push({ ...archive.decks[0]!, id: emptyId, headRevisionId: null, title: 'Existing empty artifact' });
  let release!: () => void, inserted!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { inserted = resolve; });
  const spy = jest.spyOn(initiativeDeckStore, 'insertDeck').mockImplementation(async row => { const result = await original(row); inserted(); await pending; return result; });
  const creating = createDeck('p-observability', { narrative: false, includeBudget: false }, { canReadBudgets: false }, 'existing-author');
  try {
    await ready; const head = archive.revisions[0]!;
    await initiativeDeckRevisions.append({ ...head, id: initiativeDeckRevisions.newRevisionId(), baseRevisionId: head.id, producedBy: 'person:existing-author', createdBy: 'existing-author' });
    const saved = validateDurableInitiativeDecks(JSON.parse(readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8')));
    expect(saved.decks).toHaveLength(2); expect(saved.decks.some(deck => deck.id === emptyId && deck.headRevisionId === null)).toBe(true);
    expect(saved.decks.filter(deck => deck.headRevisionId === null).map(deck => deck.id)).toEqual([emptyId]);
  } finally { release(); await creating; spy.mockRestore(); }
  const completed = validateDurableInitiativeDecks(JSON.parse(readFileSync(process.env['MOCK_INITIATIVE_DECKS_PATH']!, 'utf8')));
  expect(completed.decks).toHaveLength(3); expect(completed.decks.filter(deck => deck.headRevisionId === null).map(deck => deck.id)).toEqual([emptyId]);
});
