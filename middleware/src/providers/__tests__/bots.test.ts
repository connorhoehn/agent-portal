// The opt-in bot-fire allocation flag on the bot read/write model. The column
// is additive (bots.enforce_allocation, DEFAULT FALSE): it must map to a plain
// boolean, default off when a pre-migration row carries no such key, and be
// settable through updateBot the same way enabled/requiresReview are.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { getBot, updateBot } from '../bots.js';

const sql = exec as unknown as jest.Mock;
const BOT_ID = '11111111-2222-3333-4444-555555555555';

/** A minimal bots row as SELECT b.* would return it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOT_ID, name: 'Dep bumps', template: 'story', prompt_template: 'Bump deps.',
    agent_project_id: null, agent_project_repo: null, org_project_id: 'p-observability',
    org_project_name: 'Observability Platform', model: 'sonnet', trigger: 'cron',
    cron_expr: '0 6 * * *', enabled: true, budget_per_run_usd: null, budget_per_day_usd: null,
    max_runs_per_day: 4, requires_review: true, enforce_allocation: false,
    created_by: null, created_at: '2026-08-01T00:00:00Z', last_run_at: null, paused_reason: null,
    today_spend_usd: 0, today_run_count: 0,
    ...over,
  };
}

/** Every statement's flattened SQL, for matching the write. */
function allSql(): string {
  return sql.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ')).join(' || ');
}
function allParamNames(): string[] {
  return sql.mock.calls.flatMap((c) => (c[1] ?? []) as Array<{ name: string }>).map((p) => p.name);
}

beforeEach(() => sql.mockReset());

describe('getBot maps enforce_allocation', () => {
  it('reads a true flag as true', async () => {
    sql.mockResolvedValue([row({ enforce_allocation: true })]);
    expect((await getBot(BOT_ID))?.enforceAllocation).toBe(true);
  });

  it('reads a false flag as false', async () => {
    sql.mockResolvedValue([row({ enforce_allocation: false })]);
    expect((await getBot(BOT_ID))?.enforceAllocation).toBe(false);
  });

  it('defaults to false on a pre-migration row that has no such key', async () => {
    const r = row();
    delete r['enforce_allocation'];
    sql.mockResolvedValue([r]);
    expect((await getBot(BOT_ID))?.enforceAllocation).toBe(false);
  });
});

describe('updateBot writes enforce_allocation', () => {
  it('sets the column and binds a boolean param when the patch carries it', async () => {
    // First exec: the UPDATE ... RETURNING id; second: the getBot re-read.
    sql.mockResolvedValueOnce([{ id: BOT_ID }]).mockResolvedValueOnce([row({ enforce_allocation: true })]);

    const bot = await updateBot(BOT_ID, { enforceAllocation: true });

    expect(allSql()).toContain('enforce_allocation = :enfalloc');
    expect(allParamNames()).toContain('enfalloc');
    expect(bot?.enforceAllocation).toBe(true);
  });

  it('does not touch the column when the patch omits it', async () => {
    sql.mockResolvedValueOnce([{ id: BOT_ID }]).mockResolvedValueOnce([row()]);
    await updateBot(BOT_ID, { enabled: true });
    expect(allSql()).not.toContain('enforce_allocation');
  });
});
