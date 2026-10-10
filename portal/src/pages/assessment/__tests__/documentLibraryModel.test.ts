import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactDocumentPath, libraryRows, presentationFiles, workspaceDocumentHref } from '../knowledge/documentLibraryModel.ts';
import type { DeckSummary } from '../decks/decksApi.ts';
import type { KnowledgeNode } from '../knowledge/types.ts';

const decks: DeckSummary[] = [
  { id: 'deck-a', title: 'Northstar review', teamId: 'TEAM-001', updatedAt: '2026-10-09T10:00:00Z', latestRevision: { id: 'rev-a', label: 'v7', createdAt: '2026-10-09T10:00:00Z', producedBy: 'assessor' } },
  { id: 'deck-b', title: 'Other review', teamId: 'TEAM-002', updatedAt: '2026-10-09T09:00:00Z', latestRevision: null },
];

test('team presentation files preserve native read routes and saved versions, excluding another team', () => {
  const files = presentationFiles(decks, { id: 'TEAM-001', name: 'Northstar Payments' });
  assert.equal(files.length, 1);
  assert.equal(files[0]?.kind, 'presentation');
  assert.equal(files[0]?.id, 'presentation:deck-a');
  assert.equal(files[0]?.href, '/assessment/decks/deck-a');
  assert.equal(files[0]?.summary, 'PowerPoint · v7');
  assert.equal(files[0]?.folder, 'Presentations / Northstar Payments');
  assert.equal(presentationFiles(decks)[1]?.summary, 'No saved version yet');
  assert.deepEqual(decks[0]?.latestRevision?.label, 'v7');
});

test('the shared file list keeps knowledge documents and presentations in the same searchable collection', () => {
  const rows = libraryRows([{ key: 'confluence-eng', title: 'Team Space', kind: 'synced', nodes: [
    { id: 'page:1', title: 'Program', is_dir: true, parent_id: null },
    { id: 'page:2', title: 'Rubric Overview', is_dir: false, parent_id: 'page:1' },
  ] }], presentationFiles(decks));
  assert.deepEqual(rows.map(row => row.id), ['page:2', 'presentation:deck-a', 'presentation:deck-b']);
  assert.equal(rows[0]?.folder, 'Team Space / Program');
  assert.equal(rows[0]?.href, undefined);
  assert.equal(rows[1]?.sectionKey, 'presentations');
  assert.ok(rows[1]?.search.includes('team-001'));
  assert.equal(workspaceDocumentHref('page:100002'), '/assessment/workspace?doc=page%3A100002');
});

test('deep document breadcrumb retains its meaningful nearest parent and actual document', () => {
  const nodes: KnowledgeNode[] = ['Program', 'Northstar', 'Architecture', 'Deployment guide'].map((title, index) => ({ id: String(index), title, parent_id: index ? String(index - 1) : null, is_dir: index < 3 }));
  assert.deepEqual(compactDocumentPath(nodes).map(node => node.title), ['Architecture', 'Deployment guide']);
  assert.deepEqual(compactDocumentPath(nodes.slice(0, 1)).map(node => node.title), ['Program']);
});
