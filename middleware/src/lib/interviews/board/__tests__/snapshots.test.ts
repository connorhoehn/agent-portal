// The whiteboard's checkpoints (lib/interviews/board/snapshots.ts): both stores hold the same contract, the SQL one
// run against a fake `exec` that answers each statement over rows in memory, and the service's rules on top.
jest.mock('../../../../config.js', () => ({ config: { mock: { aurora: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import {
  COUNT_BOARD_SNAPSHOTS_SQL, ERASE_BOARD_SNAPSHOTS_SQL, INSERT_BOARD_SNAPSHOT_SQL, LATEST_BOARD_SNAPSHOT_SQL, LIST_BOARD_SNAPSHOTS_SQL,
  MAX_BOARD_SNAPSHOTS, MemoryBoardSnapshotStore, SqlBoardSnapshotStore, checkBoardScene, readBoardSnapshots, saveBoardSnapshot, setBoardSnapshotStore,
  type BoardSnapshotStore,
} from '../snapshots.js';
import { blueprintBoard } from '../templates.js';

type Row = Record<string, unknown>;
function fakeExec(): (sql: string, params?: SqlParameter[]) => Promise<Row[]> {
  const rows: Row[] = [];
  return async (sql, params = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value?.stringValue ?? x.value?.longValue]));
    const mine = () => rows.filter((r) => r['interview_id'] === p['interview_id']).sort((a, b) => Number(a['seq']) - Number(b['seq']));
    if (sql === COUNT_BOARD_SNAPSHOTS_SQL) return [{ n: String(mine().length) }];
    if (sql === LATEST_BOARD_SNAPSHOT_SQL) return mine().slice(-1);
    if (sql === LIST_BOARD_SNAPSHOTS_SQL) return mine();
    if (sql === INSERT_BOARD_SNAPSHOT_SQL) {
      const row = { interview_id: p['interview_id'], seq: (Number(mine().slice(-1)[0]?.['seq'] ?? 0)) + 1, at: p['at'], who_id: p['who_id'], side: p['side'], elements: p['elements'], scene: p['scene'] };
      rows.push(row);
      return [row];
    }
    if (sql === ERASE_BOARD_SNAPSHOTS_SQL) {
      const ids = String(p['interview_ids']).split(',');
      const gone = rows.filter((r) => ids.includes(String(r['interview_id'])));
      rows.splice(0, rows.length, ...rows.filter((r) => !ids.includes(String(r['interview_id']))));
      return gone.map((r) => ({ seq: r['seq'] }));
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
}

describe.each([
  ['memory', () => new MemoryBoardSnapshotStore()],
  ['SQL', () => new SqlBoardSnapshotStore(fakeExec())],
] as Array<[string, () => BoardSnapshotStore]>)('the %s store', (_name, make) => {
  it('appends with the next seq, lists oldest first, gives the latest, and erases by interview', async () => {
    const store = make();
    expect(await store.latest('iv-a')).toBeNull();
    const at = '2026-11-18T10:00:00.000Z';
    await store.append('iv-a', { at, whoId: 'u-hugo', side: 'panel', elements: 1, scene: '[{"id":"a","type":"rectangle"}]' });
    await store.append('iv-a', { at, whoId: 'u-hugo', side: 'panel', elements: 2, scene: '[1,2]' });
    await store.append('iv-b', { at, whoId: 'u-wen', side: 'panel', elements: 0, scene: '[]' });
    expect((await store.list('iv-a')).map((r) => [r.seq, r.elements])).toEqual([[1, 1], [2, 2]]);
    expect(await store.latest('iv-a')).toMatchObject({ seq: 2, whoId: 'u-hugo', side: 'panel', scene: '[1,2]', at });
    expect(await store.count('iv-a')).toBe(2);
    expect(await store.erase(['iv-a'])).toBe(2);
    expect(await store.list('iv-a')).toEqual([]);
    expect(await store.count('iv-b')).toBe(1);
  });
});

describe('the service', () => {
  let store: MemoryBoardSnapshotStore;
  beforeEach(() => { store = new MemoryBoardSnapshotStore(); setBoardSnapshotStore(store); });
  afterAll(() => setBoardSnapshotStore(null));

  it('checks a scene: elements with an id and a type, the deleted ones dropped; anything else is refused', () => {
    expect(checkBoardScene([{ id: 'a', type: 'rectangle' }, { id: 'b', type: 'text', isDeleted: true }])).toEqual({ scene: '[{"id":"a","type":"rectangle"}]', elements: 1 });
    expect(checkBoardScene(blueprintBoard().elements)!.elements).toBe(42);
    expect(checkBoardScene('nope')).toBeNull();
    expect(checkBoardScene([{ id: 1, type: 'x' }])).toBeNull();
    expect(checkBoardScene([{ id: 'a', type: 'text', text: 'x'.repeat(600 * 1024) }])).toBeNull();
  });

  it('stores a checkpoint, skips one that repeats the last, and stops at the cap', async () => {
    const hugo = { id: 'u-hugo', side: 'panel' as const };
    const one = checkBoardScene([{ id: 'a', type: 'rectangle' }])!;
    expect(await saveBoardSnapshot('iv-a', hugo, one)).toBe(true);
    expect(await saveBoardSnapshot('iv-a', hugo, one)).toBe(false);
    for (let n = 1; n < MAX_BOARD_SNAPSHOTS; n++) await saveBoardSnapshot('iv-a', hugo, checkBoardScene([{ id: `e${n}`, type: 'rectangle' }])!);
    expect(await store.count('iv-a')).toBe(MAX_BOARD_SNAPSHOTS);
    expect(await saveBoardSnapshot('iv-a', hugo, checkBoardScene([{ id: 'late', type: 'rectangle' }])!)).toBe(false);
  });

  it('reads the checkpoints with the writer\'s name and the elements parsed', async () => {
    await saveBoardSnapshot('iv-a', { id: 'u-hugo', side: 'panel' }, checkBoardScene([{ id: 'a', type: 'rectangle' }])!, new Date('2026-11-18T10:00:00Z'));
    expect(await readBoardSnapshots('iv-a', () => 'Hugo Marchetti')).toEqual([
      { seq: 1, at: '2026-11-18T10:00:00.000Z', who: { id: 'u-hugo', name: 'Hugo Marchetti' }, elements: [{ id: 'a', type: 'rectangle' }] },
    ]);
  });
});
