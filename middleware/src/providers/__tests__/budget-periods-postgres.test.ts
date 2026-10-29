// Opt-in SQL acceptance for budget periods (DE-38) against a disposable
// PostgreSQL container: schema/budget_periods_schema.sql applies (twice) on a
// cluster that already holds monthly allocations, the `budget_windows` CTE
// returns the same bounds as lib/budget-periods.ts at the database's own NOW(),
// and the close row, the carry and the brake run their exact SQL. Only the RDS
// Data API transport is replaced (each autocommit `exec` is its own psql
// process; `withTransaction` one held session). This does NOT establish Aurora
// or Data API binding.
//
//   REAL_BUDGET_PERIODS_POSTGRES=1 ORGIQ_BUDGET_PERIODS_POSTGRES_CONTAINER=<name> \
//   [ORGIQ_DOCKER='colima ssh -- sudo docker'] npx jest budget-periods-postgres
//
// The container must carry the label orgiq.validation=budget-periods-postgres.
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec, withTransaction } from '../aurora.js';
import { _resetColumnProbes } from '../column-probe.js';
import { reserveSpend } from '../../lib/spend-holds.js';
import { getBudget, listBudgets, upsertAllocation } from '../budgets.js';
import {
  budgetWindowsCteSql, currentPeriod, periodStartForSql, previousPeriod, withBudgetWindowsSql,
  type BudgetPeriod, type SprintSpan,
} from '../../lib/budget-periods.js';

const enabled = process.env['REAL_BUDGET_PERIODS_POSTGRES'] === '1';
const container = process.env['ORGIQ_BUDGET_PERIODS_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const SCHEMA = 'budget_periods_acceptance';
const read = (name: string) => readFileSync(`${process.cwd()}/../schema/${name}`, 'utf8');
// load_schema.py's order up to the money files.
const base = [
  'orgiq_schema.sql', 'search_workspace_schema.sql', 'identity_schema.sql', 'social_schema.sql', 'observability_schema.sql',
  'observability_authz_schema.sql', 'observability_sprint1_schema.sql', 'observability_sprint2_schema.sql',
  'observability_sprint3_promote_schema.sql', 'observability_sprint4_calibration_schema.sql',
  'observability_sprint4_memory_schema.sql', 'observability_sprint5_canary_schema.sql',
  'observability_sprint6_prompt_history_schema.sql', 'prompt_contract_schema.sql', 'observability_approvals_schema.sql',
  'orgiq_kb_registry_schema.sql', 'orgiq_work_items_schema.sql', 'work_item_key_schema.sql', 'work_item_documents_schema.sql',
  'agentic_work_schema.sql', 'kb_upload_links_schema.sql', 'agent_projects_schema.sql', 'agent_sdlc_schema.sql',
  'lab_loop_schema.sql', 'devbox_fleet_schema.sql', 'agent_bots_schema.sql', 'agent_budgets_schema.sql', 'program_schema.sql',
  'spend_ledger_schema.sql', 'spend_ledger_provider_schema.sql', 'spend_holds_schema.sql',
  'user_budgets_schema.sql', 'budget_hard_caps_schema.sql', 'maintenance_reserve_schema.sql',
].map(read).join('\n');
const periods = read('budget_periods_schema.sql');
const NULL = '__PG_NULL__';
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const prelude = `SET search_path TO ${SCHEMA}, public; SET client_min_messages TO warning; SET TIME ZONE 'UTC';\n`;

function psqlArgs(): string[] {
  return [...docker.slice(1), 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-P', `null=${NULL}`, '-U', 'postgres', '-d', 'postgres'];
}
function psql(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(docker[0]!, psqlArgs(), { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    child.stdin!.end(`${prelude}${input}\n`);
  });
}

function parseCsv(text: string): Record<string, string | null>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => !(r.length === 1 && r[0] === '') && r[0] !== 'SET');
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === NULL ? null : r[i] ?? null])));
}

