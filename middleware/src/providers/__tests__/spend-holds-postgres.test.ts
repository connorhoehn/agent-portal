// Opt-in SQL acceptance for spend holds (DE-34) against a disposable
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
].map(read).join('\n');
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
    const v = (p.value ?? {}) as { isNull?: boolean; stringValue?: string; doubleValue?: number; longValue?: number };
    if (v.isNull) return [p.name!, 'NULL'];
    if (v.stringValue !== undefined) return [p.name!, literal(v.stringValue)];
    if (v.doubleValue !== undefined) return [p.name!, String(v.doubleValue)];
    if (v.longValue !== undefined) return [p.name!, String(v.longValue)];
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
      ${schema}`);
    jest.mocked(exec).mockImplementation(rows as never);
    jest.mocked(withTransaction).mockImplementation(inTransaction as never);
  });

  beforeEach(async () => {
    delete process.env['SPEND_LEDGER'];
    delete process.env['SPEND_HOLDS'];
    _resetColumnProbes();
    // $10 allocated; $2.50 already settled this month through a bot targeting the initiative.
    await psql(`TRUNCATE spend_holds, spend_entries, bot_runs, bots, initiative_budgets, projects CASCADE;
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
});
