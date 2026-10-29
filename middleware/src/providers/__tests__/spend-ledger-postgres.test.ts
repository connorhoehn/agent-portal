// Opt-in SQL acceptance for the spend ledger (DE-30) against a disposable
// PostgreSQL container: the schema files load unmodified, and the ledger's
// writers, backfill and readers run their exact SQL. Only the RDS Data API
// transport is replaced. This does NOT establish Aurora or Data API binding.
//
//   REAL_SPEND_LEDGER_POSTGRES=1 ORGIQ_SPEND_LEDGER_POSTGRES_CONTAINER=<name> \
//   [ORGIQ_DOCKER='colima ssh -- sudo docker'] npx jest spend-ledger-postgres
//
// The container must carry the label orgiq.validation=spend-ledger-postgres.
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from '../aurora.js';
import { _resetColumnProbes } from '../column-probe.js';
import { recordBotRunSpend, recordSpend, ledgerMismatches, recordAgentProjectRunSpend, getBoxSpend, getActorSpend } from '../spend-ledger.js';
import { listBudgets } from '../budgets.js';
import { backfillSpendLedger } from '../../lib/backfill-spend-ledger.js';
import { finishRun } from '../agent-projects.js';

const enabled = process.env['REAL_SPEND_LEDGER_POSTGRES'] === '1';
const container = process.env['ORGIQ_SPEND_LEDGER_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const SCHEMA = 'spend_ledger_acceptance';
const read = (name: string) => readFileSync(`${process.cwd()}/../schema/${name}`, 'utf8');
// load_schema.py's order up to the ledger.
const schema = [
  'orgiq_schema.sql', 'search_workspace_schema.sql', 'identity_schema.sql', 'social_schema.sql', 'observability_schema.sql',
  'observability_authz_schema.sql', 'observability_sprint1_schema.sql', 'observability_sprint2_schema.sql',
  'observability_sprint3_promote_schema.sql', 'observability_sprint4_calibration_schema.sql',
  'observability_sprint4_memory_schema.sql', 'observability_sprint5_canary_schema.sql',
  'observability_sprint6_prompt_history_schema.sql', 'prompt_contract_schema.sql', 'observability_approvals_schema.sql',
  'orgiq_kb_registry_schema.sql', 'orgiq_work_items_schema.sql', 'work_item_key_schema.sql', 'work_item_documents_schema.sql',
  'agentic_work_schema.sql', 'kb_upload_links_schema.sql', 'agent_projects_schema.sql', 'agent_sdlc_schema.sql',
  'lab_loop_schema.sql', 'devbox_fleet_schema.sql', 'agent_bots_schema.sql', 'agent_budgets_schema.sql', 'program_schema.sql',
  'spend_ledger_schema.sql',
].map(read).join('\n');
const NULL = '__PG_NULL__';
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function psql(input: string, csv: boolean): Promise<string> {
  const args = [...docker.slice(1), 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    ...(csv ? ['--csv', '-P', `null=${NULL}`] : []), '-U', 'postgres', '-d', 'postgres'];
  return new Promise((resolve, reject) => {
    const child = execFile(docker[0]!, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    child.stdin!.end(`SET search_path TO ${SCHEMA}, public; SET client_min_messages TO warning;\n${input}\n`);
  });
}
const sql = async (statement: string): Promise<void> => { await psql(statement, false); };

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

/** The Data API transport, replaced: bind parameters, run the exact statement. */
async function rows(statement: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  const bindings = new Map<string, string>((params ?? []).map((p) => {
    const v = (p.value ?? {}) as { isNull?: boolean; stringValue?: string; doubleValue?: number; longValue?: number };
    if (v.isNull) return [p.name!, 'NULL'];
    if (v.stringValue !== undefined) return [p.name!, literal(v.stringValue)];
    if (v.doubleValue !== undefined) return [p.name!, String(v.doubleValue)];
    if (v.longValue !== undefined) return [p.name!, String(v.longValue)];
    throw new Error(`unsupported parameter ${p.name}`);
  }));
  const bound = statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (!bindings.has(name)) throw new Error(`Unbound parameter ${name}`);
    return bindings.get(name)!;
  });
  return parseCsv(await psql(`${bound};`, true));
}

const count = async (where = 'TRUE') => Number((await rows(`SELECT COUNT(*) AS n FROM spend_entries WHERE ${where}`))[0]!['n']);

