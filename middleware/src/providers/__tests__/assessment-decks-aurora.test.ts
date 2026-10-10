// The Aurora half of the review-deck store: parameterized SQL, and the CAS
// append as ONE statement (head check + insert), so a stale base inserts
// nothing and is reported as a conflict naming the current head.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false, agentcore: false }, auth: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));

import { exec } from '../aurora.js';
import { deckStore } from '../assessment-decks.js';

const execMock = exec as unknown as jest.Mock;
const SPEC = { title: 'T', slides: [{ id: 'a', layout: 'bullets' as const, title: 'A', bullets: ['b'], sources: [{ documentId: 'assessment:TEAM-001:all', title: 'S' }] }] };
const REV = {
  id: 'rev-1', deckId: 'deck-1', baseRevisionId: 'rev-0', label: 'Edited', spec: SPEC,
  lockedSlideIds: [], producedBy: 'person:u-a', createdBy: 'u-a', summary: null,
};

afterEach(() => execMock.mockReset());

describe('assessment deck store (Aurora)', () => {
  it('appends with one parameterized compare-and-set statement', async () => {
    execMock.mockResolvedValueOnce([{ id: 'rev-1', deck_id: 'deck-1', seq: 2, base_revision_id: 'rev-0', label: 'Edited',
      locked_slide_ids: '[]', produced_by: 'person:u-a', created_by: 'u-a', summary: null, created_at: '2026-10-05T12:00:00.000Z' }]);
    const result = await deckStore.appendRevision(REV);
    expect(result).toMatchObject({ ok: true, revision: { id: 'rev-1', seq: 2, spec: SPEC } });
    expect(execMock).toHaveBeenCalledTimes(1);
    const [sql, params] = execMock.mock.calls[0]!;
    expect(sql).toMatch(/UPDATE assessment_decks SET head_revision_id = :id/);
    expect(sql).toMatch(/head_revision_id IS NOT DISTINCT FROM CAST\(:base_revision_id AS TEXT\)/);
    expect(sql).toMatch(/INSERT INTO assessment_deck_revisions/);
    expect(sql).not.toContain('rev-0');
    expect(params).toEqual(expect.arrayContaining([
      { name: 'base_revision_id', value: { stringValue: 'rev-0' } },
      { name: 'spec', value: { stringValue: JSON.stringify(SPEC) } },
    ]));
  });

  it('a stale base inserts nothing and reports the current head', async () => {
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'deck-1', team_id: 'TEAM-001', title: 'T', audience: null,
      dimension_ids: '[]', created_by: null, created_at: 'x', updated_at: 'x', head_revision_id: 'rev-9', last_run_id: null }]);
    expect(await deckStore.appendRevision(REV)).toEqual({ ok: false, reason: 'conflict', head: 'rev-9' });
  });

  it('a first revision names a null base', async () => {
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await deckStore.appendRevision({ ...REV, baseRevisionId: null })).toEqual({ ok: false, reason: 'missing', head: null });
    expect(execMock.mock.calls[0]![1]).toEqual(expect.arrayContaining([{ name: 'base_revision_id', value: { isNull: true } }]));
  });
});
