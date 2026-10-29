// Opt-in SQL acceptance for spend holds (DE-34), user budgets (DE-54), hard
// caps (DE-36) and the maintenance reserve (DE-55) against a disposable
// PostgreSQL container: the schema files load unmodified, and reserveSpend's
// lock, reads and insert run their exact SQL. Only the RDS Data API transport
// is replaced: every autocommit `exec` is its own psql process (its own
// connection), and `withTransaction` is one held psql session, so the parallel
// calls below are real concurrent transactions contending for the advisory
// lock. This does NOT establish Aurora or Data API binding.
//
//   REAL_SPEND_HOLDS_POSTGRES=1 ORGIQ_SPEND_HOLDS_POSTGRES_CONTAINER=<name> \
//   [ORGIQ_DOCKER='colima ssh -- sudo docker'] npx jest spend-holds-postgres
//
// The container must carry the label orgiq.validation=spend-holds-postgres.
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec, withTransaction } from '../aurora.js';
import { _resetColumnProbes } from '../column-probe.js';
import { reserveSpend } from '../../lib/spend-holds.js';
import { recordSpend } from '../spend-ledger.js';
import { getBudget, upsertAllocation } from '../budgets.js';
import { userSpendThisPeriod, upsertUserBudget } from '../user-budgets.js';