(enabled ? describe : describe.skip)('spend ledger with real PostgreSQL', () => {
  jest.setTimeout(120_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_SPEND_LEDGER_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'spend-ledger-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}, public;
      ${schema}`);
    jest.mocked(exec).mockImplementation(rows as never);
  });

  beforeEach(async () => {
    delete process.env['SPEND_LEDGER'];
    _resetColumnProbes();
    // Two initiatives, each attributed through a different arm of the legacy
    // predicate: a bot targeting the initiative, and a run's work item.
    await sql(`TRUNCATE spend_entries, bot_runs, bots, agent_jobs, agent_project_runs, agent_projects, work_items, projects CASCADE;
      INSERT INTO projects (id, name) VALUES ('p-alpha', 'Alpha'), ('p-beta', 'Beta');
      INSERT INTO work_items (id, project_id, type, title) VALUES ('w-1', 'p-beta', 'story', 'W1');
      INSERT INTO bots (id, name, template, prompt_template, org_project_id, model, trigger)
        VALUES ('00000000-0000-0000-0000-0000000000b1', 'nightly', 'story', 'x', 'p-alpha', 'amazon.nova-pro-v1:0', 'cron');
      INSERT INTO agent_jobs (id, kind, title, status, started_at, result) VALUES
        ('job-owned', 'devbox:task', 'dispatched', 'done', NOW(), '{"costUsd": 0.25}');
      INSERT INTO bot_runs (id, bot_id, trigger, status, cost_usd, work_item_id, job_id, started_at) VALUES
        ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'cron', 'done', 1.5, NULL, NULL, NOW()),
        ('00000000-0000-0000-0000-000000000002', NULL, 'marketplace', 'done', 0.25, 'w-1', 'job-owned', NOW()),
        ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b1', 'cron', 'failed', NULL, NULL, NULL, NOW()),
        ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000b1', 'cron', 'skipped', NULL, NULL, NULL, NOW());`);
  });

  it('backfills settled runs once, resolves attribution, and leaves the owned job out', async () => {
    const dry = await backfillSpendLedger({ dryRun: true });
    expect(dry.pending.find((p) => p.source === 'bot_run')).toMatchObject({ rows: 3 });
    expect(dry.pending.find((p) => p.source === 'job')).toMatchObject({ rows: 0 });
    expect(await count()).toBe(0);

    await backfillSpendLedger({ dryRun: false });
    await backfillSpendLedger({ dryRun: false });
    expect(await count()).toBe(3);
    const byRun = await rows(`SELECT source_id, initiative_id, cost_basis, trigger, model FROM spend_entries ORDER BY source_id`);
    expect(byRun).toEqual([
      { source_id: '00000000-0000-0000-0000-000000000001', initiative_id: 'p-alpha', cost_basis: 'reported', trigger: 'cron', model: 'amazon.nova-pro-v1:0' },
      { source_id: '00000000-0000-0000-0000-000000000002', initiative_id: 'p-beta', cost_basis: 'reported', trigger: 'marketplace', model: null },
      { source_id: '00000000-0000-0000-0000-000000000003', initiative_id: 'p-alpha', cost_basis: 'unknown', trigger: 'cron', model: 'amazon.nova-pro-v1:0' },
    ]);
  });

  it('reads the same budget totals from the ledger as from bot_runs on bot-run-only history', async () => {
    await backfillSpendLedger({ dryRun: false });
    const legacy = await listBudgets();
    process.env['SPEND_LEDGER'] = 'ledger';
    const ledger = await listBudgets();
    const pick = (b: Awaited<ReturnType<typeof listBudgets>>) =>
      b.map((r) => ({ id: r.orgProjectId, usd: r.spentThisPeriodUsd, runs: r.runCountThisPeriod, cron: r.maintenanceUsd }));
    expect(pick(ledger)).toEqual(pick(legacy));
    expect(ledgerMismatches(pick(legacy), pick(ledger))).toEqual([]);
    // The unknown-cost failure is counted, not summed as $0.
    expect(ledger.find((r) => r.orgProjectId === 'p-alpha')?.unknownCostCount).toBe(1);
  });

  it('settles a bot run once, and lets a late cost replace an unknown one', async () => {
    await recordBotRunSpend('00000000-0000-0000-0000-000000000003');
    await recordBotRunSpend('00000000-0000-0000-0000-000000000003');
    expect(await count()).toBe(1);
    await sql(`UPDATE bot_runs SET cost_usd = 0.4 WHERE id = '00000000-0000-0000-0000-000000000003'`);
    await recordBotRunSpend('00000000-0000-0000-0000-000000000003');
    await sql(`UPDATE bot_runs SET cost_usd = 9 WHERE id = '00000000-0000-0000-0000-000000000003'`);
    await recordBotRunSpend('00000000-0000-0000-0000-000000000003');
    expect(await rows(`SELECT cost_usd, cost_basis FROM spend_entries`)).toEqual([{ cost_usd: '0.4000', cost_basis: 'reported' }]);
  });

  it('retains estimates through project settlement, bot ownership and job backfill', async () => {
    await sql(`INSERT INTO agent_projects (id, repo_full_name, org_project_id)
      VALUES ('00000000-0000-0000-0000-0000000000a1', 'org/alpha', 'p-alpha');
      INSERT INTO agent_project_runs (id, project_id, prompt, model, status) VALUES
      ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'fix', 'sonnet', 'running');`);
    const runId = '00000000-0000-0000-0000-0000000000c1';
    await finishRun(runId, { status: 'done', costUsd: 0.8, costBasis: 'estimated', estimatedCostUsd: 0.8 });
    await recordAgentProjectRunSpend(runId);
    expect(await rows(`SELECT cost_usd, cost_basis, estimated_cost_usd FROM spend_entries`))
      .toEqual([{ cost_usd: '0.8000', cost_basis: 'estimated', estimated_cost_usd: '0.8000' }]);
    // Same execution path when a bot owns the run: exactly one bot entry.
    await sql(`TRUNCATE spend_entries;
      UPDATE bot_runs SET run_id = '${runId}', cost_usd = 0.8
      WHERE id = '00000000-0000-0000-0000-000000000001';`);
    await recordAgentProjectRunSpend(runId);
    expect(await count()).toBe(0);
    await recordBotRunSpend('00000000-0000-0000-0000-000000000001');
    expect(await rows(`SELECT source, cost_basis, estimated_cost_usd FROM spend_entries`))
      .toEqual([{ source: 'bot_run', cost_basis: 'estimated', estimated_cost_usd: '0.8000' }]);
    await sql(`UPDATE agent_jobs SET result = '{"costUsd":0.25,"costBasis":"estimated","estimatedCostUsd":0.25}' WHERE id = 'job-owned';
      INSERT INTO agent_jobs (id, kind, title, status, started_at, result) VALUES
      ('job-free', 'devbox:task', 'adhoc', 'done', NOW(), '{"costUsd":0.7,"costBasis":"reported","estimatedCostUsd":0.65}');`);
    await backfillSpendLedger({ dryRun: false });
    const ledger = await rows(`SELECT source, cost_usd, cost_basis, estimated_cost_usd FROM spend_entries ORDER BY cost_usd`);
    expect(ledger).toEqual(expect.arrayContaining([
      { source: 'bot_run', cost_usd: '0.2500', cost_basis: 'estimated', estimated_cost_usd: '0.2500' },
      { source: 'job', cost_usd: '0.7000', cost_basis: 'reported', estimated_cost_usd: '0.6500' },
    ]));
  });

  it('does not relabel an estimate on a cluster that lacks the new project columns', async () => {
    await sql(`ALTER TABLE agent_project_runs DROP COLUMN cost_basis, DROP COLUMN estimated_cost_usd;
      INSERT INTO agent_projects (id, repo_full_name, org_project_id)
      VALUES ('00000000-0000-0000-0000-0000000000a1', 'org/alpha', 'p-alpha');
      INSERT INTO agent_project_runs (id, project_id, prompt, model, status) VALUES
      ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'fix', 'sonnet', 'running');`);
    try {
      await finishRun('00000000-0000-0000-0000-0000000000c1', { status: 'done', costUsd: 0.8, costBasis: 'estimated', estimatedCostUsd: 0.8 });
      await recordAgentProjectRunSpend('00000000-0000-0000-0000-0000000000c1');
      expect(await rows(`SELECT cost_usd, cost_basis FROM spend_entries`))
        .toEqual([{ cost_usd: null, cost_basis: 'unknown' }]);
    } finally {
      await sql(read('spend_ledger_schema.sql'));
      _resetColumnProbes();
    }
  });

  it('skips a job a bot run owns, and books an ad-hoc box task to its initiative', async () => {
    await recordSpend({ source: 'job', sourceId: 'job-owned:1', initiativeId: 'p-beta', boxId: 'box-1', actorId: 'u-sme', model: null, costUsd: 0.25 }, { unlessBotRunOwnsJob: 'job-owned' });
    expect(await count()).toBe(0);
    await recordSpend({ source: 'box_task', sourceId: 'box-1:t1', initiativeId: 'p-beta', boxId: 'box-1', actorId: 'u-sme', model: 'sonnet', costUsd: 0.7, inputTokens: 10, outputTokens: 5 });
    await recordSpend({ source: 'box_task', sourceId: 'box-1:t1', initiativeId: 'p-beta', boxId: 'box-1', actorId: 'u-sme', model: 'sonnet', costUsd: 0.7 });
    expect(await count(`source = 'box_task'`)).toBe(1);

    // The legacy reader never saw that box task; dual mode names the gap.
    await backfillSpendLedger({ dryRun: false });
    const legacy = await listBudgets();
    process.env['SPEND_LEDGER'] = 'ledger';
    const ledger = await listBudgets();
    const usd = (b: typeof legacy) => b.map((r) => ({ id: r.orgProjectId, usd: r.spentThisPeriodUsd }));
    expect(ledgerMismatches(usd(legacy), usd(ledger))).toEqual([{ id: 'p-beta', legacyUsd: 0.25, ledgerUsd: 0.95 }]);
  });

  it('books a direct agent-project run to its codebase initiative, and skips one a bot run owns', async () => {
    await sql(`INSERT INTO agent_projects (id, repo_full_name, org_project_id)
        VALUES ('00000000-0000-0000-0000-0000000000a1', 'org/alpha-repo', 'p-alpha');
      INSERT INTO agent_project_runs (id, project_id, prompt, model, status, cost_usd) VALUES
        ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'fix', 'us.anthropic.claude-sonnet', 'done', 0.8),
        ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'fix', NULL, 'done', 0.3);
      UPDATE bot_runs SET run_id = '00000000-0000-0000-0000-0000000000c2' WHERE id = '00000000-0000-0000-0000-000000000001';`);
    await recordAgentProjectRunSpend('00000000-0000-0000-0000-0000000000c1');
    await recordAgentProjectRunSpend('00000000-0000-0000-0000-0000000000c1');
    await recordAgentProjectRunSpend('00000000-0000-0000-0000-0000000000c2');
    expect(await rows(`SELECT source, initiative_id, cost_usd, cost_basis FROM spend_entries`)).toEqual([
      { source: 'agent_project_run', initiative_id: 'p-alpha', cost_usd: '0.8000', cost_basis: 'reported' },
    ]);
  });

  // DE-31: a box's spend is the sum of its ledger entries across sources —
  // the bot run that teed into it is counted once, as its bot_run entry.
  it('a box running one bot-run task and one ad-hoc task reports the sum of exactly two entries', async () => {
    await sql(`UPDATE bot_runs SET outcome = '{"boxId": "box-7"}'::jsonb WHERE id = '00000000-0000-0000-0000-000000000001';`);
    await recordBotRunSpend('00000000-0000-0000-0000-000000000001');
    await recordSpend({ source: 'box_task', sourceId: 'box-7:t1', initiativeId: 'p-alpha', boxId: 'box-7', actorId: 'u-sme', model: 'sonnet', costUsd: 0.7 });
    await recordSpend({ source: 'box_task', sourceId: 'box-7:t2', initiativeId: 'p-alpha', boxId: 'box-7', actorId: 'u-sme', model: 'sonnet', costUsd: null });
    expect(await count(`box_id = 'box-7'`)).toBe(3);
    const spend = (await getBoxSpend(['box-7', 'box-none'])).get('box-7');
    expect(spend).toEqual({ knownUsd: 2.2, unknownCount: 1, bySource: { bot_run: 1.5, box_task: 0.7 } });
    expect((await getBoxSpend(['box-none'])).get('box-none')).toEqual({ knownUsd: 0, unknownCount: 0, bySource: {} });
    // The sender is the actor, never inferred from a box owner.
    expect((await getActorSpend('u-sme', 'month'))).toEqual([
      { initiativeId: 'p-alpha', knownUsd: 0.7, unknownCount: 1, entries: 2, bySource: { box_task: 0.7 } },
    ]);
  });
});
