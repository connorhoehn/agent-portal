// Run reports and runbook proposals in the org search (docs/value-sweep-2026-11-11.md package 10).
// A result must never show a person a record the list route would refuse them: a run report answers to
// the run-reports list gate (a read role, or ManageBots) and a proposal to ViewRunbooks.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({
  isAllowed: jest.fn(async (p: { role: string }, action: string) => {
    if (action === 'Search' || action === 'ViewOrgChart') return true;
    if (action === 'ManageBots') return p.role === 'sme';
    return false;
  }),
}));
jest.mock('../../../providers/recording-search.js', () => ({ listRecordingSearchRecords: jest.fn(async () => ({ records: [], partial: [] })), resolveRecordingSearchRecord: jest.fn(), recordingsAreASource: jest.fn(() => false) }));
import { searchRecords } from '../../../providers/search.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { __resetSearchIndex } from '../registry.js';
import { runbookStore } from '../../runbooks/store-select.js';
import { listRunbookSearchEntries } from '../../runbooks/search-entries.js';
import { runReportStore } from '../../run-reports/store-select.js';

const as = (role: string) => ({ sub: `u-${role}`, tenant: 'orgiq', role });
const found = async (role: string, q: string, type?: 'run' | 'proposal' | 'knowledge') =>
  (await searchRecords(as(role), { q, ...(type ? { type } : {}) })).results.filter((r) => !type || r.type === type);

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

test('a run report is found by text for the roles that can list run reports, and for nobody else', async () => {
  for (const role of ['program-owner', 'org-leader', 'hr-admin', 'sme', 'admin']) {
    const rows = await found(role, 'CSRF', 'run');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.href).toMatch(/^\/iq\/runs\//);
    expect(rows[0]!.title).not.toBe('');
  }
  for (const role of ['member', 'nobody']) {
    expect(await found(role, 'CSRF', 'run')).toEqual([]);
    expect((await searchRecords(as(role), { q: 'CSRF' })).results.some((r) => r.type === 'run')).toBe(false);
    expect((await searchRecords(as(role), { q: 'CSRF' })).counts['run'] ?? 0).toBe(0);
  }
});

test('a runbook proposal is found by its rationale by any orgiq reader, and the count matches', async () => {
  const [first] = (await runbookStore().listProposals({ limit: 1 })).items;
  expect(first).toBeDefined();
  const word = (first!.rationale.match(/[A-Za-z]{6,}/) ?? [])[0]!;
  const rows = await found('member', word, 'proposal');
  expect(rows.map((r) => r.id)).toContain(first!.id);
  expect(rows.find((r) => r.id === first!.id)!.href).toBe(`/iq/runbooks/proposals/${encodeURIComponent(first!.id)}`);
  // The list route is open to any orgiq session, so search is too; a session from another tenant is refused outright.
  expect((await searchRecords(as('member'), { q: word })).counts['proposal']).toBeGreaterThan(0);
  await expect(searchRecords({ sub: 'u-x', tenant: 'assessment', role: 'member' }, { q: word })).rejects.toThrow();
});

test('a runbook is found by a word that is only in its body', async () => {
  const entries = await listRunbookSearchEntries();
  const pick = entries.map((e) => ({ e, word: (e.body.split(/\s+/).find((w) => /^[A-Za-z]{8,}$/.test(w) && !`${e.title} ${e.summary}`.toLowerCase().includes(w.toLowerCase())) ?? '') })).find((x) => x.word);
  expect(pick).toBeDefined();
  expect((await found('member', pick!.word, 'knowledge')).map((r) => r.id)).toContain(pick!.e.id);
});

test('a new run report is searchable on the next query without a rebuild', async () => {
  await searchRecords(as('sme'), { q: 'warmup' });
  const base = (await runReportStore().listReports({ limit: 1 })).items[0]!;
  await runReportStore().putReport({ ...base, runRef: 'run-xyz-1', summary: 'Rotated the quokkaplex signing key', endedAt: '2099-01-01T00:00:00.000Z' });
  const { noteSearchWrite } = await import('../writes.js');
  await noteSearchWrite({ type: 'run', id: 'run-xyz-1' });
  expect((await found('sme', 'quokkaplex', 'run')).map((r) => r.id)).toEqual(['run-xyz-1']);
  expect(await found('member', 'quokkaplex', 'run')).toEqual([]);
});
