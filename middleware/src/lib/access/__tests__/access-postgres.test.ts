// Native PostgreSQL contracts for the access tenant's schema and its cluster
// statements (lib/access/sql.ts), against a dedicated disposable PostgreSQL 16
// container — the work-documents / page-thread pattern. Only the RDS Data API
// transport is replaced: the unmodified schema files and the exact statements
// execute in PostgreSQL, each call on its own connection (one psql process), so
// the races below are real concurrent transactions. This does NOT establish
// Aurora, IAM or Data API binding acceptance, and nothing here touches Aurora.
//
//   REAL_ACCESS_POSTGRES=1 ORGIQ_ACCESS_POSTGRES_CONTAINER=orgiq-access-postgres-acceptance \
//   ORGIQ_DOCKER='colima ssh -- sudo docker' npx jest src/lib/access/__tests__/access-postgres.test.ts
//
// The container must carry the label orgiq.validation=access-postgres.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  ACTIVE_DELEGATIONS_SQL, DECIDE_STEP_SQL, END_DELEGATION_SQL, END_GRANT_SQL, ESCALATE_STEP_SQL, EXPIRY_DUE_SQL, GRANT_ROLE_SQL,
  INSERT_DELEGATION_SQL, INSERT_EVENT_SQL, INSERT_REQUEST_SQL, INSERT_STEP_SQL, PROVISION_ACTIVATE_SQL, PROVISION_CLAIM_SQL,
  REVOKE_ROLE_SQL, BUMP_EPOCH_SQL, WARN_EXPIRY_SQL,
} from '../sql.js';
import { USER_GRANTS_SQL, grantDiff, writeGrantSet, type GrantExec } from '../../identity-grants-sql.js';
import type { Grants } from '../../session.js';

const enabled = process.env['REAL_ACCESS_POSTGRES'] === '1';
const container = process.env['ORGIQ_ACCESS_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const SCHEMA = 'access_acceptance';
const read = (name: string) => readFileSync(`${process.cwd()}/../schema/${name}`, 'utf8');
const access = read('access_schema.sql');
const parents = ['orgiq_schema.sql', 'identity_schema.sql'].map(read).join('\n');
const NULL = '__PG_NULL__';
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function psql(input: string, csv: boolean): Promise<string> {
  const args = [...docker.slice(1), 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    ...(csv ? ['--csv', '-P', `null=${NULL}`] : []), '-U', 'postgres', '-d', 'orgiq_validation'];
  return new Promise((resolve, reject) => {
    const child = execFile(docker[0]!, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    child.stdin!.end(`SET search_path TO ${SCHEMA}; SET client_min_messages TO warning;\n${input}\n`);
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

type Param = string | number | null;
/** The Data API transport, replaced: bind `:name` parameters (string, integer, NULL), run the exact statement, return rows. */
async function run(statement: string, params: Record<string, Param> = {}): Promise<Record<string, string | null>[]> {
  const bound = statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (!(name in params)) throw new Error(`Unbound parameter ${name}`);
    const v = params[name]!;
    return v === null ? 'NULL' : typeof v === 'number' ? String(Math.trunc(v)) : literal(v);
  });
  return parseCsv(await psql(`${bound};`, true));
}
const one = async (q: string, params: Record<string, Param> = {}) => (await run(q, params))[0] ?? {};

const bind = (statement: string, params: Record<string, Param>) => statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
  if (!(name in params)) throw new Error(`Unbound parameter ${name}`);
  const v = params[name]!;
  return v === null ? 'NULL' : typeof v === 'number' ? String(Math.trunc(v)) : literal(v);
});

/**
 * One held connection (one psql process kept open), so a transaction spans
 * several calls the way a Data API transaction id does — while other calls
 * run on their own connections in between.
 */
class Session {
  private out = '';
  private err = '';
  private n = 0;
  private readonly child = spawn(docker[0]!, [...docker.slice(1), 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '--csv', '-P', `null=${NULL}`, '-U', 'postgres', '-d', 'orgiq_validation'], { stdio: ['pipe', 'pipe', 'pipe'] });
  constructor() {
    this.child.stdout.on('data', (d: Buffer) => { this.out += d.toString(); });
    this.child.stderr.on('data', (d: Buffer) => { this.err += d.toString(); });
    this.child.stdin.write(`SET search_path TO ${SCHEMA}; SET client_min_messages TO warning;\n`);
  }
  /** Run one statement on this connection and return its rows. */
  query(statement: string, params: Record<string, Param> = {}): Promise<Record<string, string | null>[]> {
    const marker = `__done_${++this.n}__`;
    this.child.stdin.write(`${bind(statement, params)};\n\\echo ${marker}\n`);
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
      }, 10);
    });
  }
  /** The GrantExec a whole-set writer runs inside this connection's transaction. */
  readonly exec: GrantExec = async (statement, params) => (await this.query(statement, params)).map((r) => Object.values(r));
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.once('close', r));
  }
}

