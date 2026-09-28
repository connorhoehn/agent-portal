import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { defineFixture } from '../mock/core/fixture.js';
import { exec } from './aurora.js';

export interface SavedSearchInput {
  name: string;
  query: string;
  scope: string;
  types: string[];
  tab: 'results' | 'answer' | 'connections';
  selectedKeys: string[];
}
export interface SavedSearch extends SavedSearchInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface SearchOwner { sub: string; tenant: string }
interface StoredSearch extends SavedSearch { ownerSub: string; tenant: string }
export const savedSearchesFixture = defineFixture<StoredSearch>({
  key: 'saved-searches', scenarios: { default: () => [], empty: () => [], fresh: () => [] },
});
const str = (name: string, value: string) => ({ name, value: { stringValue: value } });
const ownerParams = (owner: SearchOwner) => [str('owner', owner.sub), str('tenant', owner.tenant)];
const owned = (row: StoredSearch, owner: SearchOwner) => row.ownerSub === owner.sub && row.tenant === owner.tenant;
function publicRow(row: StoredSearch): SavedSearch {
  const { ownerSub: _owner, tenant: _tenant, ...value } = row;
  return structuredClone(value);
}
function fromRow(row: Record<string, unknown>): SavedSearch {
  const payload = typeof row['payload'] === 'string' ? JSON.parse(row['payload']) : row['payload'];
  return { ...(payload as SavedSearchInput), id: String(row['id']), createdAt: String(row['created_at']), updatedAt: String(row['updated_at']) };
}
const columns = 'id::text, payload::text, created_at::text, updated_at::text';

/** Saved definitions only; results and transcripts are always resolved anew. */
export async function listSavedSearches(owner: SearchOwner): Promise<SavedSearch[]> {
  if (config.mock.aurora) return savedSearchesFixture.rows().filter(row => owned(row, owner))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicRow);
  return (await exec(`SELECT ${columns} FROM saved_searches WHERE owner_sub = :owner AND tenant_id = :tenant ORDER BY updated_at DESC`, ownerParams(owner))).map(fromRow);
}
export async function createSavedSearch(owner: SearchOwner, input: SavedSearchInput): Promise<SavedSearch> {
  const now = new Date().toISOString();
  const row: StoredSearch = { ...structuredClone(input), id: randomUUID(), createdAt: now, updatedAt: now, ownerSub: owner.sub, tenant: owner.tenant };
  if (config.mock.aurora) { savedSearchesFixture.rows().push(row); return publicRow(row); }
  const rows = await exec(`INSERT INTO saved_searches (id, owner_sub, tenant_id, payload)
    VALUES (CAST(:id AS uuid), :owner, :tenant, CAST(:payload AS jsonb)) RETURNING ${columns}`,
  [...ownerParams(owner), str('id', row.id), str('payload', JSON.stringify(input))]);
  if (!rows[0]) throw new Error('Saved search was not persisted');
  return fromRow(rows[0]);
}
export async function updateSavedSearch(owner: SearchOwner, id: string, patch: Partial<SavedSearchInput>): Promise<SavedSearch | null> {
  if (config.mock.aurora) {
    const row = savedSearchesFixture.rows().find(value => value.id === id && owned(value, owner));
    if (!row) return null;
    Object.assign(row, structuredClone(patch), { updatedAt: new Date().toISOString() });
    return publicRow(row);
  }
  const rows = await exec(`UPDATE saved_searches SET payload = payload || CAST(:payload AS jsonb), updated_at = now()
    WHERE id::text = :id AND owner_sub = :owner AND tenant_id = :tenant RETURNING ${columns}`,
  [...ownerParams(owner), str('id', id), str('payload', JSON.stringify(patch))]);
  return rows[0] ? fromRow(rows[0]) : null;
}
export async function deleteSavedSearch(owner: SearchOwner, id: string): Promise<boolean> {
  if (config.mock.aurora) {
    const rows = savedSearchesFixture.rows();
    const index = rows.findIndex(value => value.id === id && owned(value, owner));
    if (index < 0) return false;
    rows.splice(index, 1); return true;
  }
  return (await exec('DELETE FROM saved_searches WHERE id::text = :id AND owner_sub = :owner AND tenant_id = :tenant RETURNING id',
    [...ownerParams(owner), str('id', id)])).length > 0;
}
