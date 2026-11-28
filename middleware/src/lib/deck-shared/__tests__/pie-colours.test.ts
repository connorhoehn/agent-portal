// A pie trimmed to the top five and "Other" draws six slices in six colours a reader can tell apart, in every
// tenant's theme: the derived series used to carry a shade of the accent last, so "Other" matched the first slice.

import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { renderPreview } from '../render.js';
import { closestPair, DECK_HOST_TENANTS, distinctSeries, MIN_SERIES_DISTANCE, resolveDeckTheme, tenantDeckTheme } from '../themes.js';

const src = [{ title: 'Spend report', documentId: 'report:spend-by-initiative' }];
function pieDeck(tenant: string): DeckSpec {
  // What reports.ts trimForChart makes of eight initiatives: the top five and "Other" (it reads config, so not imported here).
  const fit = { labels: ['A', 'B', 'C', 'D', 'E', 'Other'], series: [{ name: 'Spend (USD)', values: [28, 28, 16, 7, 5, 16] }] };
  const valid = validateDeckSpec({
    title: 'Spend', theme: { ref: tenant },
    slides: [{ id: 'pie', layout: 'chart', title: 'Spend by initiative', chart: { kind: 'pie', labels: fit.labels, series: fit.series }, sources: src }],
  });
  if (!valid.ok) throw new Error(valid.errors.join('; '));
  return valid.spec;
}

describe('pie colours', () => {
  it.each(DECK_HOST_TENANTS)('%s: six slices, six distinguishable colours, "Other" last', (tenant) => {
    const theme = tenantDeckTheme(tenant);
    expect(theme.colors.series.length).toBeGreaterThanOrEqual(6);
    expect(closestPair(theme.colors.series)).toBeGreaterThanOrEqual(MIN_SERIES_DISTANCE);
    const svg = renderPreview(pieDeck(tenant), resolveDeckTheme({ ref: tenant }, tenant), 'vector').slides[0]!.svg;
    const wedges = [...svg.matchAll(/<polygon[^>]*fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!.toUpperCase());
    expect(wedges).toHaveLength(6);
    expect(new Set(wedges).size).toBe(6);
  });

  it('drops a near-duplicate and refills to six', () => {
    const out = distinctSeries(['#4F46E5', '#16A34A', '#D97706', '#DC2626', '#2563EB', '#4F55FF'], '#475569');
    expect(out).toHaveLength(6);
    expect(out).not.toContain('#4F55FF');
    expect(closestPair(out)).toBeGreaterThanOrEqual(MIN_SERIES_DISTANCE);
  });
});
