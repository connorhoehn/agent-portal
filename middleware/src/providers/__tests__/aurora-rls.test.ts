// Row-level security in the Data API wrapper (docs/next-steps.md §8 work item
// 22): the request's tenant scope reaches the database as
// `set_config('app.tenant', …, true)` inside the same transaction as the
// statement, only under RLS_ENFORCE, and only for statements on the tables
// schema/row_level_security.sql protects. The database half (a wrong setting
// reads zero rows) is schema/test_row_level_security_postgres.py.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Execute', input })),
  BeginTransactionCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Begin', input })),
  CommitTransactionCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Commit', input })),
  RollbackTransactionCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Rollback', input })),
}));

const APP_SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:orgiq-aurora-middleware-credentials-AbC123';
const MASTER_SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:orgiq-aurora-credentials-XyZ789';
const mockAurora = { clusterArn: 'arn:cluster', secretArn: APP_SECRET, database: 'orgiq' };
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: mockAurora } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec, withTransaction } from '../aurora.js';
import {
  SET_TENANT_SQL, dbTenantScopeFor, rlsEnforced, runAsSystem, runWithDbTenant, touchesTenantTable, usesApplicationRole,
  warnIfMisconfigured,
} from '../db-tenant.js';

type Sent = { __cmd: string; input: { sql?: string; transactionId?: string; parameters?: Array<{ name: string; value: { stringValue?: string } }> } };
const sent = (): Sent[] => send.mock.calls.map((c) => c[0] as Sent);
const cmds = (): string[] => sent().map((c) => c.__cmd);
const tenantSent = (): string | undefined => sent().find((c) => c.input.sql === SET_TENANT_SQL)?.input.parameters?.[0]?.value.stringValue;

function answer(): void {
  send.mockImplementation(async (cmd: Sent) => (cmd.__cmd === 'Begin' ? { transactionId: 'tx-1' } : { columnMetadata: [], records: [] }));
}

beforeEach(() => {
  send.mockReset();
  answer();
  mockAurora.secretArn = APP_SECRET;
  delete process.env['RLS_ENFORCE'];
});

describe('RLS_ENFORCE', () => {
  it('defaults on for every login, the master-secret fallback included (it opts out with RLS_ENFORCE=false)', () => {
    expect(usesApplicationRole(APP_SECRET)).toBe(true);
    expect(usesApplicationRole(MASTER_SECRET)).toBe(false);
    expect(usesApplicationRole('arn:aws:secretsmanager:us-east-1:1:secret:orgiq-aurora-readonly-credentials-AbC123')).toBe(false);
    expect(rlsEnforced()).toBe(true);
    mockAurora.secretArn = MASTER_SECRET;
    expect(rlsEnforced()).toBe(true);
  });

  it('an explicit value wins either way', () => {
    process.env['RLS_ENFORCE'] = 'false';
    expect(rlsEnforced()).toBe(false);
    mockAurora.secretArn = MASTER_SECRET;
    process.env['RLS_ENFORCE'] = 'true';
    expect(rlsEnforced()).toBe(true);
  });

  it('warns once when the application login runs with it off', () => {
    process.env['RLS_ENFORCE'] = 'false';
    const log = jest.fn();
    warnIfMisconfigured(log);
    warnIfMisconfigured(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/read empty/);
  });
});

