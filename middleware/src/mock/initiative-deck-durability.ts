// Opt-in local initiative-deck durability and provenance-backed recovery.
// Missing historical bodies remain metadata; they are never materialized as fake specs.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateDeckSpec, type DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { config } from '../config.js';
import { mockRestartArchive } from './restart-state.js';
import { defineFixture } from './core/fixture.js';
import { initiativeDecksFixture, initiativeDeckRevisionsFixture, type InitiativeDeckRow, type InitiativeDeckRevisionRow } from './initiative-decks.js';

export interface ArchivedRevisionMetadata { deckId: string; id: string; seq: number; label: string; createdAt: string; producedBy: string; specAvailable: false; unavailabilityReason: string }
export const archivedDeckHistoryFixture = defineFixture<ArchivedRevisionMetadata>({ key: 'orgiq.deck-archive-history', scenarios: { default: () => [], empty: () => [] } });
export interface DurableInitiativeDecks {
  schema: 'orgiq-local-initiative-decks/v1';
  decks: InitiativeDeckRow[]; revisions: InitiativeDeckRevisionRow[]; archivedHistory: ArchivedRevisionMetadata[];
  provenance: Array<{ deckId: string; sourceSha256: string; originalHeadRevisionId: string; headSpecSha256: string; archivedAt: string; restoredFieldsUnknown: string[] }>;
}
const artifact = /^idk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revision = /^irev-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const metadata = (v: unknown): v is Record<string, unknown> & { id: string; label: string; createdAt: string; producedBy: string } => record(v) && typeof v.id === 'string' && revision.test(v.id) && typeof v.label === 'string' && !!v.label && iso(v.createdAt) && typeof v.producedBy === 'string' && !!v.producedBy;
const nullableText = (v: unknown) => v === null || typeof v === 'string';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function recoverArchivedInitiativeDeck(raw: Buffer, expectedSha256: string): DurableInitiativeDecks {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha(raw) !== expectedSha256) throw Error('initiative deck archive hash mismatch');
  const archive: unknown = JSON.parse(raw.toString('utf8'));
  if (!record(archive) || archive.status !== 200 || archive.specStatus !== 200 || !record(archive.data)) throw Error('invalid initiative deck archive response');
  const d = archive.data, revisions = d.revisions;
  if (typeof d.id !== 'string' || !artifact.test(d.id) || archive.deckId !== d.id || typeof d.projectId !== 'string' || !d.projectId || typeof d.title !== 'string' || !d.title || typeof d.includesBudget !== 'boolean' || !iso(d.createdAt) || !iso(d.updatedAt) || !Array.isArray(revisions) || !revisions.length || revisions.some(r => !metadata(r)) || new Set(revisions.map(r => r.id)).size !== revisions.length || d.activeRevisionId !== revisions[0].id || !Array.isArray(d.lockedSlideIds)) throw Error('invalid initiative deck archive identity/history');
  const valid = validateDeckSpec(archive.spec);
  if (!valid.ok || valid.spec.title !== d.title || d.lockedSlideIds.some(id => typeof id !== 'string' || !valid.spec.slides.some(s => s.id === id))) throw Error('invalid initiative deck archive spec/locks');
  if (JSON.stringify(valid.spec) !== JSON.stringify(archive.spec)) throw Error('archive spec requires normalization; exact recovery refused');
  if (revisions.some((r, i) => i && r.createdAt > revisions[i - 1].createdAt) || revisions[0].createdAt !== d.updatedAt || revisions.at(-1)!.createdAt !== d.createdAt) throw Error('invalid initiative deck archive chronology');
  const head = revisions[0];
  return {
    schema: 'orgiq-local-initiative-decks/v1',
    decks: [{ id: d.id, projectId: d.projectId, title: d.title, includesBudget: d.includesBudget, createdBy: null, createdAt: d.createdAt, updatedAt: d.updatedAt, headRevisionId: head.id }],
    revisions: [{ id: head.id, deckId: d.id, seq: revisions.length, baseRevisionId: null, label: head.label, spec: clone(archive.spec) as DeckSpec, lockedSlideIds: clone(d.lockedSlideIds) as string[], producedBy: head.producedBy, createdBy: null, summary: null, createdAt: head.createdAt }],
    archivedHistory: revisions.slice(1).map((r, i) => ({ ...r, deckId: d.id, seq: revisions.length - i - 1, specAvailable: false as const, unavailabilityReason: 'Only this version’s saved metadata was preserved; its slide content is unavailable.' })),
    provenance: [{ deckId: d.id, sourceSha256: expectedSha256, originalHeadRevisionId: head.id, headSpecSha256: sha(JSON.stringify(archive.spec)), archivedAt: d.updatedAt, restoredFieldsUnknown: ['deck.createdBy', 'revision.createdBy', 'revision.baseRevisionId', 'revision.summary'] }],
  };
}
export function validateDurableInitiativeDecks(v: unknown): DurableInitiativeDecks {
  if (!record(v) || v.schema !== 'orgiq-local-initiative-decks/v1' || !Array.isArray(v.decks) || !Array.isArray(v.revisions) || !Array.isArray(v.archivedHistory) || !Array.isArray(v.provenance)) throw Error('invalid durable initiative deck store');
  const decks = v.decks, full = v.revisions, history = v.archivedHistory;
  if (decks.some(d => !record(d) || typeof d.id !== 'string' || !artifact.test(d.id) || typeof d.projectId !== 'string' || !d.projectId || typeof d.title !== 'string' || !d.title || typeof d.includesBudget !== 'boolean' || !nullableText(d.createdBy) || !iso(d.createdAt) || !iso(d.updatedAt) || !(d.headRevisionId === null || typeof d.headRevisionId === 'string' && revision.test(d.headRevisionId)))) throw Error('invalid durable initiative deck row');
  if (full.some(r => !metadata(r) || !record(r) || !decks.some(d => d.id === r.deckId) || !Number.isInteger(r.seq) || Number(r.seq) < 1 || !(r.baseRevisionId === null || typeof r.baseRevisionId === 'string' && revision.test(r.baseRevisionId)) || !nullableText(r.createdBy) || !nullableText(r.summary) || !Array.isArray(r.lockedSlideIds) || !validateDeckSpec(r.spec).ok || r.lockedSlideIds.some(id => typeof id !== 'string' || !(r.spec as DeckSpec).slides.some(s => s.id === id)))) throw Error('invalid durable initiative deck revision');
  if (history.some(r => !metadata(r) || !record(r) || !decks.some(d => d.id === r.deckId) || !Number.isInteger(r.seq) || Number(r.seq) < 1 || r.specAvailable !== false || 'spec' in r || typeof r.unavailabilityReason !== 'string')) throw Error('invalid unavailable initiative deck history');
  const all = [...full, ...history];
  if (new Set(decks.map(d => d.id)).size !== decks.length || new Set(all.map(r => r.id)).size !== all.length || decks.some(d => d.headRevisionId !== null && !full.some(r => r.deckId === d.id && r.id === d.headRevisionId)) || decks.some(d => new Set(all.filter(r => r.deckId === d.id).map(r => r.seq)).size !== all.filter(r => r.deckId === d.id).length)) throw Error('invalid durable initiative deck anchors');
  if (v.provenance.some(p => !record(p) || !decks.some(d => d.id === p.deckId) || typeof p.originalHeadRevisionId !== 'string' || !revision.test(p.originalHeadRevisionId) || typeof p.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sourceSha256) || typeof p.headSpecSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.headSpecSha256) || !iso(p.archivedAt) || !Array.isArray(p.restoredFieldsUnknown))) throw Error('invalid initiative deck recovery provenance');
  for (const deck of decks) {
    const own = all.filter(r => r.deckId === deck.id);
    const head = full.find(r => r.deckId === deck.id && r.id === deck.headRevisionId);
    if (own.length && (!head || head.seq !== Math.max(...own.map(r => Number(r.seq))) || head.createdAt !== deck.updatedAt)) throw Error('durable initiative deck head is not the newest revision');
    if (own.some(r => !own.some(before => Number(before.seq) === Number(r.seq) - 1) && Number(r.seq) !== 1)) throw Error('durable initiative deck revision sequence has a gap');
  }
  for (const row of full) {
    if (row.baseRevisionId !== null && !all.some(base => base.id === row.baseRevisionId && base.deckId === row.deckId && Number(base.seq) === Number(row.seq) - 1)) throw Error('invalid durable initiative deck base link');
    if (row.baseRevisionId === null && Number(row.seq) !== 1 && !v.provenance.some(p => p.deckId === row.deckId && p.originalHeadRevisionId === row.id && p.restoredFieldsUnknown.includes('revision.baseRevisionId'))) throw Error('unproven missing durable initiative deck base link');
  }
  if (new Set(v.provenance.map(p => p.deckId)).size !== v.provenance.length) throw Error('duplicate initiative deck recovery provenance');
  for (const p of v.provenance) {
    const original = full.find(r => r.deckId === p.deckId && r.id === p.originalHeadRevisionId);
    if (!original || p.restoredFieldsUnknown.some((field: unknown) => typeof field !== 'string') || (p.restoredFieldsUnknown.includes('revision.baseRevisionId') && original.baseRevisionId !== null) || (p.restoredFieldsUnknown.includes('revision.createdBy') && original.createdBy !== null) || (p.restoredFieldsUnknown.includes('revision.summary') && original.summary !== null) || sha(JSON.stringify(original.spec)) !== p.headSpecSha256) throw Error('recovered initiative deck body differs from its archived provenance');
  }
  return v as unknown as DurableInitiativeDecks;
}
export function mergeDurableInitiativeDecks(current: DurableInitiativeDecks, incoming: DurableInitiativeDecks): DurableInitiativeDecks {
  validateDurableInitiativeDecks(incoming);
  const merged = clone(current);
  // A fresh process replays relational rows before loading their durable origin
  // proof. Hydrate only that proof; the rows still must validate and match the
  // saved deck, revisions and unavailable history exactly before adoption.
  for (const p of incoming.provenance) if (merged.decks.some(d => d.id === p.deckId) && !merged.provenance.some(m => m.deckId === p.deckId)) merged.provenance.push(clone(p));
  validateDurableInitiativeDecks(merged);
  for (const deck of incoming.decks) {
    const already = merged.decks.find(d => d.id === deck.id);
    if (already) {
      const local = { deck: already, revisions: merged.revisions.filter(r => r.deckId === deck.id), history: merged.archivedHistory.filter(r => r.deckId === deck.id) };
      const saved = { deck, revisions: incoming.revisions.filter(r => r.deckId === deck.id), history: incoming.archivedHistory.filter(r => r.deckId === deck.id) };
      if (JSON.stringify(local) !== JSON.stringify(saved)) throw Error(`initiative deck recovery conflict: ${deck.id}`);
      continue;
    }
    if ([...incoming.revisions, ...incoming.archivedHistory].filter(r => r.deckId === deck.id).some(r => [...merged.revisions, ...merged.archivedHistory].some(m => m.id === r.id))) throw Error('initiative deck recovery revision conflict');
    merged.decks.push(deck); merged.revisions.push(...incoming.revisions.filter(r => r.deckId === deck.id)); merged.archivedHistory.push(...incoming.archivedHistory.filter(r => r.deckId === deck.id));
  }
  for (const p of incoming.provenance) if (!merged.provenance.some(m => m.deckId === p.deckId)) merged.provenance.push(p);
  return validateDurableInitiativeDecks(merged);
}
let provenance: DurableInitiativeDecks['provenance'] = [];
const pendingCreates = new Set<string>();
/** Only native creates still awaiting their first accepted revision are excluded from another writer’s commit. */
export function trackInitiativeDeckCreation(id: string): () => void {
  if (!config.mock.aurora) return () => undefined;
  pendingCreates.add(id);
  return () => { pendingCreates.delete(id); };
}
const localPath = () => {
  const path = process.env['MOCK_INITIATIVE_DECKS_PATH'];
  if (path && (!config.mock.aurora || process.env['NODE_ENV'] === 'production' || process.env['DEV_OFFLINE'] !== 'true')) throw Error('initiative deck persistence is restricted to offline mock development');
  return path;
};
export const initiativeDeckDurabilityEnabled = (): boolean => !!localPath();
export const initiativeDeckRelationalFixtures: readonly string[] = ['orgiq.decks', 'orgiq.deck-revisions', 'orgiq.deck-archive-history'];
function current(): DurableInitiativeDecks { return { schema: 'orgiq-local-initiative-decks/v1', decks: initiativeDecksFixture.rows(), revisions: initiativeDeckRevisionsFixture.rows(), archivedHistory: archivedDeckHistoryFixture.rows(), provenance: provenance.filter(p => initiativeDecksFixture.rows().some(d => d.id === p.deckId)) }; }
function adopt(v: DurableInitiativeDecks): void { initiativeDecksFixture.rows().splice(0, initiativeDecksFixture.rows().length, ...v.decks); initiativeDeckRevisionsFixture.rows().splice(0, initiativeDeckRevisionsFixture.rows().length, ...v.revisions); archivedDeckHistoryFixture.rows().splice(0, archivedDeckHistoryFixture.rows().length, ...v.archivedHistory); provenance = v.provenance; }
export function persistInitiativeDecks(): void {
  const path = localPath(); if (!path) return;
  const live = current();
  const value = validateDurableInitiativeDecks({ ...live, decks: live.decks.filter(deck => !(pendingCreates.has(deck.id) && deck.headRevisionId === null)) });
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) { if (existsSync(temp)) unlinkSync(temp); throw error; }
}
export function initializeInitiativeDeckDurability(): void {
  const path = localPath();
  const archive = mockRestartArchive();
  if (archive && process.env['MOCK_INITIATIVE_DECK_ARCHIVE']) throw Error('initiative deck recovery handoff conflicts with archive environment');
  const archivePath = process.env['MOCK_INITIATIVE_DECK_ARCHIVE'] ?? archive?.path;
  if (!path) { if (archivePath) throw Error('initiative deck recovery requires a durable destination'); return; }
  let incoming: DurableInitiativeDecks | null = null;
  if (existsSync(path)) incoming = validateDurableInitiativeDecks(JSON.parse(readFileSync(path, 'utf8')));
  else if (archivePath) incoming = recoverArchivedInitiativeDeck(readFileSync(archivePath), process.env['MOCK_INITIATIVE_DECK_ARCHIVE_SHA256'] ?? archive?.sha256 ?? '');
  if (incoming) adopt(mergeDurableInitiativeDecks(current(), incoming));
  persistInitiativeDecks();
}