function bind(statement: string, params: SqlParameter[] = []): string {
  const bindings = new Map<string, string>((params ?? []).map((p) => {
    const v = (p.value ?? {}) as { isNull?: boolean; stringValue?: string; doubleValue?: number; longValue?: number; booleanValue?: boolean };
    if (v.isNull) return [p.name!, 'NULL'];
    if (v.stringValue !== undefined) return [p.name!, literal(v.stringValue)];
    if (v.doubleValue !== undefined) return [p.name!, String(v.doubleValue)];
    if (v.longValue !== undefined) return [p.name!, String(v.longValue)];
    if (v.booleanValue !== undefined) return [p.name!, v.booleanValue ? 'TRUE' : 'FALSE'];
    throw new Error(`unsupported parameter ${p.name}`);
  }));
  return statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (!bindings.has(name)) throw new Error(`Unbound parameter ${name}`);
    return bindings.get(name)!;
  });
}

async function rows(statement: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  return parseCsv(await psql(`${bind(statement, params)};`));
}

class Session {
  private out = '';
  private err = '';
  private n = 0;
  private readonly child = spawn(docker[0]!, psqlArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
  constructor() {
    this.child.stdout.on('data', (d: Buffer) => { this.out += d.toString(); });
    this.child.stderr.on('data', (d: Buffer) => { this.err += d.toString(); });
    this.child.stdin.write(prelude);
  }
  query(statement: string): Promise<Record<string, string | null>[]> {
    const marker = `__done_${++this.n}__`;
    this.child.stdin.write(`${statement};\n\\echo ${marker}\n`);
    return new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const at = this.out.indexOf(`${marker}\n`);
        if (at >= 0) {
          clearInterval(poll);
          const text = this.out.slice(0, at);
          this.out = this.out.slice(at + marker.length + 1);
          resolve(parseCsv(text));
        } else if (this.child.exitCode !== null || this.err.includes('ERROR')) {
          clearInterval(poll);
          reject(new Error(this.err || `psql exited ${this.child.exitCode}`));
        }
      }, 5);
    });
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.once('close', r));
  }
}

