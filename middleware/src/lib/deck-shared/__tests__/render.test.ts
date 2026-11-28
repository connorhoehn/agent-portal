// The one rendering path: built-in themes render as before, a tenant ref
// renders with the tenant's brand, the cache answers a second request without
// rendering, the LRU is bounded by bytes, and the time budget answers in time.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { builtinTheme } from '@connorhoehn/realtime-modules/deck/layout';
import {
  DECK_ENGINE_VERSION, DECK_PREVIEW_PNG_WIDTH, DeckRenderBudgetError, previewSlideCache, renderCache, renderDeckFile, renderPreview, renderRevisionBytes, renderStats,
  setDeckRenderClockForTests, themeHash,
} from '../render.js';
import { ByteLru } from '../byte-lru.js';
import { resolveDeckTheme, tenantDeckTheme, tenantDeckThemeAdjustments } from '../themes.js';
import { TENANT_BRANDS } from '../../tenants.generated.js';
import { hidePptxNodeDetection } from '../../../test-support/pptxTestEnv.js';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());
afterEach(() => setDeckRenderClockForTests(null));

const src = [{ title: 'Status note', documentId: 'doc-1' }];
function deck(theme?: DeckSpec['theme']): DeckSpec {
  const valid = validateDeckSpec({
    title: 'Quarter review', ...(theme !== undefined ? { theme } : {}),
    slides: [
      { id: 'title', layout: 'title', title: 'Quarter review', sources: src },
      { id: 'b1', layout: 'bullets', title: 'What moved', bullets: ['Shipped the export menu', 'Closed the overflow findings'], sources: src },
    ],
  });
  if (!valid.ok) throw new Error(valid.errors.join('; '));
  return valid.spec;
}

describe('deck themes', () => {
  it('a deck naming a built-in theme renders with exactly that built-in theme', () => {
    for (const name of ['plain', 'product', 'engineering'] as const) {
      expect(resolveDeckTheme(deck(name).theme, 'assessment')).toEqual(builtinTheme(name));
    }
    expect(resolveDeckTheme(undefined, 'social')).toEqual(builtinTheme());
    const plainSvg = renderPreview(deck('plain'), resolveDeckTheme('plain', 'orgiq'), 'vector').slides[1]!.svg;
    expect(plainSvg).toContain(builtinTheme('plain').colors.accent);
  });

  it('a new deck naming its tenant renders with the tenant\'s accent; an unknown ref falls back to the tenant\'s own', () => {
    for (const tenant of ['assessment', 'orgiq', 'pipelines', 'social'] as const) {
      const theme = tenantDeckTheme(tenant);
      expect(theme.id).toBe(tenant);
      expect(resolveDeckTheme({ ref: tenant }, tenant)).toEqual(theme);
      expect(resolveDeckTheme({ ref: 'no-such-theme' }, tenant)).toEqual(theme);
      expect(resolveDeckTheme({ ref: tenant === 'social' ? 'orgiq' : 'social' }, tenant)).toEqual(theme); // never another product's brand
    }
    // The brand accents pass contrast on the base background, so they are used as they are.
    const orgiq = tenantDeckTheme('orgiq');
    expect(orgiq.colors.accent).toBe(TENANT_BRANDS.orgiq!.accent.toUpperCase());
    const svg = renderPreview(deck({ ref: 'orgiq' }), orgiq, 'vector').slides[1]!.svg;
    expect(svg).toContain(orgiq.colors.accent);
    expect(svg).not.toContain(builtinTheme('plain').colors.accent);
  });

  it('records what contrast forced it to change, for the startup log', () => {
    const adjustments = tenantDeckThemeAdjustments();
    expect(Object.keys(adjustments).sort()).toEqual(['assessment', 'orgiq', 'pipelines', 'social']);
    // The CSS brand ink is a dark text tone, not text on the accent, so the generator swaps it.
    expect(adjustments.orgiq!.join(' ')).toMatch(/accentInk/);
  });
});

