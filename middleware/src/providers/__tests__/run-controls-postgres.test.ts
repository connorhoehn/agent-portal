// Opt-in SQL acceptance for run controls (DE-35 cutoff record, DE-37 run
// limits, DE-50 kill switches) against a disposable PostgreSQL container: the
// schema files load unmodified (run_controls_schema.sql twice — it is
// repeatable), and the slot lease, the limits inside reserveSpend, the
// top-up settle, the job claim filter and the switches run their exact SQL.
// Only the RDS Data API transport is replaced (as in spend-holds-postgres):
// every autocommit `exec` is its own psql process and `withTransaction` one
// held psql session, so parallel calls are real concurrent transactions.
// This does NOT establish Aurora or Data API binding.
//
//   REAL_RUN_CONTROLS_POSTGRES=1 ORGIQ_RUN_CONTROLS_POSTGRES_CONTAINER=<name> npx jest run-controls-postgres
//
// The container must carry the label orgiq.validation=run-controls-postgres.
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec, withTransaction } from '../aurora.js';
import { _resetColumnProbes } from '../column-probe.js';
import { reserveSpend } from '../../lib/spend-holds.js';
import { recordSpend } from '../spend-ledger.js';
import { acquireRunSlots, freeDeadSlots, upsertRunLimit, releaseRunSlots, saturatedInitiatives } from '../run-limits.js';
import { finishRun } from '../agent-projects.js';
import { claimNextJob, enqueueJob } from '../agent-jobs.js';
import { setSwitch, _resetFleetSwitchCache } from '../../lib/fleet-switches.js';
import { settleHold } from '../spend-holds.js';

const enabled = process.env['REAL_RUN_CONTROLS_POSTGRES'] === '1';
const container = process.env['ORGIQ_RUN_CONTROLS_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const SCHEMA = 'run_controls_acceptance';
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
  'user_budgets_schema.sql', 'budget_hard_caps_schema.sql', 'maintenance_reserve_schema.sql', 'local_compute_schema.sql', 'local_compute_worker_schema.sql', 'run_controls_schema.sql',
].map(read).join('\n');
const controlsSchema = read('run_controls_schema.sql');
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

/** A raw statement (no `:name` binding — test SQL carries literal colons). */
const one = async (q: string) => parseCsv(await psql(`${q};`))[0] ?? {};

