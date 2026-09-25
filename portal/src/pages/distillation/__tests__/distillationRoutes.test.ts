// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKnowledge, parseReview, parseActivity,
  knowledgeHref, reviewHref, activityHref, knowledgeItemHref, tabHref,
  migrateDistillationUrl, tabForPath, viewForLevel, levelForView, LEGACY_DISTILLATION_PATHS,
} from '../distillationRoutes.ts';

test('parseKnowledge defaults to guides with nothing open', () => {
  assert.deepEqual(parseKnowledge(''), {
    view: 'guides', item: null, panel: null, sourceView: 'list',
    repo: null, initiative: null, q: null, kind: null, lifecycle: null, tab: 'content', run: null,
  });
});

test('record tab: content is the default and omitted; run lives only on the Runs tab', () => {
  assert.equal(parseKnowledge('item=art-010&tab=history').tab, 'history');
  assert.equal(parseKnowledge('item=art-010&tab=bogus').tab, 'content');
  assert.deepEqual(
    (({ tab, run }) => ({ tab, run }))(parseKnowledge('item=art-010&tab=runs&run=papp-006')),
    { tab: 'runs', run: 'papp-006' },
  );
  assert.equal(parseKnowledge('item=art-010&tab=history&run=papp-006').run, null, 'a run off the Runs tab is ignored');
  assert.equal(knowledgeHref({ item: 'art-010', tab: 'content' }), '/iq/distillation/knowledge?item=art-010');
  assert.equal(knowledgeHref({ item: 'art-010', tab: 'history', run: 'papp-006' }), '/iq/distillation/knowledge?item=art-010&tab=history');
  const href = knowledgeHref({ item: 'art-010', tab: 'runs', run: 'papp-006' });
  assert.equal(href, '/iq/distillation/knowledge?item=art-010&tab=runs&run=papp-006');
  const back = parseKnowledge(href.split('?')[1]);
  assert.equal(back.tab, 'runs');
  assert.equal(back.run, 'papp-006');
  // Opening another record resets the tab: null means default, like every field.
  assert.equal(knowledgeHref({ ...back, item: 'art-009', tab: null, run: null }), '/iq/distillation/knowledge?item=art-009');
  assert.equal(knowledgeItemHref('art-010', 'L2', { tab: 'runs', run: 'papp-006' }), '/iq/distillation/knowledge?item=art-010&tab=runs&run=papp-006');
});

test('parseKnowledge reads every param and rejects unknown enum values', () => {
  const s = parseKnowledge('?view=patterns&item=cl-1&panel=sources&sourceView=graph&repo=api&initiative=p-rag-search&q=auth&kind=gotcha&lifecycle=draft');
  assert.equal(s.view, 'patterns');
  assert.equal(s.item, 'cl-1');
  assert.equal(s.panel, 'sources');
  assert.equal(s.sourceView, 'graph');
  assert.equal(s.repo, 'api');
  assert.equal(s.initiative, 'p-rag-search');
  assert.equal(s.q, 'auth');
  assert.equal(s.kind, 'gotcha');
  assert.equal(s.lifecycle, 'draft');
  const bad = parseKnowledge('view=bogus&panel=other&sourceView=tree&repo=');
  assert.equal(bad.view, 'guides');
  assert.equal(bad.panel, null);
  assert.equal(bad.sourceView, 'list');
  assert.equal(bad.repo, null, 'an empty filter is no filter');
});

test('knowledgeHref omits defaults and round-trips through parseKnowledge', () => {
  assert.equal(knowledgeHref(), '/iq/distillation/knowledge');
  assert.equal(knowledgeHref({ view: 'guides' }), '/iq/distillation/knowledge');
  const href = knowledgeHref({ view: 'notes', item: 'o 1', panel: 'sources', sourceView: 'graph', repo: 'api', q: 'x y' });
  assert.equal(href, '/iq/distillation/knowledge?view=notes&item=o+1&panel=sources&sourceView=graph&repo=api&q=x+y');
  const back = parseKnowledge(href.split('?')[1]);
  assert.equal(back.item, 'o 1');
  assert.equal(back.q, 'x y');
  assert.equal(back.sourceView, 'graph');
});

test('sourceView is dropped when the Sources inspector is closed', () => {
  assert.equal(knowledgeHref({ item: 'a', sourceView: 'graph' }), '/iq/distillation/knowledge?item=a');
  assert.equal(reviewHref({ sample: 's', sourceView: 'graph' }), '/iq/distillation/review?sample=s');
});

test('review and activity state parse + serialise', () => {
  assert.deepEqual(parseReview('tab=decided&sample=rs-2&panel=sources&sourceView=graph&q=k&repo=api'), {
    tab: 'decided', sample: 'rs-2', panel: 'sources', sourceView: 'graph', q: 'k', repo: 'api',
  });
  assert.equal(parseReview('tab=nope').tab, 'pending');
  assert.equal(reviewHref({ tab: 'pending' }), '/iq/distillation/review');
  assert.equal(reviewHref({ tab: 'decided', sample: 'rs-2' }), '/iq/distillation/review?tab=decided&sample=rs-2');

  assert.deepEqual(parseActivity('view=graph&run=comp-9&repo=api&level=L2&status=failed'), {
    view: 'graph', run: 'comp-9', repo: 'api', level: 'L2', status: 'failed',
  });
  assert.equal(parseActivity('level=L0').level, null, 'L0 is not a compaction target');
  assert.equal(activityHref({ view: 'runs' }), '/iq/distillation/activity');
  assert.equal(activityHref({ view: 'graph', run: 'c1' }), '/iq/distillation/activity?view=graph&run=c1');
});

