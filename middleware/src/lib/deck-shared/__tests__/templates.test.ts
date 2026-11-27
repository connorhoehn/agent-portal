// Deck templates (docs/deck-edit-operations.md): every template is a valid deck,
// lays out with ZERO findings under every tenant theme and every built-in theme,
// carries its metadata and its example sources, covers every layout between
// them, and its previews are rendered once per tenant.

jest.mock('../../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));

import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { builtinTheme } from '@connorhoehn/realtime-modules/deck/layout';
import {
  DECK_HOST_TENANTS, DECK_TEMPLATES, LAYOUT_USE_FOR, SLIDE_LAYOUTS, exampleSourceSlideIds, exampleSourceWarnings,
  layoutSpec, listLayouts, listTemplates, readTemplate, templateDeckSpec, templatePreviewStats, tenantDeckTheme,
} from '../index.js';

const THEMES = [
  ...DECK_HOST_TENANTS.map((t) => [t, tenantDeckTheme(t)] as const),
  ...(['product', 'engineering', 'plain'] as const).map((n) => [n, builtinTheme(n)] as const),
];

describe('deck templates', () => {
  it('there are five, each valid, with id, title, description, audience and every slide citing the template as its example', () => {
    expect(DECK_TEMPLATES.map((t) => t.id)).toEqual(['status-update', 'proposal', 'review', 'interview-debrief', 'run-report']);
    for (const t of DECK_TEMPLATES) {
      const valid = validateDeckSpec(t.spec);
      expect(valid.ok ? [] : valid.errors).toEqual([]);
      expect(t.title && t.description && t.audience).toBeTruthy();
      expect(t.description.length).toBeLessThanOrEqual(140);
      for (const s of t.spec.slides) expect(s.sources).toEqual([{ documentId: `example:template:${t.id}`, title: expect.stringContaining(t.title) }]);
      expect(exampleSourceSlideIds(t.spec)).toEqual(t.spec.slides.map((s) => s.id));
      expect(exampleSourceWarnings(t.spec)).toHaveLength(t.spec.slides.length);
    }
  });

  it.each(DECK_TEMPLATES.map((t) => [t.id, t] as const))('%s lays out with zero findings in every theme', (_id, t) => {
    for (const [name, theme] of THEMES) {
      const findings = layoutSpec({ ...t.spec, theme: name === 'product' || name === 'engineering' || name === 'plain' ? name : { ref: name } }, theme).findings;
      expect({ theme: name, findings }).toEqual({ theme: name, findings: [] });
    }
  });

  it('the zero-findings check is not vacuous: an overlong table is found', () => {
    const t = DECK_TEMPLATES.find((x) => x.id === 'proposal')!;
    const spec: DeckSpec = structuredClone(t.spec);
    const table = spec.slides.find((s) => s.layout === 'table')!;
    table.table = { header: ['A', 'B', 'C', 'D', 'E'], rows: Array.from({ length: 8 }, () => Array.from({ length: 5 }, () => 'A cell holding forty characters of text.')) };
    table.bullets = Array.from({ length: 6 }, () => 'A supporting line that takes up the room under the table on this slide.');
    expect(layoutSpec(spec, tenantDeckTheme('orgiq')).findings.length).toBeGreaterThan(0);
  });

  it('between them the templates show every layout, so the gallery has an example for each', () => {
    const used = new Set(DECK_TEMPLATES.flatMap((t) => t.spec.slides.map((s) => s.layout)));
    expect([...SLIDE_LAYOUTS].filter((l) => !used.has(l))).toEqual([]);
    const { layouts } = listLayouts('orgiq');
    expect(layouts.map((l) => l.layout)).toEqual([...SLIDE_LAYOUTS]);
    for (const l of layouts) {
      expect(l.useFor).toBe(LAYOUT_USE_FOR[l.layout]);
      expect(l.capacity.length).toBeGreaterThan(0);
      expect(l.example?.svg).toMatch(/^<svg/);
    }
  });

  it('lists metadata and the first three preview SVGs; previews render once per tenant', () => {
    const before = templatePreviewStats.renders;
    const first = listTemplates('social');
    const after = templatePreviewStats.renders;
    expect(after - before).toBeLessThanOrEqual(DECK_TEMPLATES.length);
    listTemplates('social');
    readTemplate('social', 'review');
    expect(templatePreviewStats.renders).toBe(after);
    for (const [i, t] of first.templates.entries()) {
      expect(t).toMatchObject({ id: DECK_TEMPLATES[i]!.id, slideCount: DECK_TEMPLATES[i]!.spec.slides.length });
      expect(t.preview).toHaveLength(3);
      expect(t.preview[0]!.svg).toMatch(/^<svg/);
    }
    const one = readTemplate('social', 'review')!;
    expect(one.spec.theme).toEqual({ ref: 'social' });
    expect(one.preview.slides).toHaveLength(DECK_TEMPLATES[2]!.spec.slides.length + 1); // and the Sources slide
    expect(readTemplate('social', 'nope')).toBeNull();
  });

  it('a deck from a template takes the caller title and the tenant theme; bad input is 400', () => {
    const made = templateDeckSpec({ templateId: 'run-report', title: 'Our run' }, 'pipelines');
    expect(made.ok && made.value.spec).toMatchObject({ title: 'Our run', theme: { ref: 'pipelines' } });
    expect(templateDeckSpec({ templateId: 'nope' }, 'pipelines')).toMatchObject({ ok: false, status: 400 });
    expect(templateDeckSpec({ templateId: 'review', title: '' }, 'pipelines')).toMatchObject({ ok: false, status: 400 });
  });
});
