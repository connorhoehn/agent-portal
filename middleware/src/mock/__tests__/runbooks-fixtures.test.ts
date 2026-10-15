// The five runbook fixtures: registered, scenario-aware, and undone by reset.
import { fixtureRegistry, declaredScenariosFor } from '../core/index.js';
import {
  fixtureRunbookSources, runbookApplicationsFixture, runbookProposalsFixture, runbookVersionsFixture, runbooksFixture, sessionBriefsFixture,
} from '../runbooks.js';
import { RowsRunbookStore } from '../../lib/runbooks/store-rows.js';
import { versionOf } from '../../lib/runbooks/version.js';
import { tenantCutoverV2 } from '../../lib/runbooks/__tests__/fixtures/good.js';

const KEYS = ['runbooks', 'runbook-versions', 'runbook-proposals', 'runbook-applications', 'session-briefs'];
const fixtures = [runbooksFixture, runbookVersionsFixture, runbookProposalsFixture, runbookApplicationsFixture, sessionBriefsFixture];

afterEach(() => fixtureRegistry.resetAll('default'));

describe('runbook fixtures', () => {
  it('registers all five and declares empty and large', () => {
    for (const k of KEYS) expect(fixtureRegistry.get(k)).toBeDefined();
    for (const f of fixtures) expect([...declaredScenariosFor(f)].sort()).toEqual(['default', 'empty', 'large']);
  });

  it('default is populated and self-consistent: every version belongs to a runbook, current_version exists', () => {
    const runbooks = runbooksFixture.rows();
    expect(runbooks.length).toBeGreaterThan(0);
    for (const r of runbooks) expect(runbookVersionsFixture.rows().some((v) => v.runbook_id === r.id && v.version === r.current_version)).toBe(true);
    for (const v of runbookVersionsFixture.rows()) expect(runbooks.some((r) => r.id === v.runbook_id)).toBe(true);
    // Lane C's seeded proposals (mock/runbooks.seed.ts): a run's edit, a run's new runbook, a person's near-duplicate.
    expect(fixtureRegistry.get('runbook-proposals')!.rows().map((p) => (p as { id: string }).id).sort())
      .toEqual(['prop-flaky-quarantine-check', 'prop-judge-rubric-weights', 'prop-tenant-cutover-callback']);
  });

  it('empty is empty and large is large, for every fixture', () => {
    for (const f of fixtures) {
      expect(f.rows('empty')).toEqual([]);
      expect(f.rows('large').length).toBeGreaterThan(f.rows('default').length);
    }
    expect(runbooksFixture.rows('large').length).toBeGreaterThan(100);
  });

  it('reset undoes every write made through the store', async () => {
    const store = new RowsRunbookStore(fixtureRunbookSources);
    const before = runbooksFixture.rows().map((r) => r.id);
    const rb = (await store.getRunbook('rb-sso-new-origin'))!;
    await store.putVersion(versionOf({ runbook_id: rb.id, version: 2, doc: tenantCutoverV2, author: { kind: 'person', id: 'p-001' } }), rb.current_version, '2026-10-14T00:00:00.000Z');
    await store.decideProposal({ proposal_id: 'prop-flaky-quarantine-check', decision: 'rejected', decided_by: 'p-001', at: '2026-10-14T00:00:00.000Z' });
    expect((await store.getRunbook(rb.id))!.current_version).toBe(2);
    expect((await store.getProposal('prop-flaky-quarantine-check'))!.status).toBe('rejected');

    fixtureRegistry.resetAll();
    expect((await store.getRunbook(rb.id))!.current_version).toBe(1);
    expect((await store.getProposal('prop-flaky-quarantine-check'))!.status).toBe('open');
    expect(runbooksFixture.rows().map((r) => r.id)).toEqual(before);
  });

  it('the store follows the live scenario', async () => {
    const store = new RowsRunbookStore(fixtureRunbookSources);
    fixtureRegistry.resetAll('empty');
    expect((await store.listRunbooks()).items).toEqual([]);
    fixtureRegistry.resetAll('large');
    expect((await store.listRunbooks({ limit: 10 })).next).not.toBeNull();
  });
});