test('tier ↔ view mapping', () => {
  assert.equal(viewForLevel('L0'), 'notes');
  assert.equal(viewForLevel('L1'), 'patterns');
  assert.equal(viewForLevel('L2'), 'guides');
  assert.equal(levelForView('patterns'), 'L1');
  assert.equal(knowledgeItemHref('cl-3', 'L1'), '/iq/distillation/knowledge?view=patterns&item=cl-3');
  assert.equal(knowledgeItemHref('art-1'), '/iq/distillation/knowledge?item=art-1');
});

test('tabForPath', () => {
  assert.equal(tabForPath('/iq/distillation/knowledge'), 'knowledge');
  assert.equal(tabForPath('/iq/distillation/review/'), 'review');
  assert.equal(tabForPath('/iq/distillation/tiers'), null);
  assert.equal(tabForPath('/iq/library'), null);
});

// ── Migration (spec §1) ──────────────────────────────────────────────────

test('module root and /overview land on Knowledge guides', () => {
  assert.equal(migrateDistillationUrl('/iq/distillation'), '/iq/distillation/knowledge');
  assert.equal(migrateDistillationUrl('/iq/distillation/'), '/iq/distillation/knowledge');
  assert.equal(migrateDistillationUrl('/iq/distillation/overview'), '/iq/distillation/knowledge');
});

test('/tiers maps level to view and keeps repo/initiative/q (+kind on L0 only)', () => {
  assert.equal(
    migrateDistillationUrl('/iq/distillation/tiers', '?level=L0&repo=api&initiative=p-soc2&kind=gotcha&q=retry'),
    '/iq/distillation/knowledge?view=notes&repo=api&initiative=p-soc2&kind=gotcha&q=retry',
  );
  assert.equal(migrateDistillationUrl('/iq/distillation/tiers', 'level=L1&kind=gotcha'), '/iq/distillation/knowledge?view=patterns');
  assert.equal(migrateDistillationUrl('/iq/distillation/tiers', 'level=L2&q=a'), '/iq/distillation/knowledge?q=a');
  // The old page defaulted to L0.
  assert.equal(migrateDistillationUrl('/iq/distillation/tiers', ''), '/iq/distillation/knowledge?view=notes');
});

test('/artifacts keeps the open artifact and its filters', () => {
  assert.equal(
    migrateDistillationUrl('/iq/distillation/artifacts', '?type=procedure&status=published&open=art-7'),
    '/iq/distillation/knowledge?item=art-7&kind=procedure&lifecycle=published',
  );
  assert.equal(migrateDistillationUrl('/iq/distillation/artifacts', 'type=all&status=all'), '/iq/distillation/knowledge');
});

test('/lineage opens the Sources graph on the focused item, or asks to choose one', () => {
  assert.equal(
    migrateDistillationUrl('/iq/distillation/lineage', 'focus=art-2'),
    '/iq/distillation/knowledge?item=art-2&panel=sources&sourceView=graph',
  );
  assert.equal(
    migrateDistillationUrl('/iq/distillation/lineage', ''),
    '/iq/distillation/knowledge?panel=sources&sourceView=graph',
  );
});

test('/compactions → Activity runs, honouring ?view=graph and the old filters', () => {
  assert.equal(migrateDistillationUrl('/iq/distillation/compactions'), '/iq/distillation/activity');
  assert.equal(
    migrateDistillationUrl('/iq/distillation/compactions', 'level=L1&status=failed'),
    '/iq/distillation/activity?level=L1&status=failed',
  );
  assert.equal(migrateDistillationUrl('/iq/distillation/compactions', 'view=graph'), '/iq/distillation/activity?view=graph');
  assert.equal(migrateDistillationUrl('/iq/distillation/compactions', 'level=all&status=all'), '/iq/distillation/activity');
});

test('/review and the new routes are not migrated; off-module paths are null', () => {
  assert.equal(migrateDistillationUrl('/iq/distillation/review', 'tab=decided'), null);
  assert.equal(migrateDistillationUrl('/iq/distillation/knowledge', 'item=x'), null);
  assert.equal(migrateDistillationUrl('/iq/distillation/activity'), null);
  assert.equal(migrateDistillationUrl('/iq/library'), null);
  assert.equal(migrateDistillationUrl('/iq/distillationx'), null);
});

test('every legacy path migrates somewhere', () => {
  for (const p of LEGACY_DISTILLATION_PATHS) {
    assert.ok(migrateDistillationUrl(`/iq/distillation/${p}`), p);
  }
});

test('a tab click keeps only the header repository scope', () => {
  assert.equal(tabHref('knowledge', null), '/iq/distillation/knowledge');
  assert.equal(tabHref('review', 'org/api'), '/iq/distillation/review?repo=org%2Fapi');
  assert.equal(tabHref('activity', 'org/api'), '/iq/distillation/activity?repo=org%2Fapi');
});
