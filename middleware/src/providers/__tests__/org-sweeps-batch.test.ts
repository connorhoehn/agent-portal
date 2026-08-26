// runSweep persists a sweep's findings. The property under test here is the
// write shape, not the sweep logic: N findings must upsert in ONE multi-row
// INSERT (not a write per finding on a scheduled interval), and zero findings
// must issue no INSERT at all. created/updated counts must still be exact,
// since RETURNING (xmax = 0) distinguishes an inserted row from an updated one.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { runSweep } from '../org-sweeps.js';

const mockExec = exec as jest.MockedFunction<typeof exec>;

const isInsert = (call: unknown[]) => String(call[0]).includes('INSERT INTO agent_findings');
const insertCalls = () => mockExec.mock.calls.filter(isInsert);

beforeEach(() => {
  mockExec.mockReset();
});

describe('runSweep write shape', () => {
  it('upserts N findings in a single INSERT', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM skills')) {
        // Three skills → three draft findings.
        return [
          { skill_id: 'sk-1', skill_name: 'A', holders: 1, holder_names: 'Ada', holder_ids: 'p1' },
          { skill_id: 'sk-2', skill_name: 'B', holders: 2, holder_names: 'Ada, Bob', holder_ids: 'p1,p2' },
          { skill_id: 'sk-3', skill_name: 'C', holders: 2, holder_names: 'Cy, Di', holder_ids: 'p3,p4' },
        ];
      }
      if (sql.includes('INSERT INTO agent_findings')) {
        // Two brand-new (xmax = 0), one already existed.
        return [{ inserted: true }, { inserted: true }, { inserted: false }];
      }
      return []; // resolve UPDATE
    });

    const res = await runSweep('bus_factor');

    // Exactly one INSERT for all three findings.
    expect(insertCalls()).toHaveLength(1);

    // That one statement carries three value tuples and their positional params.
    const [sql, params] = insertCalls()[0] as [string, Array<{ name: string }>];
    expect(sql).toContain(':fp_0');
    expect(sql).toContain(':fp_1');
    expect(sql).toContain(':fp_2');
    expect(sql).not.toContain(':fp_3');
    // One shared :sweep param + 7 per-row params × 3 rows.
    const names = params.map((p) => p.name);
    expect(names).toContain('sweep');
    expect(names.filter((n) => /^fp_\d+$/.test(n))).toHaveLength(3);
    expect(params).toHaveLength(1 + 7 * 3);

    // created/updated derived per returned row, not per-call.
    expect(res.found).toBe(3);
    expect(res.created).toBe(2);
    expect(res.updated).toBe(1);
  });

  it('issues no INSERT when a sweep finds nothing', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM skills')) return [];
      return []; // resolve UPDATE (empty-drafts branch)
    });

    const res = await runSweep('bus_factor');

    expect(insertCalls()).toHaveLength(0);
    expect(res.found).toBe(0);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
  });
});
