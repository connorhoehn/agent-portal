import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratePromotionsUrl, promotionReviewHref } from '../distillationRoutes.ts';
import { activeNavId, moduleNav } from '../moduleNavModel.ts';

test('legacy promotion links retain filters, item identifiers, repeated params and anchors', () => {
  const migrated = migratePromotionsUrl('/iq/promotions', '?item=promo-1&status=dismissed&repo=owner%2Frepo&q=retry&extra=a&extra=b', '#observation-obs-1');
  const url = new URL(migrated!, 'https://org.test');
  assert.equal(url.pathname, '/iq/distillation/review');
  assert.equal(url.searchParams.get('view'), 'promotions');
  assert.equal(url.searchParams.get('item'), 'promo-1');
  assert.equal(url.searchParams.get('status'), 'dismissed');
  assert.equal(url.searchParams.get('repo'), 'owner/repo');
  assert.deepEqual(url.searchParams.getAll('extra'), ['a', 'b']);
  assert.equal(url.hash, '#observation-obs-1');
});

test('legacy item path takes precedence and library deep links remain untouched', () => {
  assert.equal(new URL(migratePromotionsUrl('/iq/promotions/promo%20one', '?item=stale')!, 'https://org.test').searchParams.get('item'), 'promo one');
  assert.equal(migratePromotionsUrl('/iq/library/asset-1', '?kind=skill'), null);
  assert.equal(migratePromotionsUrl('/iq/promotions-extra'), null);
});

test('promotion selection stays distinct from knowledge samples for both roles', () => {
  assert.equal(activeNavId('/iq/distillation/review', '?view=promotions&status=dismissed'), 'promotions');
  assert.equal(activeNavId('/iq/distillation/review', '?sample=sample-1&tab=decided'), 'decided');
  for (const canReview of [true, false]) {
    const entry = moduleNav({ promotions: 3 }, 'owner/repo', canReview).find((n) => n.id === 'promotions')!;
    assert.equal(entry.group, 'Review');
    assert.equal(entry.count, 3);
    assert.equal(entry.path, promotionReviewHref('repo=owner%2Frepo'));
  }
});
