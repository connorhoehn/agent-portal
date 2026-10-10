// Aurora half of the Social deck store: parameterized SQL, an idempotent insert
// keyed by the run-derived id, and the CAS append as ONE statement.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false, agentcore: false }, auth: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));

import { exec } from '../aurora.js';
import { deckIdForRun, saveGeneratedDeck, socialDeckStore } from '../social-decks.js';

const execMock = exec as unknown as jest.Mock;
const SPEC = { title: 'T', slides: [{ id: 'a', layout: 'bullets' as const, title: 'A', bullets: ['b'], sources: [{ documentId: 'social-message:m1', title: 'S' }] }] };
const RUN = 'sdk-0b1c2d3e-0000-4000-8000-000000000001';
const DECK_ROW = { id: 'sdeck-0b1c2d3e-0000-4000-8000-000000000001', channel: 'social:ch:general', run_id: RUN, title: 'T', created_by: 'u-sana', created_at: 'x', updated_at: 'x', head_revision_id: null };

afterEach(() => execMock.mockReset());

describe('social deck store (Aurora)', () => {
  it('derives the deck id from the run, so saving a run twice is one deck', () => {
    expect(deckIdForRun(RUN)).toBe('sdeck-0b1c2d3e-0000-4000-8000-000000000001');
    expect(deckIdForRun('sum-0b1c2d3e-0000-4000-8000-000000000001')).toBeNull();
    expect(deckIdForRun('sdk-x')).toBeNull();
  });

  it('inserts with ON CONFLICT DO NOTHING and bound parameters', async () => {
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([DECK_ROW]);
    const row = await socialDeckStore.insertDeck({ id: DECK_ROW.id, channel: DECK_ROW.channel, runId: RUN, title: 'T', createdBy: 'u-sana', headRevisionId: null });
    expect(row.id).toBe(DECK_ROW.id);
    const [sql, params] = execMock.mock.calls[0]!;
    expect(sql).toMatch(/INSERT INTO social_decks/);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(sql).not.toContain('u-sana');
    expect(params.map((p: { name: string }) => p.name)).toEqual(['id', 'channel', 'run_id', 'title', 'created_by']);
  });

  it('appends with one parameterized compare-and-set statement on the social tables', async () => {
    execMock.mockResolvedValueOnce([{ id: 'srev-1', deck_id: 'sdeck-1', seq: 1, base_revision_id: null, label: 'Generated', locked_slide_ids: '[]',
      produced_by: 'generated', created_by: 'u-sana', summary: null, created_at: '2026-10-06T12:00:00.000Z' }]);
    const result = await socialDeckStore.appendRevision({ id: 'srev-1', deckId: 'sdeck-1', baseRevisionId: null, label: 'Generated', spec: SPEC,
      lockedSlideIds: [], producedBy: 'generated', createdBy: 'u-sana', summary: null });
    expect(result).toMatchObject({ ok: true, revision: { id: 'srev-1', seq: 1 } });
    const [sql] = execMock.mock.calls[0]!;
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(sql).toMatch(/UPDATE social_decks SET head_revision_id = :id/);
    expect(sql).toMatch(/head_revision_id IS NOT DISTINCT FROM CAST\(:base_revision_id AS TEXT\)/);
    expect(sql).toMatch(/INSERT INTO social_deck_revisions/);
  });

  it('a save that loses the race to another save of the same run returns that deck, not an error', async () => {
    execMock
      .mockResolvedValueOnce([])                    // getDeck: not there yet
      .mockResolvedValueOnce([])                    // insert
      .mockResolvedValueOnce([DECK_ROW])            // insert read-back
      .mockResolvedValueOnce([])                    // append inserts nothing: the head moved
      .mockResolvedValueOnce([{ head_revision_id: 'srev-9' }]);
    const saved = await saveGeneratedDeck({ runId: RUN, channel: DECK_ROW.channel, spec: SPEC, summary: 's', sub: 'u-sana' });
    expect(saved).toEqual({ ok: true, value: { deckId: DECK_ROW.id, revisionId: 'srev-9', created: false } });
  });
});