const enabled = process.env['REAL_SPEND_HOLDS_POSTGRES'] === '1';
const container = process.env['ORGIQ_SPEND_HOLDS_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const SCHEMA = 'spend_holds_acceptance';
const read = (name: string) => readFileSync(`${process.cwd()}/../schema/${name}`, 'utf8');
// load_schema.py's order up to the holds.
const schema = [
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
const moneySchema = ['user_budgets_schema.sql', 'budget_hard_caps_schema.sql', 'maintenance_reserve_schema.sql'].map(read).join('\n');
const NULL = '__PG_NULL__';
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const prelude = `SET search_path TO ${SCHEMA}, public; SET client_min_messages TO warning;\n`;

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

/** Bind the Data API's `:name` parameters into the exact statement. */
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

/** An autocommit call: its own connection. */
async function rows(statement: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  return parseCsv(await psql(`${bind(statement, params)};`));
}

/** One held connection, so a transaction spans several calls the way a Data API transaction id does. */
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

(enabled ? describe : describe.skip)('spend holds with real PostgreSQL', () => {
  jest.setTimeout(180_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_SPEND_HOLDS_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'spend-holds-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await psql(`CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}, public;
      ${schema}
      ${moneySchema}`); // the DE-54/36/55 files twice: repeatable, so a re-apply must be a no-op
    jest.mocked(exec).mockImplementation(rows as never);
    jest.mocked(withTransaction).mockImplementation(inTransaction as never);
  });

  beforeEach(async () => {
    delete process.env['SPEND_LEDGER'];
    delete process.env['SPEND_HOLDS'];
    _resetColumnProbes();
    // $10 allocated; $2.50 already settled this month through a bot targeting the initiative.
    await psql(`TRUNCATE spend_holds, spend_entries, bot_runs, bots, initiative_budgets, user_budgets, app_users, projects CASCADE;
      INSERT INTO app_users (id, display_name) VALUES ('u-nora', 'Nora DaSilva'), ('u-eli', 'Eli Garcia');
      INSERT INTO projects (id, name) VALUES ('p-beta', 'Beta');
      INSERT INTO initiative_budgets (org_project_id, allocated_usd) VALUES ('p-beta', 100);
      INSERT INTO projects (id, name) VALUES ('p-alpha', 'Alpha');
      INSERT INTO initiative_budgets (org_project_id, allocated_usd) VALUES ('p-alpha', 10);
      INSERT INTO bots (id, name, template, prompt_template, org_project_id, model, trigger)
        VALUES ('00000000-0000-0000-0000-0000000000b1', 'nightly', 'story', 'x', 'p-alpha', 'amazon.nova-pro-v1:0', 'cron');
      INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, started_at) VALUES
        ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'cron', 'done', 2.5, NOW());`);
  });

  it('20 parallel reserveSpend calls never hold more than allocated − spent', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveSpend({
      initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: `box-1:t${i}`,
      forecast: { costUsdP75: 1, costUsdP25: 0.5, confidence: 'run-history' }, expiresInMs: 30 * 60_000,
    })));
    const held = results.filter((r) => r.kind === 'held');
    const braked = results.filter((r) => r.kind === 'confirm');
    const sum = Number((await one(`SELECT COALESCE(SUM(amount_usd), 0) AS s, COUNT(*) AS n FROM spend_holds WHERE status = 'held'`))['s']);
    // $7.50 left fits seven $1 holds, never eight.
    expect(sum).toBeLessThanOrEqual(10 - 2.5);
    expect(held).toHaveLength(7);
    expect(braked).toHaveLength(13);
    expect(sum).toBe(7);
  });

  it('a ledger entry with a known cost settles its hold in the same transaction; a retried settle changes nothing', async () => {
    const r = await reserveSpend({
      initiativeId: 'p-alpha', actorId: 'u-nora', source: 'box_task', sourceId: 'box-1-settle',
      forecast: { costUsdP75: 1 }, expiresInMs: 30 * 60_000,
    });
    expect(r.kind).toBe('held');
    const write = () => recordSpend({ source: 'box_task', sourceId: 'box-1-settle', initiativeId: 'p-alpha', boxId: 'box-1', actorId: 'u-nora', model: 'haiku', costUsd: 0.4, provider: 'bedrock' });
    await write();
    const first = await one(`SELECT status, closed_at FROM spend_holds WHERE source_id = 'box-1-settle'`);
    expect(first['status']).toBe('settled');
    await write();
    expect(await one(`SELECT status, closed_at FROM spend_holds WHERE source_id = 'box-1-settle'`)).toEqual(first);
    expect(await one(`SELECT COUNT(*) AS n, MAX(provider) AS p FROM spend_entries WHERE source_id = 'box-1-settle'`)).toEqual({ n: '1', p: 'bedrock' });
  });

  it('an unknown-cost entry leaves its hold held', async () => {
    await reserveSpend({
      initiativeId: 'p-alpha', actorId: 'u-nora', source: 'box_task', sourceId: 'box-1-unknown',
      forecast: { costUsdP75: 1 }, expiresInMs: 30 * 60_000,
    });
    await recordSpend({ source: 'box_task', sourceId: 'box-1-unknown', initiativeId: 'p-alpha', boxId: 'box-1', actorId: 'u-nora', model: 'haiku', costUsd: null });
    expect((await one(`SELECT status FROM spend_holds WHERE source_id = 'box-1-unknown'`))['status']).toBe('held');
  });

  // ── DE-54 user budgets ──────────────────────────────────────────────────

  it('user_budgets refuses a cap below the allocation, and cascades with its user', async () => {
    await expect(psql(`INSERT INTO user_budgets (user_id, allocated_usd, hard_cap_usd) VALUES ('u-nora', 10, 9)`)).rejects.toThrow(/check constraint/);
    await psql(`INSERT INTO user_budgets (user_id, allocated_usd) VALUES ('u-nora', 10); DELETE FROM app_users WHERE id = 'u-nora'`);
    expect((await one(`SELECT COUNT(*) AS n FROM user_budgets`))['n']).toBe('0');
  });

  it('the actor burn counts the user\'s entries this month, never cron, never last month', async () => {
    await psql(`INSERT INTO spend_entries (source, source_id, initiative_id, actor_id, trigger, cost_usd, cost_basis, occurred_at) VALUES
      ('box_task', 'b:1', 'p-alpha', 'u-nora', NULL, 1.25, 'reported', NOW()),
      ('box_task', 'b:2', NULL,      'u-nora', NULL, NULL, 'unknown', NOW()),
      ('bot_run',  'r:1', 'p-alpha', 'u-nora', 'cron', 4, 'reported', NOW()),
      ('box_task', 'b:3', 'p-alpha', 'u-nora', NULL, 9, 'reported', date_trunc('month', NOW()) - INTERVAL '1 day')`);
    expect(await userSpendThisPeriod('u-nora')).toEqual({ spentUsd: 1.25, unknownCount: 1 });
  });

  it('20 parallel UNATTRIBUTED holds never exceed the user\'s remainder (the user lock is their only lock)', async () => {
    await upsertUserBudget('u-nora', { allocatedUsd: 5, hardCapUsd: 50 }, 'u-eli');
    await psql(`INSERT INTO spend_entries (source, source_id, actor_id, cost_usd, cost_basis) VALUES ('box_task', 'b:spent', 'u-nora', 1.5, 'reported')`);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveSpend({
      initiativeId: null, actorId: 'u-nora', source: 'box_task', sourceId: `box-u:${i}`,
      forecast: { costUsdP75: 1 }, expiresInMs: 30 * 60_000,
    })));
    expect(results.filter((r) => r.kind === 'held')).toHaveLength(3);
    expect(results.filter((r) => r.kind === 'confirm' && r.gate === 'user-budget')).toHaveLength(17);
    expect(await one(`SELECT COUNT(*) AS n, SUM(amount_usd) AS s, COUNT(*) FILTER (WHERE initiative_id IS NULL) AS unattributed FROM spend_holds WHERE status = 'held'`))
      .toEqual({ n: '3', s: '3.0000', unattributed: '3' });
  });

  it('parallel holds on two initiatives serialise on the user lock (initiative → grant → user)', async () => {
    await upsertUserBudget('u-nora', { allocatedUsd: 3 }, 'u-eli');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveSpend({
      initiativeId: i % 2 ? 'p-alpha' : 'p-beta', actorId: 'u-nora', source: 'box_task', sourceId: `box-x:${i}`,
      forecast: { costUsdP75: 1 }, expiresInMs: 30 * 60_000,
    })));
    expect(results.filter((r) => r.kind === 'held')).toHaveLength(3);
    expect(Number((await one(`SELECT SUM(amount_usd) AS s FROM spend_holds WHERE actor_id = 'u-nora' AND status = 'held'`))['s'])).toBe(3);
  });

  it('the user cap refuses whatever is confirmed', async () => {
    await upsertUserBudget('u-nora', { allocatedUsd: 1, hardCapUsd: 1.2 }, 'u-eli');
    const r = await reserveSpend({
      initiativeId: 'p-beta', actorId: 'u-nora', source: 'box_task', sourceId: 'box-cap:1',
      forecast: { costUsdP75: 1.5 }, confirmed: { allocation: true, envelope: true, userBudget: true }, expiresInMs: 60_000,
    });
    expect(r).toMatchObject({ kind: 'capped', gate: 'user-cap', capUsd: 1.2 });
    expect((await one(`SELECT COUNT(*) AS n FROM spend_holds`))['n']).toBe('0');
  });

  // ── DE-36 hard caps ─────────────────────────────────────────────────────

  it('an allocation and its cap move in ONE statement, so raising both clears the CHECK', async () => {
    await upsertAllocation('p-beta', 100, 'u-eli', { hardCapUsd: 110 });
    const row = await upsertAllocation('p-beta', 200, 'u-eli', { hardCapUsd: 220, maintenanceReserveUsd: 7, allowFloorSpill: false });
    expect(row).toMatchObject({ allocatedUsd: 200, hardCapUsd: 220, effectiveHardCapUsd: 220, maintenanceReserveUsd: 7, reserveUsd: 7, allowFloorSpill: false });
    await expect(upsertAllocation('p-beta', 300, 'u-eli')).rejects.toThrow(/check constraint/);
  });

  it('the initiative cap (allocated x 1.25 by default) refuses a confirmed dispatch past it', async () => {
    // p-alpha: $10 allocated, $2.50 spent → cap $12.50; $10.01 more crosses it.
    const r = await reserveSpend({
      initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-c:1',
      forecast: { costUsdP75: 10.01 }, confirmed: { allocation: true }, expiresInMs: 60_000,
    });
    expect(r).toMatchObject({ kind: 'capped', gate: 'allocation-cap', capUsd: 12.5, spentUsd: 2.5 });
    const ok = await reserveSpend({
      initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-c:2',
      forecast: { costUsdP75: 10 }, confirmed: { allocation: true }, expiresInMs: 60_000,
    });
    expect(ok.kind).toBe('held');
  });

  it('BUDGET_FAIL_CLOSED=1: a cluster without the budget tables answers budget-state and holds nothing', async () => {
    process.env['BUDGET_FAIL_CLOSED'] = '1';
    try {
      await psql(`ALTER TABLE initiative_budgets RENAME TO initiative_budgets_gone`);
      const r = await reserveSpend({
        initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-f:1',
        forecast: { costUsdP75: 1 }, expiresInMs: 60_000,
      });
      expect(r).toEqual({ kind: 'unavailable', gate: 'budget-state', reason: 'Budget state could not be read. No work was started.' });
      expect((await one(`SELECT COUNT(*) AS n FROM spend_holds`))['n']).toBe('0');
    } finally {
      delete process.env['BUDGET_FAIL_CLOSED'];
      await psql(`ALTER TABLE initiative_budgets_gone RENAME TO initiative_budgets`);
    }
  });

  // ── DE-55 maintenance reserve ───────────────────────────────────────────

  it('the reserve is derived from essential-bot history; work is judged against the discretionary remainder', async () => {
    // Last month the cron bot spent $3 → auto reserve $3.30 (x1.1); this month it spent $2.50.
    await psql(`INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, started_at) VALUES
      ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', 'cron', 'done', 3, date_trunc('month', NOW()) - INTERVAL '2 days')`);
    const row = (await getBudget('p-alpha'))!;
    expect(row).toMatchObject({ reserveSource: 'auto', reserveUsd: 3.3, floorSpentUsd: 2.5, discretionarySpentUsd: 0 });
    expect(row.discretionaryRemainingUsd).toBeCloseTo(10 - 3.3, 4);
    // $6.70 discretionary: a $7 box task asks for a confirmation the old remainder ($7.50) would not have.
    const r = await reserveSpend({
      initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-r:1', forecast: { costUsdP75: 7 }, expiresInMs: 60_000,
    });
    expect(r).toMatchObject({ kind: 'confirm', gate: 'allocation' });
    // A bot marked not essential moves its spend out of the floor.
    await psql(`UPDATE bots SET essential = false`);
    expect(await getBudget('p-alpha')).toMatchObject({ floorSpentUsd: 0, discretionarySpentUsd: 2.5, reserveUsd: 0 });
  });

  it('an essential firing holds floor money and spills into discretionary money only while allowed', async () => {
    await upsertAllocation('p-alpha', 10, 'u-eli', { maintenanceReserveUsd: 3 });
    const floor = await reserveSpend({
      initiativeId: 'p-alpha', actorId: null, source: 'bot_run', essential: true, forecast: { costUsdP75: 0.4 }, expiresInMs: 60_000,
    });
    expect(floor).toMatchObject({ kind: 'held' });
    expect(await one(`SELECT essential FROM spend_holds`)).toEqual({ essential: 't' });
    expect(await getBudget('p-alpha')).toMatchObject({ floorHeldUsd: 0.4, discretionaryHeldUsd: 0 });
    // $2.90 floor used of $3; a $1 firing spills $0.90 — allowed by default, refused with spill off.
    expect((await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'bot_run', essential: true, forecast: { costUsdP75: 1 }, expiresInMs: 60_000 })))
      .toMatchObject({ kind: 'held', spill: true });
    await upsertAllocation('p-alpha', 10, 'u-eli', { allowFloorSpill: false });
    expect(await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'bot_run', essential: true, forecast: { costUsdP75: 1 }, expiresInMs: 60_000 }))
      .toMatchObject({ kind: 'capped', gate: 'maintenance-reserve' });
  });
});