/** providers/identity.ts setGrants on the cluster: BEGIN, writeGrantSet (the shared body), COMMIT. `between` runs after the base read. */
async function setGrantsInTransaction(userId: string, grants: Grants, base: Grants | undefined, between: () => Promise<unknown> = async () => undefined) {
  const tx = new Session();
  try {
    await tx.query('BEGIN');
    let paused = false;
    await writeGrantSet(async (statement, params) => {
      const result = await tx.exec(statement, params);
      // Interleave the other writer right after the transaction has its base.
      if (!paused && (statement === USER_GRANTS_SQL || base)) { paused = true; await between(); }
      return result;
    }, userId, grants, base);
    if (!paused) await between();
    await tx.query('COMMIT');
  } finally { await tx.close(); }
}
const rolesOf = async (userId: string) => (await run(`SELECT tenant_id || ':' || role AS g FROM user_tenant_roles WHERE user_id = :id ORDER BY 1`, { id: userId })).map((r) => r['g']);
const epochOf = async (userId: string) => Number((await one(`SELECT session_epoch AS e FROM app_users WHERE id = :id`, { id: userId }))['e']);

const T0 = '2026-10-14T09:00:00.000Z';
const at = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString();
let seq = 0;
const evt = () => `evt-pg-${++seq}`;

/** A request with its steps as INSERT_REQUEST_SQL / INSERT_STEP_SQL write them. */
async function file(id: string, requester: string, beneficiary: string, itemId: string, kinds: string[]): Promise<boolean> {
  const won = await run(INSERT_REQUEST_SQL, { id, requester_id: requester, beneficiary_id: beneficiary, item_id: itemId, justification: 'Acceptance justification, twenty plus.', duration: '7d', sod_verdict: 'clear', at: T0 });
  if (!won.length) return false;
  for (const [i, kind] of kinds.entries()) {
    await run(INSERT_STEP_SQL, { request_id: id, step: i + 1, kind, status: i === 0 ? 'current' : 'waiting', current_since: i === 0 ? T0 : null });
  }
  await run(INSERT_EVENT_SQL, { id: evt(), request_id: id, at: T0, actor_id: requester, kind: 'submitted', before_status: 'draft', after_status: 'submitted', reason: null });
  return true;
}

/** An approve of step `step` as the route binds it (lib/access/status.ts decide's outcome). */
const approve = (requestId: string, step: number, actor: string, last: boolean, onBehalfOf: string | null = null) => run(DECIDE_STEP_SQL, {
  request_id: requestId, step, actor, at: at(1), comment: `Approved by ${actor}`, step_status: 'approved', next_step: last ? 0 : step + 1,
  skip_rest: 'false', request_status: last ? 'approved' : 'pending', final: last ? 'true' : 'false', on_behalf_of: onBehalfOf,
  e1_id: evt(), e1_kind: 'step-approved', e1_reason: `Approved by ${actor}`, e2_id: last ? evt() : '', e2_kind: last ? 'approved' : '',
});
const reject = (requestId: string, step: number, actor: string) => run(DECIDE_STEP_SQL, {
  request_id: requestId, step, actor, at: at(1), comment: 'No.', step_status: 'rejected', next_step: 0, skip_rest: 'true',
  request_status: 'rejected', final: 'true', on_behalf_of: null, e1_id: evt(), e1_kind: 'step-rejected', e1_reason: 'No.', e2_id: '', e2_kind: '',
});

