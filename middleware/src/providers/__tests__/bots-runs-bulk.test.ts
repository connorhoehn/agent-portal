// listBotRunsForBotsResult — the merged, multi-bot run history
// InitiativeAgentRail reads instead of firing one GET /:id/runs per bot.
//
// What is pinned: the SQL caps each bot's contribution the same way the
// single-bot query does (a window function, not a flat LIMIT that would let
// one busy bot crowd a quiet bot's runs out of the merge); a degraded read
// from ANY bot marks the whole merged answer, same "unknown, not empty"
// contract as the rest of this module; ids are de-duplicated and non-UUIDs
// are dropped before they ever reach SQL; and an empty id list short-circuits
// without a query at all.

const exec = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...a: unknown[]) => exec(...a) }));
jest.mock('../budgets.js', () => ({ spendPredicateSql: () => '1=1', listGrants: jest.fn(), getBudget: jest.fn() }));
jest.mock('../work-items.js', () => ({ getWorkItem: jest.fn(), mockWorkItemProjectId: jest.fn() }));
jest.mock('../projects.js', () => ({ mockProjectName: jest.fn() }));

const BOT_A = '11111111-2222-3333-4444-555555555555';
const BOT_B = '66666666-7777-8888-9999-000000000000';

beforeEach(() => exec.mockReset());

describe('listBotRunsForBotsResult — real Aurora path', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
  });

  it('returns [] without querying when no valid ids are given', async () => {
    const { listBotRunsForBotsResult } = await import('../bots.js');
    const r = await listBotRunsForBotsResult(['not-a-uuid', '']);
    expect(r).toEqual({ items: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('de-duplicates ids and drops non-UUIDs before binding params', async () => {
    exec.mockResolvedValue([]);
    const { listBotRunsForBotsResult } = await import('../bots.js');
    await listBotRunsForBotsResult([BOT_A, BOT_A, 'bogus'], 50);
    const sql = String(exec.mock.calls[0]?.[0] ?? '');
    const params = exec.mock.calls[0]?.[1] as Array<{ name: string }>;
    expect(sql).toContain(':bid0::uuid');
    expect(sql).not.toContain(':bid1');
    expect(params.filter((p) => p.name.startsWith('bid'))).toHaveLength(1);
  });

  it('caps each bot at limitPerBot via a window function, not a flat LIMIT', async () => {
    exec.mockResolvedValue([]);
    const { listBotRunsForBotsResult } = await import('../bots.js');
    await listBotRunsForBotsResult([BOT_A, BOT_B], 25);
    const sql = String(exec.mock.calls[0]?.[0] ?? '');
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY bot_id ORDER BY started_at DESC\)/);
    expect(sql).toMatch(/WHERE rn <= :lim/);
  });

  it('merges rows across bots into one BotRun list', async () => {
    exec.mockResolvedValue([
      { id: 'run-1', bot_id: BOT_A, trigger: 'cron', status: 'done', started_at: '2026-09-01T00:00:00Z' },
      { id: 'run-2', bot_id: BOT_B, trigger: 'manual', status: 'running', started_at: '2026-09-02T00:00:00Z' },
    ]);
    const { listBotRunsForBotsResult } = await import('../bots.js');
    const r = await listBotRunsForBotsResult([BOT_A, BOT_B]);
    expect(r.items.map((run) => run.id)).toEqual(['run-1', 'run-2']);
    expect(r.items.map((run) => run.botId)).toEqual([BOT_A, BOT_B]);
  });

  it('a missing bot_runs table degrades the merged answer, not a 500', async () => {
    exec.mockRejectedValue(new Error('relation "bot_runs" does not exist'));
    const { listBotRunsForBotsResult } = await import('../bots.js');
    const r = await listBotRunsForBotsResult([BOT_A]);
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
  });
});

describe('listBotRunsForBotsResult — mock mode', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
  });

  it('returns [] for an empty id list with no provider call', async () => {
    const { listBotRunsForBotsResult } = await import('../bots.js');
    expect(await listBotRunsForBotsResult([])).toEqual({ items: [] });
  });

  it('merges each bot’s mock run history the same way listBotRuns would, per id', async () => {
    const { listBotRunsForBotsResult, listBotRuns } = await import('../bots.js');
    const [a, b] = await Promise.all([listBotRuns(BOT_A, 50), listBotRuns(BOT_B, 50)]);
    const merged = await listBotRunsForBotsResult([BOT_A, BOT_B], 50);
    expect(merged.items.map((r) => r.id).sort()).toEqual([...a, ...b].map((r) => r.id).sort());
  });
});
