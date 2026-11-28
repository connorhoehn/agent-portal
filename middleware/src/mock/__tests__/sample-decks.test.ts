// The sample decks the default mock world seeds (mock/sample-decks.ts): each
// is valid, 10 to 16 slides, lays out with zero findings in its tenant's theme,
// carries a chart, uses no picture layout, and between them they use all five
// styles. Their numbers are the rows' own: the report charts equal what the
// report's providers count, and the work and scorecard figures equal what the
// deck-facts providers read.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));

import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { initiativeDecksFixture, initiativeDeckRevisionsFixture } from '../initiative-decks.js';
import { assessmentDecksFixture, assessmentDeckRevisionsFixture } from '../assessment-decks.js';
import { findingsBySeverityChart, isSampleDeckId, jobsByStatusChart, SAMPLE_STYLES, teamCertification, workStatusCounts } from '../sample-decks.js';
import { layoutSpec } from '../../lib/deck-shared/render.js';
import { deckStyleOf, resolveDeckTheme } from '../../lib/deck-shared/themes.js';
import { IMAGE_LAYOUTS } from '../../lib/deck-shared/slide-starters.js';
import { queueStats } from '../../providers/agent-jobs.js';
import { findingStats } from '../../providers/org-sweeps.js';
import { getProjectWorkItems } from '../../providers/work-items.js';
import { getTeamDeckSource } from '../../providers/assessment.js';

const samples = (): Array<{ tenant: 'orgiq' | 'assessment'; spec: DeckSpec; key: string }> => [
  ...initiativeDeckRevisionsFixture.rows().map((r) => ({ tenant: 'orgiq' as const, spec: r.spec, key: r.producedBy })),
  ...assessmentDeckRevisionsFixture.rows().map((r) => ({ tenant: 'assessment' as const, spec: r.spec, key: r.producedBy })),
];

describe('sample decks', () => {
  it('the default world has four initiative decks and one team readout, each with its one revision as head; the empty world has none', () => {
    expect(initiativeDecksFixture.rows().map((d) => d.projectId)).toEqual(['p-auth-migration', 'p-observability', 'p-soc2', 'p-rag-search']);
    expect(assessmentDecksFixture.rows().map((d) => d.teamId)).toEqual(['TEAM-001']);
    for (const [decks, revs] of [[initiativeDecksFixture.rows(), initiativeDeckRevisionsFixture.rows()], [assessmentDecksFixture.rows(), assessmentDeckRevisionsFixture.rows()]] as const) {
      for (const d of decks) {
        expect(isSampleDeckId(d.id)).toBe(true);
        const head = revs.find((r) => r.id === d.headRevisionId)!;
        expect(head).toMatchObject({ deckId: d.id, seq: 1, baseRevisionId: null, createdAt: d.updatedAt });
        expect(head.spec.title).toBe(d.title);
      }
    }
    expect(initiativeDecksFixture.rows('empty')).toEqual([]);
    expect(assessmentDeckRevisionsFixture.rows('empty')).toEqual([]);
  });

  it.each(samples().map((s) => [s.key, s] as const))('%s is valid, 10 to 16 slides, picture-free, charted, noted and lays out with zero findings', (_k, s) => {
    const valid = validateDeckSpec(s.spec);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    expect(s.spec.slides.length).toBeGreaterThanOrEqual(10);
    expect(s.spec.slides.length).toBeLessThanOrEqual(16);
    expect(s.spec.slides.filter((x) => (IMAGE_LAYOUTS as readonly string[]).includes(x.layout))).toEqual([]);
    expect(s.spec.slides.some((x) => x.chart)).toBe(true);
    expect(s.spec.slides.filter((x) => x.notes).length).toBeGreaterThanOrEqual(s.spec.slides.length - 1);
    expect(new Set(s.spec.slides.map((x) => x.layout)).size).toBeGreaterThanOrEqual(8);
    expect(layoutSpec(s.spec, resolveDeckTheme(s.spec.theme, s.tenant)).findings).toEqual([]);
  });

  it('between them they use all five styles, and each orgiq deck charts a report', () => {
    expect(new Set(samples().map((s) => deckStyleOf(s.spec.theme, s.tenant)))).toEqual(new Set(Object.values(SAMPLE_STYLES)));
    expect(new Set(Object.values(SAMPLE_STYLES))).toEqual(new Set(['bold', 'editorial', 'minimal', 'playful', 'corporate']));
    for (const s of samples().filter((x) => x.tenant === 'orgiq')) {
      expect(s.spec.slides.some((x) => x.chart && x.sources.some((src) => src.documentId.startsWith('report:')))).toBe(true);
    }
  });

  it('the report charts are the reports\' own numbers', async () => {
    const q = await queueStats();
    const jobs = jobsByStatusChart();
    expect(jobs.labels.map((l, i) => [l, jobs.series[0]!.values[i]])).toEqual(
      (['queued', 'claimed', 'running', 'awaiting_review', 'done', 'failed', 'cancelled'] as const).filter((k) => q[k] > 0)
        .map((k) => [k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), q[k]]),
    );
    const bySeverity = new Map<string, number>();
    for (const row of await findingStats()) if (row.status === 'open') bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + row.n);
    const f = findingsBySeverityChart();
    expect(Object.fromEntries(f.labels.map((l, i) => [l.toLowerCase(), f.series[0]!.values[i]]))).toEqual(Object.fromEntries(bySeverity));
  });

  it('the work counts and the scorecard counts are what the deck-facts providers read', async () => {
    for (const pid of ['p-auth-migration', 'p-observability', 'p-soc2', 'p-rag-search']) {
      const items = (await getProjectWorkItems(pid)).filter((w) => w.type !== 'epic');
      const c = workStatusCounts(pid);
      for (const s of ['open', 'in_progress', 'in_review', 'done'] as const) expect([pid, s, c[s]]).toEqual([pid, s, items.filter((w) => w.status === s).length]);
    }
    const source = await getTeamDeckSource('TEAM-001');
    const cert = (source!.detail as unknown as { team: { certification: Record<string, number> } }).team.certification;
    const mine = teamCertification('TEAM-001');
    expect({ target: mine.target, atOrAbove: mine.atOrAbove, below: mine.below, assessed: mine.assessed, claimsOpen: mine.claimsOpen, highest: mine.highest })
      .toEqual({ target: cert['target_level'], atOrAbove: cert['at_or_above_target'], below: cert['below_target'], assessed: cert['assessed'], claimsOpen: cert['claims_open'], highest: cert['highest_verified_level'] });
  });
});
