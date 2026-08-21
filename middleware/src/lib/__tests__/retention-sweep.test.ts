// Retention rules — which terminal rows the sweep may delete, pinned as SQL
// predicates. The rules ARE the policy: a wrong status list silently deletes
// live state, and a lost NOT EXISTS deletes the audit trail behind reviewed
// changes. The builders are pure, so the whole policy is judgeable without a
// database.

// The functions under test are pure; the mocks only keep the module loadable —
// config.ts uses import.meta, which the CJS test transform cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import {
  RETENTION_RULES, deleteBatchSql, cutoffIso, retentionDays, BATCH_LIMIT,
} from '../retention-sweep.js';

function rule(table: string) {
  const r = RETENTION_RULES.find((x) => x.table === table);
  if (!r) throw new Error(`no retention rule for ${table}`);
  return r;
}

describe('RETENTION_RULES', () => {
  it('covers exactly the four agentic tables', () => {
    expect(RETENTION_RULES.map((r) => r.table).sort()).toEqual([
      'agent_findings', 'agent_jobs', 'agent_project_runs', 'bot_runs',
    ]);
  });

  it('agent_jobs: only terminal statuses, and only with a finished_at under the cutoff', () => {
    const p = rule('agent_jobs').predicate;
    expect(p).toContain(`status IN ('done','failed','cancelled')`);
    expect(p).toContain('finished_at IS NOT NULL');
    expect(p).toContain('finished_at < :cutoff::timestamptz');
    // Live queue states must never appear in the delete predicate.
    for (const live of ['queued', 'claimed', 'running', 'awaiting_review']) {
      expect(p).not.toContain(`'${live}'`);
    }
  });

  it('bot_runs: terminal including skipped — a braked firing is history, and old history expires too', () => {
    const p = rule('bot_runs').predicate;
    expect(p).toContain(`status IN ('done','failed','skipped')`);
    expect(p).not.toContain(`'running'`);
    expect(p).toContain('finished_at < :cutoff::timestamptz');
  });

  it('agent_project_runs: keeps any run an agent_change_requests row still references', () => {
    const p = rule('agent_project_runs').predicate;
    expect(p).toContain(`status IN ('done','failed')`);
    expect(p).toMatch(/NOT EXISTS\s*\(SELECT 1 FROM agent_change_requests c WHERE c\.run_id = agent_project_runs\.id\)/);
  });

  it('agent_findings: resolved/dismissed by last_seen_at — open and promoted findings live forever', () => {
    const p = rule('agent_findings').predicate;
    expect(p).toContain(`status IN ('resolved','dismissed')`);
    expect(p).toContain('last_seen_at < :cutoff::timestamptz');
    expect(p).not.toContain(`'open'`);
    expect(p).not.toContain(`'promoted'`);
  });
});

describe('deleteBatchSql', () => {
  it('bounds each pass via id IN (SELECT ... LIMIT n) and returns the deleted ids', () => {
    const sql = deleteBatchSql(rule('agent_jobs'), 500);
    expect(sql).toContain('DELETE FROM agent_jobs');
    expect(sql).toMatch(/id IN \(\s*SELECT id FROM agent_jobs/);
    expect(sql).toContain('LIMIT 500');
    expect(sql).toContain('RETURNING id');
  });

  it('defaults to the batch limit', () => {
    expect(deleteBatchSql(rule('bot_runs'))).toContain(`LIMIT ${BATCH_LIMIT}`);
  });
});

describe('cutoffIso / retentionDays', () => {
  const now = Date.parse('2026-08-21T12:00:00.000Z');

  it('lands exactly RETENTION_DAYS before now', () => {
    expect(cutoffIso(30, now)).toBe('2026-07-22T12:00:00.000Z');
    expect(cutoffIso(1, now)).toBe('2026-08-20T12:00:00.000Z');
  });

  it('defaults to 30 days and ignores unusable values', () => {
    const prev = process.env['RETENTION_DAYS'];
    try {
      delete process.env['RETENTION_DAYS'];
      expect(retentionDays()).toBe(30);
      process.env['RETENTION_DAYS'] = '7';
      expect(retentionDays()).toBe(7);
      process.env['RETENTION_DAYS'] = 'not-a-number';
      expect(retentionDays()).toBe(30);
      process.env['RETENTION_DAYS'] = '0';
      expect(retentionDays()).toBe(30);
    } finally {
      if (prev === undefined) delete process.env['RETENTION_DAYS'];
      else process.env['RETENTION_DAYS'] = prev;
    }
  });
});