async function inTransaction<T>(fn: (tx: (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const s = new Session();
  try {
    await s.query('BEGIN');
    try {
      const out = await fn((sql, params = []) => s.query(bind(sql, params)));
      await s.query('COMMIT');
      return out;
    } catch (err) {
      await s.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally { await s.close(); }
}

const one = async (q: string) => (await rows(q))[0] ?? {};
const ts = (v: unknown): number | null => {
  if (v == null) return null;
  let t = String(v).replace(' ', 'T');
  if (/[+-]\d\d$/.test(t)) t += ':00';
  return Date.parse(t);
};

(enabled ? describe : describe.skip)('budget periods with real PostgreSQL', () => {
  jest.setTimeout(180_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_BUDGET_PERIODS_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'budget-periods-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await psql(`CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}, public;
      ${base}`);
    jest.mocked(exec).mockImplementation(rows as never);
    jest.mocked(withTransaction).mockImplementation(inTransaction as never);
  });

  beforeEach(() => {
    delete process.env['SPEND_LEDGER'];
    delete process.env['SPEND_HOLDS'];
    _resetColumnProbes();
  });

  // ── The migration ──────────────────────────────────────────────────────

  it('applies twice on a cluster with existing monthly rows; reads work before it; weekly still fails', async () => {
    await psql(`INSERT INTO projects (id, name) VALUES ('p-old', 'Old') ON CONFLICT DO NOTHING;
      INSERT INTO initiative_budgets (org_project_id, allocated_usd) VALUES ('p-old', 20) ON CONFLICT DO NOTHING;`);
    // A pre-DE-38 cluster: the read path names no new column, so it still answers.
    expect(await getBudget('p-old')).toMatchObject({ period: 'monthly', carryOver: 'none', carryInUsd: 0, effectiveAllocatedUsd: 20 });

    await psql(periods);
    await psql(periods); // repeatable
    expect(await one(`SELECT period, carry_over, rolling_days FROM initiative_budgets WHERE org_project_id = 'p-old'`))
      .toEqual({ period: 'monthly', carry_over: 'none', rolling_days: null });
    expect((await one(`SELECT convalidated FROM pg_constraint WHERE conname = 'initiative_budgets_period_shape'`))['convalidated']).toBe('t');

    await expect(psql(`UPDATE initiative_budgets SET period = 'weekly' WHERE org_project_id = 'p-old'`)).rejects.toThrow(/initiative_budgets_period_check/);
    await expect(psql(`UPDATE initiative_budgets SET period = 'rolling' WHERE org_project_id = 'p-old'`)).rejects.toThrow(/initiative_budgets_period_shape/);
    await expect(psql(`UPDATE initiative_budgets SET period = 'rolling', rolling_days = 7, carry_over = 'both' WHERE org_project_id = 'p-old'`)).rejects.toThrow(/initiative_budgets_period_shape/);
    await psql(`UPDATE initiative_budgets SET period = 'rolling', rolling_days = 7 WHERE org_project_id = 'p-old';
      UPDATE initiative_budgets SET period = 'monthly', rolling_days = NULL WHERE org_project_id = 'p-old'`);
  });

  it('allows one active sprint per initiative', async () => {
    await psql(`INSERT INTO projects (id, name) VALUES ('p-spr', 'Spr') ON CONFLICT DO NOTHING;
      INSERT INTO sprints (id, org_project_id, name, starts_on, ends_on, status) VALUES ('spr-x1', 'p-spr', 'S1', CURRENT_DATE - 3, CURRENT_DATE + 3, 'active')`);
    await expect(psql(`INSERT INTO sprints (id, org_project_id, name, starts_on, ends_on, status) VALUES ('spr-x2', 'p-spr', 'S2', CURRENT_DATE + 4, CURRENT_DATE + 10, 'active')`))
      .rejects.toThrow(/sprints_one_active_per_initiative/);
    await psql(`INSERT INTO sprints (id, org_project_id, name, starts_on, ends_on, status) VALUES ('spr-x2', 'p-spr', 'S2', CURRENT_DATE + 4, CURRENT_DATE + 10, 'planned');
      DELETE FROM sprints WHERE org_project_id = 'p-spr'; DELETE FROM projects WHERE id = 'p-spr'`);
  });

  // ── The SQL twin ───────────────────────────────────────────────────────

  it('the budget_windows CTE returns the same bounds as currentPeriod / previousPeriod, at the database clock', async () => {
    // The seed's sprint shape (schema/seed_program.sql: NOW() - N days), plus one initiative per period.
    await psql(`TRUNCATE budget_period_closes, initiative_budgets, sprints CASCADE;
      INSERT INTO projects (id, name) VALUES ('p-m', 'M'), ('p-q', 'Q'), ('p-r', 'R'), ('p-s', 'S'), ('p-gap', 'Gap'), ('p-none', 'None'), ('p-first', 'First')
        ON CONFLICT DO NOTHING;
      INSERT INTO initiative_budgets (org_project_id, allocated_usd, period, rolling_days) VALUES
        ('p-m', 10, 'monthly', NULL), ('p-q', 10, 'quarterly', NULL), ('p-r', 10, 'rolling', 7),
        ('p-s', 10, 'sprint', NULL), ('p-gap', 10, 'sprint', NULL), ('p-first', 10, 'sprint', NULL);
      INSERT INTO sprints (id, org_project_id, name, starts_on, ends_on, status) VALUES
        ('spr-s1', 'p-s', 'S9',  (NOW() - INTERVAL '42 days')::date, (NOW() - INTERVAL '28 days')::date, 'done'),
        ('spr-s2', 'p-s', 'S10', (NOW() - INTERVAL '28 days')::date, (NOW() - INTERVAL '14 days')::date, 'done'),
        ('spr-s3', 'p-s', 'S11', (NOW() - INTERVAL '14 days')::date, (NOW() + INTERVAL '0 days')::date, 'active'),
        ('spr-g1', 'p-gap', 'G1', (NOW() - INTERVAL '30 days')::date, (NOW() - INTERVAL '16 days')::date, 'done'),
        ('spr-g2', 'p-gap', 'G2', (NOW() + INTERVAL '2 days')::date, (NOW() + INTERVAL '16 days')::date, 'planned'),
        ('spr-f1', 'p-first', 'F1', (NOW() - INTERVAL '7 days')::date, (NOW() + INTERVAL '7 days')::date, 'active');`);
    const out = await rows(`WITH ${budgetWindowsCteSql()} SELECT bw.*, NOW() AS db_now FROM budget_windows bw ORDER BY bw.org_project_id`);
    const spr = await rows(`SELECT id, org_project_id, starts_on::text AS starts_on, ends_on::text AS ends_on, status FROM sprints`);
    const policy: Record<string, { period: BudgetPeriod; rollingDays?: number } | null> = {
      'p-m': { period: 'monthly' }, 'p-q': { period: 'quarterly' }, 'p-r': { period: 'rolling', rollingDays: 7 },
      'p-s': { period: 'sprint' }, 'p-gap': { period: 'sprint' }, 'p-first': { period: 'sprint' }, 'p-none': null,
    };
    let compared = 0;
    for (const r of out) {
      const id = String(r['org_project_id']);
      if (!(id in policy)) continue;
      const now = new Date(ts(r['db_now'])!);
      const spans: SprintSpan[] = spr.filter((x) => x['org_project_id'] === id)
        .map((x) => ({ id: String(x['id']), startsOn: String(x['starts_on']), endsOn: String(x['ends_on']), status: String(x['status']) }));
      const cur = currentPeriod(policy[id]!, now, spans);
      const prev = previousPeriod(policy[id]!, now, spans);
      expect({ id, start: ts(r['period_start']), end: ts(r['period_end']), key: r['period_key'], state: r['period_state'] })
        .toEqual({ id, start: cur.start.getTime(), end: cur.end.getTime(), key: cur.key, state: cur.state });
      expect({ id, start: ts(r['prev_start']), end: ts(r['prev_end']), key: r['prev_key'] })
        .toEqual({ id, start: prev ? prev.start.getTime() : null, end: prev ? prev.end.getTime() : null, key: prev?.key ?? null });
      compared++;
    }
    expect(compared).toBe(7);
    // The two shapes the decisions name, explicitly.
    expect(out.find((r) => r['org_project_id'] === 'p-gap')).toMatchObject({ period_state: 'between-sprints', period_key: null });
    expect(out.find((r) => r['org_project_id'] === 'p-s')).toMatchObject({ period_key: 'spr-s3', prev_key: 'spr-s2' });
    // The scalar the Projects rollup reads is the same start.
    const scalar = await one(`${withBudgetWindowsSql()}SELECT ${periodStartForSql(`'p-q'`)} AS s, date_trunc('quarter', NOW()) AS q`);
    expect(ts(scalar['s'])).toBe(ts(scalar['q']));
  });

  // ── Closes and the brakes, through the providers' exact SQL ─────────────

  async function world(): Promise<void> {
    await psql(`TRUNCATE spend_holds, spend_entries, bot_runs, bots, budget_period_closes, initiative_budgets, sprints CASCADE;
      INSERT INTO projects (id, name) VALUES ('p-alpha', 'Alpha') ON CONFLICT DO NOTHING;
      INSERT INTO bots (id, name, template, prompt_template, org_project_id, model, trigger)
        VALUES ('00000000-0000-0000-0000-0000000000b1', 'nightly', 'story', 'x', 'p-alpha', 'amazon.nova-pro-v1:0', 'manual');`);
  }
  const run = (n: number, usd: number | null, when: string) =>
    `('00000000-0000-0000-0000-00000000${String(n).padStart(4, '0')}', '00000000-0000-0000-0000-0000000000b1', 'manual', 'done', ${usd ?? 'NULL'}, ${when})`;

  it('unspent with a $10 cap: $25 left last month → effective = allocation + 10; parallel and retried closes leave one row', async () => {
    await world();
    await psql(`INSERT INTO initiative_budgets (org_project_id, allocated_usd, carry_over, carry_over_cap_usd) VALUES ('p-alpha', 40, 'unspent', 10);
      INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, started_at) VALUES
        ${run(1, 15, `date_trunc('month', NOW()) - INTERVAL '10 days'`)},
        ${run(2, null, `date_trunc('month', NOW()) - INTERVAL '9 days'`)},
        ${run(3, 2, `NOW() - INTERVAL '1 second'`)};`);
    const results = await Promise.all(Array.from({ length: 5 }, () => getBudget('p-alpha')));
    for (const r of results) expect(r).toMatchObject({ allocatedUsd: 40, carryInUsd: 10, effectiveAllocatedUsd: 50, spentThisPeriodUsd: 2 });
    await getBudget('p-alpha');
    await listBudgets();
    const closes = await rows(`SELECT period_key, allocated_usd::float8 AS a, spent_usd::float8 AS s, unknown_cost_entries AS u, carry_out_usd::float8 AS c, reason FROM budget_period_closes`);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ a: '40', s: '15', u: '1', c: '10', reason: 'boundary' });
    expect(String(closes[0]!['period_key'])).toMatch(/^\d{4}-\d\d$/);
  });

  it('decideAllocation refuses against the effective allocation (an overspend carried in), not the raw one', async () => {
    await world();
    await psql(`INSERT INTO initiative_budgets (org_project_id, allocated_usd, carry_over) VALUES ('p-alpha', 10, 'overspend');
      INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, started_at) VALUES ${run(4, 14, `date_trunc('month', NOW()) - INTERVAL '3 days'`)};`);
    const r = await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-p:1', forecast: { costUsdP75: 7 }, expiresInMs: 60_000 });
    expect(r).toMatchObject({ kind: 'confirm', gate: 'allocation', allocation: { allocatedUsd: 6, carryInUsd: -4 } });
    await psql(`UPDATE initiative_budgets SET carry_over = 'none'`);
    const raw = await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-p:2', forecast: { costUsdP75: 7 }, expiresInMs: 60_000 });
    expect(raw.kind).toBe('held');
  });

  it('a policy write closes the outgoing window (carry 0) and stamps carry_over_since in one upsert', async () => {
    await world();
    await psql(`INSERT INTO initiative_budgets (org_project_id, allocated_usd) VALUES ('p-alpha', 10);
      INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, started_at) VALUES ${run(5, 3, `NOW() - INTERVAL '1 second'`)};`);
    const row = await upsertAllocation('p-alpha', 10, 'u-eli', { period: 'quarterly', carryOver: 'unspent' });
    expect(row).toMatchObject({ period: 'quarterly', carryOver: 'unspent', carryInUsd: 0 });
    expect(String(row!.periodKey)).toMatch(/^\d{4}-Q[1-4]$/);
    const closes = await rows(`SELECT period_key, carry_out_usd::float8 AS c, spent_usd::float8 AS s, reason FROM budget_period_closes ORDER BY period_start`);
    expect(closes.find((c) => c['reason'] === 'reconfigured')).toMatchObject({ c: '0', s: '3' });
    expect(closes.filter((c) => c['reason'] === 'boundary').every((c) => c['c'] === '0')).toBe(true); // the previous quarter ended before the policy
    expect((await one(`SELECT carry_over_since IS NOT NULL AS stamped FROM initiative_budgets`))['stamped']).toBe('t');
    // A rolling window with a carry is refused by the shape CHECK even past the route.
    await expect(upsertAllocation('p-alpha', 10, 'u-eli', { period: 'rolling', rollingDays: 7 })).rejects.toThrow(/period_shape/);
  });

  it('every initiative still monthly reads the calendar month, exactly as before', async () => {
    await world();
    await psql(`INSERT INTO initiative_budgets (org_project_id, allocated_usd) VALUES ('p-alpha', 10);
      INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, started_at) VALUES
        ${run(6, 4, `date_trunc('month', NOW()) - INTERVAL '1 second'`)},
        ${run(7, 1.25, `date_trunc('month', NOW())`)};`);
    const row = (await getBudget('p-alpha'))!;
    expect(row).toMatchObject({ period: 'monthly', spentThisPeriodUsd: 1.25, carryInUsd: 0, effectiveAllocatedUsd: 10 });
    const month = await one(`SELECT date_trunc('month', NOW()) AS m`);
    expect(Date.parse(row.periodStart!)).toBe(ts(month['m']));
    expect((await one(`SELECT COUNT(*) AS n FROM budget_period_closes`))['n']).toBe('0');
  });
});