(enabled ? describe : describe.skip)('access tenant on native PostgreSQL 16', () => {
  jest.setTimeout(180_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_ACCESS_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'access-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await sql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}, public;\n${parents}\n${access}`);
  });
  beforeEach(async () => {
    // The seed's requests, steps, events and delegation go; the catalog, policies and directory stay.
    await sql(`TRUNCATE access_requests, access_request_steps, access_events, access_delegations CASCADE;
      INSERT INTO app_users (id, display_name) VALUES ${Array.from({ length: 12 }, (_, i) => `('u-a${i}', 'Approver ${i}')`).join(', ')} ON CONFLICT (id) DO NOTHING;
      DELETE FROM user_tenant_roles WHERE user_id = 'u-rhea' AND tenant_id = 'orgiq';
      UPDATE app_users SET session_epoch = 0 WHERE id = 'u-rhea';`);
  });

  it('applies the additive schema again as a no-op, and upgrades a cluster that carries the pre-2026-10-14 event checks', async () => {
    await sql(access);
    expect(await one(`SELECT count(*) AS n FROM access_catalog_items`)).toEqual({ n: '9' });
    // A cluster created before the delegation column: the old unnamed target check and kind list.
    await sql(`DELETE FROM access_events WHERE delegation_id IS NOT NULL;
      ALTER TABLE access_events DROP CONSTRAINT access_events_target_check;
      ALTER TABLE access_events ADD CONSTRAINT access_events_check CHECK (request_id IS NOT NULL OR policy_id IS NOT NULL);
      ALTER TABLE access_events DROP CONSTRAINT access_events_kind_check;
      ALTER TABLE access_events ADD CONSTRAINT access_events_kind_check CHECK (kind IN ('submitted', 'step-approved', 'step-rejected', 'info-requested', 'withdrawn',
        'approved', 'provisioned', 'expired', 'revoked', 'sod-override', 'sod-blocked', 'policy-updated'));`);
    await expect(run(INSERT_DELEGATION_SQL, { id: 'dlg-old', delegator_id: 'u-omar', delegate_id: 'u-priya', starts_at: T0, ends_at: at(24), reason: 'Away.', at: T0, event_id: evt(), event_reason: 'Omar → Priya' }))
      .rejects.toThrow(/violates check constraint/);
    await sql(access);
    expect(await run(INSERT_DELEGATION_SQL, { id: 'dlg-new', delegator_id: 'u-omar', delegate_id: 'u-priya', starts_at: T0, ends_at: at(24), reason: 'Away.', at: T0, event_id: evt(), event_reason: 'Omar → Priya' }))
      .toEqual([{ delegation_id: 'dlg-new' }]);
    expect(await one(`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'access_events_check'`)).toEqual({ n: '0' });
  });

  it('two racing submits for the same person and item file once; a withdrawn request frees the slot', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      run(INSERT_REQUEST_SQL, { id: `req-race-${i}`, requester_id: 'u-rhea', beneficiary_id: 'u-rhea', item_id: 'role:orgiq:sme', justification: 'Racing submit, twenty characters.', duration: '7d', sod_verdict: 'clear', at: T0 })));
    expect(results.filter((r) => r.length === 1)).toHaveLength(1);
    expect(await one(`SELECT count(*) AS n FROM access_requests WHERE beneficiary_id = 'u-rhea' AND item_id = :item`, { item: 'role:orgiq:sme' })).toEqual({ n: '1' });
    await sql(`UPDATE access_requests SET status = 'withdrawn' WHERE beneficiary_id = 'u-rhea'`);
    expect(await file('req-again', 'u-rhea', 'u-rhea', 'role:orgiq:sme', ['manager'])).toBe(true);
  });

  it('twelve concurrent approvers decide a step once: one claim, one event set, the next step current', async () => {
    await file('req-1', 'u-rhea', 'u-rhea', 'role:orgiq:sme', ['manager', 'steward']);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => approve('req-1', 1, `u-a${i}`, false)));
    const winners = results.filter((r) => r.length === 1);
    expect(winners).toHaveLength(1);
    expect(winners[0]![0]).toMatchObject({ request_id: 'req-1', step: '1', events: '1' });
    const steps = await run(`SELECT step, status, decided_by, current_since FROM access_request_steps WHERE request_id = 'req-1' ORDER BY step`);
    expect(steps.map((s) => s['status'])).toEqual(['approved', 'current']);
    expect(steps[1]!['current_since']).toMatch(/^2026-10-14 10:00:00/);
    expect(await one(`SELECT status FROM access_requests WHERE id = 'req-1'`)).toEqual({ status: 'pending' });
    expect(await one(`SELECT count(*) AS n FROM access_events WHERE request_id = 'req-1' AND kind = 'step-approved'`)).toEqual({ n: '1' });
    // A late approver of the same step, and an approve racing a reject on the last step: still once each.
    expect(await approve('req-1', 1, 'u-a3', false)).toEqual([]);
    const last = await Promise.all([approve('req-1', 2, 'u-a4', true), reject('req-1', 2, 'u-a5'), approve('req-1', 2, 'u-a6', true)]);
    expect(last.filter((r) => r.length === 1)).toHaveLength(1);
    const final = await one(`SELECT status, decided_at IS NOT NULL AS decided FROM access_requests WHERE id = 'req-1'`);
    expect(['approved', 'rejected']).toContain(final['status']);
    expect(final['decided']).toBe('t');
    expect(await one(`SELECT count(*) AS n FROM access_events WHERE request_id = 'req-1' AND kind IN ('step-rejected', 'approved')`)).toEqual({ n: '1' });
  });

  it('nobody decides a request they submitted or benefit from — not through the statement, not through any other writer', async () => {
    await file('req-2', 'u-omar', 'u-rhea', 'role:orgiq:sme', ['manager']);
    expect(await approve('req-2', 1, 'u-omar', true)).toEqual([]);
    expect(await approve('req-2', 1, 'u-rhea', true)).toEqual([]);
    expect(await one(`SELECT status, decided_by FROM access_request_steps WHERE request_id = 'req-2'`)).toEqual({ status: 'current', decided_by: null });
    await expect(sql(`UPDATE access_request_steps SET status = 'approved', decided_by = 'u-rhea' WHERE request_id = 'req-2'`)).rejects.toThrow(/cannot decide request req-2/);
    // A delegate decides for their delegator and the step says so; a decided step never changes again.
    expect(await approve('req-2', 1, 'u-a1', true, 'u-priya')).toHaveLength(1);
    expect(await one(`SELECT decided_by, delegated_from FROM access_request_steps WHERE request_id = 'req-2'`)).toEqual({ decided_by: 'u-a1', delegated_from: 'u-priya' });
    await expect(sql(`UPDATE access_request_steps SET status = 'rejected', decided_by = 'u-a2' WHERE request_id = 'req-2'`)).rejects.toThrow(/already decided/);
  });

  it('provisioning is idempotent: eight racing provisioners write one grant, one activation, one event — and a crash resumes', async () => {
    await file('req-3', 'u-rhea', 'u-rhea', 'role:orgiq:sme', ['manager']);
    await approve('req-3', 1, 'u-omar', true);
    const provision = async () => {
      const claimed = await run(PROVISION_CLAIM_SQL, { id: 'req-3', at: at(2), expires_at: at(2 + 7 * 24) });
      await run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'sme' });
      const done = await run(PROVISION_ACTIVATE_SQL, { id: 'req-3', at: at(2), event_id: evt(), reason: 'Expires Oct 21, 2026' });
      return { claimed: claimed.length, done: done.length };
    };
    const results = await Promise.all(Array.from({ length: 8 }, provision));
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.done, 0)).toBe(1);
    expect(await one(`SELECT status, provisioned_at IS NOT NULL AS p, expires_at FROM access_requests WHERE id = 'req-3'`)).toMatchObject({ status: 'active', p: 't' });
    expect(await one(`SELECT count(*) AS n FROM user_tenant_roles WHERE user_id = 'u-rhea' AND tenant_id = 'orgiq' AND role = 'sme'`)).toEqual({ n: '1' });
    expect(await one(`SELECT count(*) AS n FROM access_events WHERE request_id = 'req-3' AND kind = 'provisioned'`)).toEqual({ n: '1' });
    // A crash after the claim leaves `provisioned`; a retry (two at once) finishes it exactly once.
    await file('req-4', 'u-omar', 'u-omar', 'role:pipelines:operator', ['manager']);
    await approve('req-4', 1, 'u-priya', true);
    expect(await run(PROVISION_CLAIM_SQL, { id: 'req-4', at: at(2), expires_at: at(9) })).toHaveLength(1);
    const resumed = await Promise.all([0, 1].map(async () => {
      await run(GRANT_ROLE_SQL, { user_id: 'u-omar', tenant: 'pipelines', role: 'operator' });
      return (await run(PROVISION_ACTIVATE_SQL, { id: 'req-4', at: at(3), event_id: evt(), reason: 'Resumed' })).length;
    }));
    expect(resumed.sort()).toEqual([0, 1]);
  });

  it('grant + grant: concurrent single-role grants for one person never lose a role, and bump nothing', async () => {
    // Two provisionings for one person at once — SME and budget visibility — each twice, through GRANT_ROLE_SQL
    // (providers/identity.ts grantRole), twenty rounds.
    for (let round = 0; round < 20; round++) {
      await sql(`DELETE FROM user_tenant_roles WHERE user_id = 'u-rhea' AND tenant_id = 'orgiq'`);
      await Promise.all([['orgiq', 'sme'], ['orgiq', 'budgets-reader'], ['orgiq', 'sme'], ['orgiq', 'budgets-reader']]
        .map(([tenant, role]) => run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: tenant!, role: role! })));
      expect(await rolesOf('u-rhea')).toEqual(['access:requester', 'orgiq:budgets-reader', 'orgiq:sme']);
    }
    expect(await epochOf('u-rhea')).toBe(0);
    // The writer this replaced — read the set, merge one role, DELETE every row, re-INSERT — interleaved, drops one.
    await sql(`DELETE FROM user_tenant_roles WHERE user_id = 'u-rhea' AND tenant_id = 'orgiq'`);
    const wholesale = async (set: Array<[string, string]>) => {
      await run(`DELETE FROM user_tenant_roles WHERE user_id = :id`, { id: 'u-rhea' });
      for (const [tenant, role] of set) await run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant, role });
    };
    await wholesale([['access', 'requester'], ['orgiq', 'sme']]);
    await wholesale([['access', 'requester'], ['orgiq', 'budgets-reader']]);
    expect(await rolesOf('u-rhea')).toEqual(['access:requester', 'orgiq:budgets-reader']);
  });

  it('grant + revoke: a provisioning racing a revocation keeps one, removes the other; only the revoke bumps', async () => {
    for (let round = 0; round < 10; round++) {
      await sql(`DELETE FROM user_tenant_roles WHERE user_id = 'u-rhea' AND tenant_id = 'orgiq';
        INSERT INTO user_tenant_roles (user_id, tenant_id, role) VALUES ('u-rhea', 'orgiq', 'sme');`);
      // Provision budget visibility (no bump, A3) while SME is revoked (remove, then bump — revokeAccess's order).
      await Promise.all([
        run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'budgets-reader' }),
        run(REVOKE_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'sme' }).then(() => run(BUMP_EPOCH_SQL, { user_id: 'u-rhea' })),
      ]);
      expect(await rolesOf('u-rhea')).toEqual(['access:requester', 'orgiq:budgets-reader']);
      expect(await epochOf('u-rhea')).toBe(round + 1);
    }
  });

  it('admin edit + provisioning: the whole-set editor applies a diff in one transaction and never erases a concurrent grant', async () => {
    // (a) No base: the editor's transaction reads Rhea's rows, then SME is provisioned on another
    // connection and commits, then the editor applies its diff (add approver) and commits.
    await setGrantsInTransaction('u-rhea', { access: ['requester', 'approver'] }, undefined,
      () => run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'sme' }));
    expect(await rolesOf('u-rhea')).toEqual(['access:approver', 'access:requester', 'orgiq:sme']);
    // (b) The editor's base (the matrix the page loaded, before the grant): a stale save that drops
    // approver removes only approver; budget visibility, provisioned while the page was open, survives.
    const loaded: Grants = { access: ['requester', 'approver'], orgiq: ['sme'] };
    await setGrantsInTransaction('u-rhea', { access: ['requester'], orgiq: ['sme'] }, loaded,
      () => run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'budgets-reader' }));
    expect(await rolesOf('u-rhea')).toEqual(['access:requester', 'orgiq:budgets-reader', 'orgiq:sme']);
    // (c) A revocation of a role the editor is NOT changing, committed mid-edit, stays revoked.
    await setGrantsInTransaction('u-rhea', { access: ['requester', 'approver'], orgiq: ['sme', 'budgets-reader'] },
      { access: ['requester'], orgiq: ['sme', 'budgets-reader'] },
      () => run(REVOKE_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'budgets-reader' }).then(() => run(BUMP_EPOCH_SQL, { user_id: 'u-rhea' })));
    expect(await rolesOf('u-rhea')).toEqual(['access:approver', 'access:requester', 'orgiq:sme']);
    // Admin edits and provisionings never bump; the one revocation did, once.
    expect(await epochOf('u-rhea')).toBe(1);
    // Ten editors and ten provisioners at once, each on its own role: every write lands.
    await sql(`DELETE FROM user_tenant_roles WHERE user_id = 'u-rhea'; INSERT INTO user_tenant_roles (user_id, tenant_id, role) VALUES ('u-rhea', 'access', 'requester');`);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => setGrantsInTransaction('u-rhea', { access: ['requester'], orgiq: [`editor-${i}`] }, { access: ['requester'] })),
      ...Array.from({ length: 10 }, (_, i) => run(GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: `prov-${i}` })),
    ]);
    expect((await rolesOf('u-rhea')).length).toBe(21);
    expect(grantDiff({ access: ['requester'] }, { access: ['requester'], orgiq: ['editor-0'] })).toEqual({ add: [['orgiq', 'editor-0']], remove: [] });
  });

  it('the expiry sweep is single-flight: six racing sweepers and a person\'s revoke end each grant once', async () => {
    for (const [i, user] of ['u-a0', 'u-a1', 'u-a2'].entries()) {
      await file(`req-x${i}`, user, user, 'role:orgiq:sme', ['manager']);
      await approve(`req-x${i}`, 1, 'u-omar', true);
      await run(PROVISION_CLAIM_SQL, { id: `req-x${i}`, at: T0, expires_at: at(8) });
      await run(GRANT_ROLE_SQL, { user_id: user, tenant: 'orgiq', role: 'sme' });
      await run(PROVISION_ACTIVATE_SQL, { id: `req-x${i}`, at: T0, event_id: evt(), reason: 'Expires' });
    }
    // The 24-hour warning, claimed by six at once: once per request.
    const warned = await Promise.all(Array.from({ length: 6 }, () => run(WARN_EXPIRY_SQL, { id: 'req-x0', at: at(1) })));
    expect(warned.filter((r) => r.length).length).toBe(1);
    expect(await run(EXPIRY_DUE_SQL, { now: at(7) })).toEqual([]);
    const sweep = async (who: string) => {
      const ended: string[] = [];
      for (const r of await run(EXPIRY_DUE_SQL, { now: at(9) })) {
        // Remove first (idempotent), bump, then claim — lib/access-provision.ts revokeAccess's order.
        await run(REVOKE_ROLE_SQL, { user_id: r['beneficiary_id']!, tenant: 'orgiq', role: 'sme' });
        const won = await run(END_GRANT_SQL, { id: r['id']!, outcome: 'expired', at: at(9), actor_id: null, reason: `Reached its 7d end (${who})`, event_id: evt() });
        if (won.length) { await run(BUMP_EPOCH_SQL, { user_id: r['beneficiary_id']! }); ended.push(r['id']!); }
      }
      return ended;
    };
    // A person's revoke takes the same order: the role first, then the claim.
    const personRevoke = run(REVOKE_ROLE_SQL, { user_id: 'u-a1', tenant: 'orgiq', role: 'sme' })
      .then(() => run(END_GRANT_SQL, { id: 'req-x1', outcome: 'revoked', at: at(9), actor_id: 'u-priya', reason: 'Left the team', event_id: evt() }));
    const [byPerson, ...sweeps] = await Promise.all([personRevoke, ...Array.from({ length: 6 }, (_, i) => sweep(`replica-${i}`))]);
    const endedBySweeps = sweeps.flat();
    expect(new Set(endedBySweeps).size).toBe(endedBySweeps.length);
    expect(endedBySweeps.length + byPerson.length).toBe(3);
    expect(await one(`SELECT count(*) AS n FROM access_events WHERE kind IN ('expired', 'revoked')`)).toEqual({ n: '3' });
    expect(await one(`SELECT count(*) AS n FROM access_requests WHERE status IN ('active', 'provisioned')`)).toEqual({ n: '0' });
    expect(await one(`SELECT count(*) AS n FROM user_tenant_roles WHERE user_id IN ('u-a0', 'u-a1', 'u-a2') AND role = 'sme'`)).toEqual({ n: '0' });
    expect(await run(EXPIRY_DUE_SQL, { now: at(100) })).toEqual([]);
  });

  it('a current step escalates once per level under six racing sweeps, and never once decided', async () => {
    await file('req-5', 'u-rhea', 'u-rhea', 'role:orgiq:sme', ['manager', 'steward']);
    const escalate = (from: number, to: number) => run(ESCALATE_STEP_SQL, { request_id: 'req-5', step: 1, from_level: from, to_level: to, at: at(49), event_id: evt(), reason: 'Step 1 waited 2 days' });
    const r1 = await Promise.all(Array.from({ length: 6 }, () => escalate(0, 1)));
    expect(r1.filter((r) => r.length).length).toBe(1);
    const r2 = await Promise.all(Array.from({ length: 6 }, () => escalate(1, 2)));
    expect(r2.filter((r) => r.length).length).toBe(1);
    expect(await one(`SELECT escalation_level, count(*) OVER () AS n FROM access_request_steps WHERE request_id = 'req-5' AND step = 1`)).toMatchObject({ escalation_level: '2' });
    await expect(sql(`UPDATE access_request_steps SET escalation_level = 3 WHERE request_id = 'req-5' AND step = 1`)).rejects.toThrow(/escalation_level_check/);
    await approve('req-5', 1, 'u-omar', false);
    expect(await run(ESCALATE_STEP_SQL, { request_id: 'req-5', step: 1, from_level: 2, to_level: 2, at: at(200), event_id: evt(), reason: 'late' })).toEqual([]);
    expect(await one(`SELECT count(*) AS n FROM access_events WHERE request_id = 'req-5' AND kind = 'escalated'`)).toEqual({ n: '2' });
  });

  it('delegations: never to oneself, a window that ends after it starts, in force only inside it, ended once', async () => {
    const insert = (id: string, delegate: string, start: string, end: string) => run(INSERT_DELEGATION_SQL, { id, delegator_id: 'u-omar', delegate_id: delegate, starts_at: start, ends_at: end, reason: 'Away.', at: T0, event_id: evt(), event_reason: 'Omar → x' });
    await expect(insert('dlg-self', 'u-omar', T0, at(24))).rejects.toThrow(/access_delegations_not_self/);
    await expect(insert('dlg-inv', 'u-priya', at(24), T0)).rejects.toThrow(/access_delegations_window/);
    expect(await insert('dlg-1', 'u-priya', at(1), at(24))).toHaveLength(1);
    expect(await run(ACTIVE_DELEGATIONS_SQL, { now: T0 })).toEqual([]);
    expect(await run(ACTIVE_DELEGATIONS_SQL, { now: at(2) })).toEqual([{ id: 'dlg-1', delegator_id: 'u-omar', delegate_id: 'u-priya' }]);
    const ends = await Promise.all(Array.from({ length: 5 }, () => run(END_DELEGATION_SQL, { id: 'dlg-1', actor_id: 'u-omar', at: at(3), event_id: evt(), reason: 'Back early' })));
    expect(ends.filter((r) => r.length).length).toBe(1);
    expect(await run(ACTIVE_DELEGATIONS_SQL, { now: at(4) })).toEqual([]);
    expect(await one(`SELECT count(*) AS n FROM access_events WHERE delegation_id = 'dlg-1'`)).toEqual({ n: '2' });
  });
});
