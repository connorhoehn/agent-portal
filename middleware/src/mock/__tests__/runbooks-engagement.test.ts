// The six runbooks written after a lost day (mock/runbooks-engagement.ts) lint
// clean as skills beside every other published runbook in the default world,
// round-trip through their markdown, and their open edit lints clean too.
import { lintRunbook, parseRunbook, renderRunbook, skillDescription } from '../../lib/runbooks/index.js';
import { repoLintContext } from '../../lib/runbooks/repo-context.js';
import { ENGAGEMENT_DOCS, engagementRunbookRows } from '../runbooks-engagement.js';
import { runbookSeedRows } from '../runbooks-seed-seam.js';

const ctx = repoLintContext();

describe('engagement runbooks', () => {
  const world = runbookSeedRows();
  const current = (id: string) => {
    const r = world.runbooks.find((x) => x.id === id)!;
    return world.versions.find((v) => v.runbook_id === id && v.version === r.current_version)!;
  };
  const published = world.runbooks.filter((r) => r.status === 'published');

  for (const { id, doc } of ENGAGEMENT_DOCS) {
    it(`${id} lints clean as a skill beside the whole library`, () => {
      const others = published.filter((r) => r.id !== id).map((r) => ({ name: r.id, description: skillDescription(current(r.id).doc) }));
      expect(lintRunbook(doc, { ...ctx, skill: { name: id, others } })).toEqual([]);
    });
    it(`${id} round-trips through its markdown`, () => {
      expect(parseRunbook(renderRunbook(doc))).toEqual(doc);
    });
  }

  it('is in the default world: published, owned, with runs that followed it', () => {
    for (const { id } of ENGAGEMENT_DOCS) {
      const r = world.runbooks.find((x) => x.id === id);
      expect(r?.status).toBe('published');
      expect(world.applications.some((a) => a.runbook_id === id)).toBe(true);
    }
  });

  it('the open edit from run sess-llm-07 lints clean and targets v1', () => {
    const p = engagementRunbookRows().proposals.find((x) => x.id === 'prop-kb-search-text-index')!;
    expect(p.base_version).toBe(1);
    expect(p.lint.filter((f) => f.severity === 'error')).toEqual([]);
    expect(world.proposals.some((x) => x.id === p.id && x.status === 'open')).toBe(true);
  });
});