describe('the preview', () => {
  it('answers one slide image per slide plus Sources, and turns overflow findings into warnings', () => {
    const long = Array.from({ length: 8 }, (_, i) => `Bullet ${i + 1}: ${'a long line of words that keeps going '.repeat(6).trim()}`.slice(0, 200));
    const valid = validateDeckSpec({ title: 'Crowded', slides: [{ id: 'b', layout: 'bullets', title: 'Too much', bullets: long, sources: src }] });
    if (!valid.ok) throw new Error(valid.errors.join('; '));
    const preview = renderPreview(valid.spec, builtinTheme('plain'));
    expect(preview.slides.map((s) => s.id)).toEqual(['b', 'sources']);
    expect(preview.slides[0]!.svg).toMatch(/^<svg/);
    expect(preview.findings.length).toBeGreaterThan(0);
    expect(preview.warnings.some((w) => /^Slide 1 \(b\) (bullet|body)/.test(w))).toBe(true);
  });

  it('each slide is a stage-sized SVG wrapping one PNG painted with the bundled fonts, never a font family name', () => {
    const preview = renderPreview(deck('plain'), builtinTheme('plain'));
    for (const slide of preview.slides) {
      const m = /^<svg [^>]*width="(\d+)" height="(\d+)" viewBox="0 0 \1 \2"><image [^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"\/><\/svg>$/.exec(slide.svg);
      expect(m).not.toBeNull();
      expect(slide.svg).not.toMatch(/font-family|<text/);
      const png = Buffer.from(m![3]!, 'base64');
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(DECK_PREVIEW_PNG_WIDTH); // IHDR width
    }
    // The vector form stays available and names the engine's fonts.
    expect(renderPreview(deck('plain'), builtinTheme('plain'), 'vector').slides[0]!.svg).toMatch(/<text/);
  });

  it('an unchanged slide is not painted again, and a 10-slide preview stays a reasonable size', () => {
    previewSlideCache.clear();
    const bullets = Array.from({ length: 4 }, (_, i) => `Point ${i + 1} about the rollout and what it changed`);
    const tenSlides = (edit: string): DeckSpec => {
      const valid = validateDeckSpec({
        title: 'Ten slides', theme: 'plain',
        slides: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, layout: 'bullets', title: i === 3 ? edit : `Slide ${i + 1}`, bullets, sources: src })),
      });
      if (!valid.ok) throw new Error(valid.errors.join('; '));
      return valid.spec;
    };
    const before = renderStats.previewPngs;
    const first = renderPreview(tenSlides('Before'), builtinTheme('plain'));
    expect(renderStats.previewPngs - before).toBe(first.slides.length);
    const bytes = JSON.stringify(first).length;
    expect(bytes).toBeLessThan(2_500_000);
    const again = renderPreview(tenSlides('After'), builtinTheme('plain'));
    expect(renderStats.previewPngs - before).toBe(first.slides.length + 1); // only the edited slide
    expect(again.slides[3]!.svg).not.toBe(first.slides[3]!.svg);
    expect(again.slides[0]!.svg).toBe(first.slides[0]!.svg);
    // eslint-disable-next-line no-console
    if (process.env.DECK_PREVIEW_SIZE) console.log(`10-slide preview: ${bytes} bytes`);
  });
});

describe('the render cache', () => {
  beforeEach(() => renderCache.clear());

  it('a second request for the same revision, format and theme does not render again', async () => {
    const spec = deck('plain');
    const theme = builtinTheme('plain');
    const before = renderStats.files;
    const first = await renderRevisionBytes('rev-cache-1', spec, theme, 'pdf');
    const second = await renderRevisionBytes('rev-cache-1', spec, theme, 'pdf');
    expect(renderStats.files - before).toBe(1);
    expect(second.bytes).toBe(first.bytes);
    await renderRevisionBytes('rev-cache-1', spec, theme, 'pptx'); // another format renders
    await renderRevisionBytes('rev-cache-1', spec, builtinTheme('product'), 'pdf'); // another theme renders
    expect(renderStats.files - before).toBe(3);
  });

  it('the key names the installed engine version and a stable theme hash', () => {
    const installed = JSON.parse(readFileSync(join(process.cwd(), 'node_modules', '@connorhoehn', 'realtime-modules', 'package.json'), 'utf8')).version;
    expect(DECK_ENGINE_VERSION).toBe(installed);
    expect(themeHash(builtinTheme('plain'))).toBe(themeHash(builtinTheme('plain')));
    expect(themeHash(builtinTheme('plain'))).not.toBe(themeHash(builtinTheme('product')));
  });

  it('the LRU is bounded by total bytes and drops the least recently used', () => {
    const lru = new ByteLru<Buffer>(10, (b) => b.length);
    lru.set('a', Buffer.alloc(4)); lru.set('b', Buffer.alloc(4));
    lru.get('a');
    lru.set('c', Buffer.alloc(4));
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBeDefined();
    expect(lru.bytes).toBe(8);
    lru.set('huge', Buffer.alloc(11));
    expect(lru.get('huge')).toBeUndefined();
  });
});

describe('the render time budget', () => {
  it('a render past its budget throws DeckRenderBudgetError with a plain sentence', async () => {
    let t = 0;
    setDeckRenderClockForTests(() => (t += 1_000)); // every check sees another second gone
    await expect(renderDeckFile(deck('plain'), builtinTheme('plain'), 'png', 1_500)).rejects.toThrow(DeckRenderBudgetError);
    await expect(renderDeckFile(deck('plain'), builtinTheme('plain'), 'png', 1_500)).rejects.toThrow(/longer than 2 seconds/);
  });
});
