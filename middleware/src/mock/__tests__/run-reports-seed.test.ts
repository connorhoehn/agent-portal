// The default world's one run report belongs to Auth Migration, so its Learning tab has a run to show.
import { seededReports } from '../run-reports.js';
import { FROZEN_RUN, seedBriefs } from '../runbooks.seed.js';

describe('the seeded run report', () => {
  it('is the frozen-brief run on Auth Migration, marked as demo data, offering what its brief offered', () => {
    const [r] = seededReports();
    const brief = seedBriefs()[0]!;
    expect(seededReports()).toHaveLength(1);
    expect(r!.runRef).toBe(FROZEN_RUN.runRef);
    expect(r!.initiativeId).toBe('p-auth-migration');
    expect(r!.cost.basis).toBe('simulated');
    expect(r!.briefId).toBe(brief.id);
    expect(r!.runbooksOffered.map((x) => x.id)).toEqual(brief.sections.filter((s) => s.kind === 'runbook').map((s) => s.ref));
    expect(r!.runbooksOffered.length).toBeGreaterThan(0);
    expect(Date.parse(r!.endedAt)).toBeLessThanOrEqual(Date.now());
  });
});