describe('the wrapper', () => {
  it('sends a tenant-table statement as begin, set_config, statement, commit in one transaction', async () => {
    await runWithDbTenant('orgiq,social', () => exec('SELECT * FROM saved_searches WHERE owner_sub = :s'));
    expect(cmds()).toEqual(['Begin', 'Execute', 'Execute', 'Commit']);
    expect(sent()[1]!.input.sql).toBe(SET_TENANT_SQL);
    expect(tenantSent()).toBe('orgiq,social');
    expect(sent()[2]!.input.sql).toMatch(/saved_searches/);
    for (const c of sent().slice(1)) expect(c.input.transactionId).toBe('tx-1');
  });

  it('leaves statements on other tables as one autocommit call', async () => {
    await runWithDbTenant('orgiq', () => exec('SELECT * FROM people'));
    expect(cmds()).toEqual(['Execute']);
  });

  it('sends nothing extra with RLS_ENFORCE off', async () => {
    process.env['RLS_ENFORCE'] = 'false';
    await runWithDbTenant('orgiq', () => exec('SELECT * FROM user_tenant_roles'));
    await withTransaction(async (tx) => { await tx('DELETE FROM saved_searches WHERE id = :id'); });
    expect(cmds()).toEqual(['Execute', 'Begin', 'Execute', 'Commit']);
    expect(tenantSent()).toBeUndefined();
  });

  it('scopes a transaction once, right after it begins', async () => {
    await runWithDbTenant('assessment', () => withTransaction(async (tx) => {
      await tx('UPDATE assessment_teams SET name = :n');
      await tx('INSERT INTO assessment_runs (id) VALUES (:id)');
    }));
    expect(cmds()).toEqual(['Begin', 'Execute', 'Execute', 'Execute', 'Commit']);
    expect(tenantSent()).toBe('assessment');
  });

  it('runs outside any request, and under runAsSystem, as every tenant', async () => {
    await exec('SELECT * FROM flow_runs');
    expect(tenantSent()).toBe('*');
    send.mockClear();
    await runWithDbTenant('orgiq', () => runAsSystem(() => exec('SELECT * FROM user_tenant_roles WHERE user_id = :id')));
    expect(tenantSent()).toBe('*');
  });

  it('rolls back and rethrows when the statement fails, never committing', async () => {
    send.mockImplementation(async (cmd: Sent) => {
      if (cmd.__cmd === 'Begin') return { transactionId: 'tx-1' };
      if (cmd.input.sql === SET_TENANT_SQL) return {};
      if (cmd.__cmd === 'Execute') throw new Error('boom');
      return {};
    });
    await expect(runWithDbTenant('orgiq', () => exec('SELECT * FROM social_channels'))).rejects.toThrow('boom');
    expect(cmds()).toEqual(['Begin', 'Execute', 'Execute', 'Rollback']);
  });

  it('rolls back when setting the tenant fails, so no statement runs unscoped', async () => {
    send.mockImplementation(async (cmd: Sent) => {
      if (cmd.__cmd === 'Begin') return { transactionId: 'tx-1' };
      if (cmd.input.sql === SET_TENANT_SQL) throw new Error('set failed');
      return {};
    });
    await expect(runWithDbTenant('orgiq', () => exec('SELECT * FROM social_channels'))).rejects.toThrow('set failed');
    expect(cmds()).toEqual(['Begin', 'Execute', 'Rollback']);
  });
});

describe('the tenant scope of a session', () => {
  it('is the active tenant first, then the other granted tenants', () => {
    expect(dbTenantScopeFor({ tenant: 'orgiq', role: 'member', grants: { orgiq: ['member'], social: ['participant'], assessment: [] } }))
      .toBe('orgiq,social');
  });

  it('is every tenant for admin and for the access tenant', () => {
    expect(dbTenantScopeFor({ tenant: 'orgiq', role: 'admin', grants: { orgiq: ['admin'] } })).toBe('*');
    expect(dbTenantScopeFor({ tenant: 'access', role: 'requester', grants: { access: ['requester'] } })).toBe('*');
  });

  it('drops anything that is not a tenant slug, so nothing can smuggle a comma or a star', () => {
    expect(dbTenantScopeFor({ tenant: 'orgiq', role: 'member', grants: { orgiq: ['member'], 'a,*': ['x'], '*': ['x'] } })).toBe('orgiq');
  });
});

describe('parity with schema/row_level_security.sql', () => {
  const sql = readFileSync(join(__dirname, '../../../../schema/row_level_security.sql'), 'utf8');
  const listed = [...sql.matchAll(/^\s+\('([a-z_]+)',\s+'/gm)].map((m) => m[1]!);

  it('the pattern covers every table the file protects', () => {
    expect(listed.length).toBeGreaterThan(15);
    for (const table of [...listed, 'assessment_teams', 'assessment_knowledge_docs', 'assessment_deck_revisions']) {
      expect([table, touchesTenantTable(`SELECT 1 FROM ${table} t`)]).toEqual([table, true]);
    }
  });

  it('the wrapper sends the statement the file documents', () => {
    expect(sql).toContain(SET_TENANT_SQL);
  });

  it('ignores tables the file does not protect', () => {
    for (const table of ['people', 'projects', 'app_users', 'tenants', 'social_decks', 'initiative_decks']) {
      expect([table, touchesTenantTable(`SELECT 1 FROM ${table}`)]).toEqual([table, false]);
    }
  });
});