(enabled ? describe : describe.skip)('run controls with real PostgreSQL', () => {
  jest.setTimeout(180_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_RUN_CONTROLS_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'run-controls-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await psql(`CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}, public;
      ${schema}
      ${controlsSchema}`);
    jest.mocked(exec).mockImplementation(rows as never);
    jest.mocked(withTransaction).mockImplementation(inTransaction as never);
  });

  beforeEach(async () => {
    delete process.env['SPEND_LEDGER'];
    delete process.env['SPEND_HOLDS'];
    _resetColumnProbes();
    _resetFleetSwitchCache();
    await psql(`TRUNCATE spend_holds, spend_entries, run_limits, run_slots, fleet_switches, fleet_switch_log, agent_jobs,
        bot_runs, bots, initiative_budgets, projects CASCADE;
      INSERT INTO projects (id, name) VALUES ('p-alpha', 'Alpha'), ('p-beta', 'Beta');
      INSERT INTO initiative_budgets (org_project_id, allocated_usd) VALUES ('p-alpha', 1000), ('p-beta', 1000);`);
  });

  it('N parallel acquireRunSlots against a limit of 3: exactly 3 holders', async () => {
    const exp = new Date(Date.now() + 600_000).toISOString();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      acquireRunSlots(`holder-${i}`, [{ key: 'initiative:p-alpha', max: 3 }], exp)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await one(`SELECT COUNT(*) AS n, COUNT(DISTINCT slot_no) AS d FROM run_slots WHERE scope_key = 'initiative:p-alpha'`)))
      .toEqual({ n: '3', d: '3' });
  });

  it('the regression it replaces: a COUNT-guarded INSERT under READ COMMITTED lets concurrent writers past the ceiling', async () => {
    // The shape providers/bots.ts createBotRun uses (INSERT … SELECT … WHERE
    // (SELECT COUNT(*)) < ceiling), here on run_slots with no lock: each
    // concurrent statement cannot see the others' uncommitted rows.
    await psql(`CREATE TABLE IF NOT EXISTS ceiling_probe (id TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT NOW())`);
    await psql(`TRUNCATE ceiling_probe`);
    await Promise.all(Array.from({ length: 12 }, (_, i) => inTransaction(async (tx) => {
      await tx(`INSERT INTO ceiling_probe (id) SELECT :id WHERE (SELECT COUNT(*) FROM ceiling_probe) < 3`, [{ name: 'id', value: { stringValue: `r${i}` } }]);
      await tx(`SELECT pg_sleep(0.2)`);
    })));
    const n = Number((await one(`SELECT COUNT(*) AS n FROM ceiling_probe`))['n']);
    // Recorded, not required: the count guard admits more than its ceiling
    // whenever the writers overlap. The slot lease above never does.
    console.log(`[run-controls-postgres] COUNT-guarded insert admitted ${n} of 12 against a ceiling of 3`);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('reserveSpend with an initiative limit of 2: 8 parallel holds, exactly 2 held, the rest limited; release frees one', async () => {
    await upsertRunLimit('initiative', 'p-alpha', { maxConcurrent: 2 }, 'u-vera');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveSpend({
      initiativeId: 'p-alpha', actorId: null, source: 'job', sourceId: `job-${i}:1`,
      forecast: { costUsdP75: 0.1 }, expiresInMs: 600_000,
    })));
    const held = results.filter((r) => r.kind === 'held') as Array<{ kind: 'held'; holdId: string }>;
    expect(held).toHaveLength(2);
    expect(results.filter((r) => r.kind === 'limited')).toHaveLength(6);
    expect((await one(`SELECT COUNT(*) AS n FROM run_slots WHERE scope_key = 'initiative:p-alpha'`))['n']).toBe('2');
    expect((await one(`SELECT COUNT(*) AS n FROM spend_holds WHERE status = 'held'`))['n']).toBe('2');
    expect(await saturatedInitiatives()).toEqual(['p-alpha']);

    await releaseRunSlots(held[0]!.holdId);
    const next = await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'job', sourceId: 'job-9:1', forecast: { costUsdP75: 0.1 }, expiresInMs: 600_000 });
    expect(next.kind).toBe('held');
    // A slot whose hold closed is dead: the sweep removes it.
    await psql(`UPDATE spend_holds SET status = 'settled' WHERE source_id = 'job-9:1'`);
    expect(await freeDeadSlots()).toBe(1);
  });

  it('an expired slot is freed by the sweep and the next acquire succeeds', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await psql(`INSERT INTO run_slots (scope_key, slot_no, holder, expires_at) VALUES ('initiative:p-beta', 0, 'stale', '${past}')`);
    expect(await freeDeadSlots()).toBe(1);
    expect(await acquireRunSlots('fresh', [{ key: 'initiative:p-beta', max: 1 }], new Date(Date.now() + 60_000).toISOString())).toEqual({ ok: true });
  });

  it('a top-up hold settles with its attempt\'s ledger entry', async () => {
    const parent = await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-1:t1', forecast: { costUsdP75: 0.2 }, expiresInMs: 600_000 });
    const topup = await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'box_task', sourceId: 'box-1:t1#topup-1', forecast: { costUsdP75: 0.2 }, basis: 'topup', expiresInMs: 600_000 });
    expect([parent.kind, topup.kind]).toEqual(['held', 'held']);
    expect((await one(`SELECT basis FROM spend_holds WHERE source_id = 'box-1:t1#topup-1'`))['basis']).toBe('topup');
    await recordSpend({ source: 'box_task', sourceId: 'box-1:t1', initiativeId: 'p-alpha', boxId: 'box-1', actorId: null, model: 'haiku', costUsd: 0.35, provider: 'bedrock' });
    expect(parseCsv(await psql(`SELECT source_id, status FROM spend_holds ORDER BY source_id;`))).toEqual([
      { source_id: 'box-1:t1', status: 'settled' }, { source_id: 'box-1:t1#topup-1', status: 'settled' },
    ]);
    // Idempotent.
    await settleHold('box_task', 'box-1:t1');
  });

  it('a paused initiative refuses with paused; the fleet switch refuses everything; flips are logged', async () => {
    await setSwitch('initiative:p-alpha', true, 'review', 'u-vera');
    const r = await reserveSpend({ initiativeId: 'p-alpha', actorId: null, source: 'job', sourceId: 'j:1', forecast: { costUsdP75: 0.1 }, expiresInMs: 60_000 });
    expect(r).toMatchObject({ kind: 'paused', scope: 'initiative:p-alpha' });
    expect((await reserveSpend({ initiativeId: 'p-beta', actorId: null, source: 'job', sourceId: 'j:2', forecast: { costUsdP75: 0.1 }, expiresInMs: 60_000 })).kind).toBe('held');
    await setSwitch('fleet', true, null, 'u-vera');
    expect((await reserveSpend({ initiativeId: 'p-beta', actorId: null, source: 'job', sourceId: 'j:3', forecast: { costUsdP75: 0.1 }, expiresInMs: 60_000 })).kind).toBe('paused');
    await setSwitch('fleet', false, null, 'u-vera');
    expect((await one(`SELECT COUNT(*) AS n FROM fleet_switch_log`))['n']).toBe('3');
  });

  it('the dispatcher claim skips a saturated initiative\'s jobs, stamped from the payload', async () => {
    const a = await enqueueJob({ kind: 'devbox:task', title: 'a', payload: { prompt: 'x', initiativeId: 'p-alpha' }, priority: 1 });
    const b = await enqueueJob({ kind: 'devbox:task', title: 'b', payload: { prompt: 'y', initiativeId: 'p-beta' }, priority: 2 });
    expect((await one(`SELECT initiative_id FROM agent_jobs WHERE id = '${a!.id}'`))['initiative_id']).toBe('p-alpha');
    const claimed = await claimNextJob('box-1', 's'.repeat(40), { skipInitiatives: ['p-alpha'] });
    expect(claimed?.id).toBe(b!.id);
    expect((await one(`SELECT status, attempts FROM agent_jobs WHERE id = '${a!.id}'`))).toEqual({ status: 'queued', attempts: '0' });
  });

  it('finishRun records the cutoff block on agent_project_runs', async () => {
    const run = await one(`INSERT INTO agent_projects (repo_full_name) VALUES ('o/r-${Date.now()}') RETURNING id`);
    const pr = await one(`INSERT INTO agent_project_runs (project_id, prompt, status) VALUES ('${run['id']}', 'x', 'running') RETURNING id`);
    await finishRun(String(pr['id']), {
      status: 'failed', error: 'stopped at $0.52 of its $0.50 hold', costUsd: 0.52, costBasis: 'estimated', estimatedCostUsd: 0.52,
      cutoff: { reason: 'budget', ceilingUsd: 0.5, meteredUsd: 0.52, holdIds: ['h1'] },
    });
    const row = await one(`SELECT status, cutoff->>'reason' AS reason, (cutoff->>'meteredUsd')::float8 AS metered FROM agent_project_runs WHERE id = '${pr['id']}'`);
    expect(row).toEqual({ status: 'failed', reason: 'budget', metered: '0.52' });
  });
});
