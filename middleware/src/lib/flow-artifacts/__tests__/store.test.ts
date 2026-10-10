// The shared revision store, mock half: CAS on baseRevisionId, seq, the head
// pointer, and the id/label conventions both tenants rely on.

jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true, agentcore: false }, auth: {} } }));
jest.mock('../../../providers/aurora.js', () => ({ exec: jest.fn() }));

import { createArtifactRevisionStore, revisionLabel, type ArtifactRevision } from '../store.js';

type Spec = { title: string };
const artifacts = [{ id: 'x-1', headRevisionId: null as string | null, updatedAt: '' }];
const revisions: Array<ArtifactRevision<Spec>> = [];
const store = createArtifactRevisionStore<Spec>({
  tenant: 't', subjectKind: 'thing', idPrefix: 'x', revisionPrefix: 'xr', artifactTable: 'a', revisionTable: 'r',
  emptySpec: { title: '' }, mock: { artifacts: () => artifacts, revisions: () => revisions },
});
const rev = (id: string, base: string | null) => ({ id, deckId: 'x-1', baseRevisionId: base, label: 'L', spec: { title: id },
  lockedSlideIds: ['s'], producedBy: 'person:u', createdBy: 'u', summary: null });

describe('flow-artifacts revision store', () => {
  it('appends with CAS and reports the winning head on conflict', async () => {
    const first = await store.append(rev('xr-1', null));
    expect(first).toMatchObject({ ok: true, revision: { seq: 1 } });
    expect(await store.append(rev('xr-2', null))).toEqual({ ok: false, reason: 'conflict', head: 'xr-1' });
    expect(await store.append(rev('xr-3', 'xr-1'))).toMatchObject({ ok: true, revision: { seq: 2 } });
    expect(await store.headOf('x-1')).toBe('xr-3');
    expect((await store.listRevisions('x-1')).map((r) => r.id)).toEqual(['xr-3', 'xr-1']);
    expect(await store.append({ ...rev('xr-9', null), deckId: 'nope' })).toEqual({ ok: false, reason: 'missing', head: null });
    expect(store.conflictDetails('xr-3')).toEqual({ activeRevisionId: 'xr-3' });
  });
  it('mints and validates prefixed ids; labels are v<seq>', () => {
    expect(store.isArtifactId(store.newArtifactId())).toBe(true);
    expect(store.isRevisionId(store.newRevisionId())).toBe(true);
    expect(store.isRevisionId(store.newArtifactId())).toBe(false);
    expect(revisionLabel(3)).toBe('v3');
  });
});
