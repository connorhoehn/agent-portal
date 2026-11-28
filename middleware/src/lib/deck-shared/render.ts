// The one rendering path for every tenant's decks: a validated DeckSpec and a
// resolved theme are laid out once (realtime-modules `layoutDeck`, with the
// bundled font metrics), then painted as the preview (a PNG per slide in a
// stage-sized SVG wrapper, so the bundled fonts show), the
// PowerPoint file, the PDF or the slide images (a zip of 1920-wide PNGs).
//
// Time budget: rendering runs on the request's own thread (this repository has
// no worker-thread pattern to reuse), so the budget is cooperative. The clock
// is checked after the layout, between slides while rasterising, and after
// each painter; an async painter is also raced against the remaining budget,
// so the response is a 503 on time even when the painter is still running.
// What this cannot do is interrupt one long synchronous step (the layout of a
// deck, or one slide's rasterisation) part-way: the deck caps (40 slides, short
// text) keep each step small, and that is the guarantee, not a preemption.
//
// Rendered files are cached in memory (`renderCache`): revisions are immutable,
// so the key is the revision id, the format, the engine version and a hash of
// the resolved theme.

import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { deckWarnings, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { editableRegions, layoutDeck, type DeckLayout, type EditableRegion, type DeckThemeSpec, type FontMetrics, type LayoutFinding } from '@connorhoehn/realtime-modules/deck/layout';
import { loadBundledFonts, type FontFileSet } from '@connorhoehn/realtime-modules/deck/fonts';
import { paintSvg } from '@connorhoehn/realtime-modules/deck/paint-svg';
import { paintPptx, PPTX_SCENE_CONTENT_TYPE } from '@connorhoehn/realtime-modules/deck/paint-pptx';
import { paintPdf, PDF_CONTENT_TYPE } from '@connorhoehn/realtime-modules/deck/paint-pdf';
import { paintPng } from '@connorhoehn/realtime-modules/deck/paint-png';
import { ByteLru } from './byte-lru.js';

/** The installed engine (realtime-modules) version; part of every cache key. A test holds it to the installed package. */
export const DECK_ENGINE_VERSION = '0.154.0';

/** How long one render may take before the request is answered 503. */
export const DECK_RENDER_BUDGET_MS = 20_000;

/** The width of each slide image in the `png` export. */
export const DECK_PNG_WIDTH = 1920;

/** The in-memory cache's bound, in bytes of rendered files. */
export const DECK_RENDER_CACHE_BYTES = 64 * 1024 * 1024;

export const DECK_FILE_FORMATS = ['pptx', 'pdf', 'png'] as const;
export type DeckFileFormat = typeof DECK_FILE_FORMATS[number];

export const isDeckFileFormat = (v: unknown): v is DeckFileFormat =>
  typeof v === 'string' && (DECK_FILE_FORMATS as readonly string[]).includes(v);

export const ZIP_CONTENT_TYPE = 'application/zip';

/** A render that ran past `DECK_RENDER_BUDGET_MS`; the route answers 503 with `message`. */
export class DeckRenderBudgetError extends Error {
  constructor(budgetMs: number) {
    super(`The deck took longer than ${Math.round(budgetMs / 1000)} seconds to render, so it was stopped. Try again, or shorten the deck.`);
    this.name = 'DeckRenderBudgetError';
  }
}

// ─── Fonts (loaded once per process) ─────────────────────────────────────────

let fonts: { files: FontFileSet; metrics: FontMetrics } | null = null;

/** The bundled font files and their metrics, read from disk on first use and kept for the process. */
export function deckFonts(): { files: FontFileSet; metrics: FontMetrics } {
  fonts ??= loadBundledFonts();
  return fonts;
}

// ─── Seams (tests count renders through these) ───────────────────────────────

export const renderStats = { layouts: 0, files: 0, previewPngs: 0 };

/** A test's clock; production uses Date.now. */
let now: () => number = () => Date.now();
export function setDeckRenderClockForTests(clock: (() => number) | null): void { now = clock ?? (() => Date.now()); }

// ─── Layout ──────────────────────────────────────────────────────────────────

export function layoutSpec(spec: DeckSpec, theme: DeckThemeSpec): DeckLayout {
  renderStats.layouts += 1;
  return layoutDeck(spec, theme, deckFonts().metrics);
}

/** A layout finding as one sentence for the preview's `warnings`. */
export function findingWarning(finding: LayoutFinding, layout: DeckLayout): string {
  const scene = layout.scenes.find((s) => s.id === finding.slideId);
  const at = scene ? `Slide ${scene.index + 1} (${finding.slideId})` : `Slide ${finding.slideId}`;
  // The detail usually names its region already ("standfirst: 5 lines need …") and says by how much.
  const detail = finding.detail.startsWith(`${finding.region}:`) ? finding.detail : `${finding.region}: ${finding.detail}`;
  return `${at} ${detail}`;
}

export interface DeckPreviewRender {
  /** `regions`: where each editable field sits, in stage points (960 x 540), for editing in place; none on the Sources slide. */
  slides: Array<{ id: string; svg: string; title: string; regions?: EditableRegion[] }>;
  /** The spec's advisory warnings, then one sentence per layout finding. */
  warnings: string[];
  findings: LayoutFinding[];
}

/**
 * The width of each preview slide's raster. An SVG shown through an image
 * element cannot load fonts, so the preview carries a PNG painted with the
 * bundled fonts; 1600 is sharp for the stage on a 2x display without being
 * the 1920 of the export.
 */
export const DECK_PREVIEW_PNG_WIDTH = 1600;

/** Painted preview slides, keyed by the scene's content, so an unchanged slide (most thumbnails) is not rasterised again. */
export const DECK_PREVIEW_CACHE_BYTES = 48 * 1024 * 1024;
export const previewSlideCache = new ByteLru<string>(DECK_PREVIEW_CACHE_BYTES, (s) => s.length);

/** A minimal SVG of the stage size whose only content is the slide's PNG, so the page's image path shows the true fonts. */
export function pngPreviewSvg(png: Buffer, stage: { width: number; height: number }): string {
  const { width, height } = stage;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<image width="${width}" height="${height}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
}

function rasterPreviewSlide(scene: DeckLayout['scenes'][number], stage: DeckLayout['stage']): string {
  const key = createHash('sha256')
    .update(`${DECK_ENGINE_VERSION}|${DECK_PREVIEW_PNG_WIDTH}|${stage.width}x${stage.height}|`)
    .update(JSON.stringify(scene))
    .digest('hex');
  const hit = previewSlideCache.get(key);
  if (hit) return hit;
  renderStats.previewPngs += 1;
  const svg = pngPreviewSvg(paintPng(scene, { fonts: deckFonts().files, width: DECK_PREVIEW_PNG_WIDTH, stage }), stage);
  previewSlideCache.set(key, svg);
  return svg;
}

/** Editable regions per slide, cached beside the painted slides by the scene and the slide's spec. */
export const previewRegionCache = new ByteLru<EditableRegion[]>(4 * 1024 * 1024, (r) => JSON.stringify(r).length);

const tenth = (n: number): number => Math.round(n * 10) / 10;

/** The engine's regions for one slide, with boxes rounded to a tenth of a point to keep the preview lean. */
function slideRegions(scene: DeckLayout['scenes'][number], spec: DeckSpec): EditableRegion[] | undefined {
  const slide = spec.slides.find((s) => s.id === scene.id);
  if (!slide) return undefined;
  const key = createHash('sha256').update(`${DECK_ENGINE_VERSION}|`).update(JSON.stringify(scene)).update('|')
    .update(JSON.stringify(slide)).update(scene.index === 0 ? `|${spec.subtitle ?? ''}` : '').digest('hex');
  const hit = previewRegionCache.get(key);
  if (hit) return hit;
  const regions = editableRegions(scene, { slide, spec }).map((r) => ({ ...r, box: { x: tenth(r.box.x), y: tenth(r.box.y), w: tenth(r.box.w), h: tenth(r.box.h) } }));
  previewRegionCache.set(key, regions);
  return regions;
}

/**
 * One slide image per slide (Sources last) and the warnings, for a validated
 * spec. Each slide's `svg` wraps a PNG painted with the bundled fonts (the
 * default); `vector` returns the engine's pure SVG for anything that needs
 * vectors. Painted slides are cached by their content, never the whole preview.
 */
export function renderPreview(spec: DeckSpec, theme: DeckThemeSpec, mode: 'png' | 'vector' = 'png'): DeckPreviewRender {
  const layout = layoutSpec(spec, theme);
  const svgs = mode === 'vector' ? paintSvg(layout) : layout.scenes.map((scene) => rasterPreviewSlide(scene, layout.stage));
  return {
    slides: layout.scenes.map((scene, i) => {
      const regions = slideRegions(scene, spec);
      return { id: scene.id, svg: svgs[i]!, title: scene.title, ...(regions ? { regions } : {}) };
    }),
    warnings: [...deckWarnings(spec), ...layout.findings.map((f) => findingWarning(f, layout))],
    findings: layout.findings,
  };
}

// ─── Files ───────────────────────────────────────────────────────────────────

export interface RenderedDeckFile { bytes: Buffer; contentType: string; extension: string }

const FILE_SHAPE: Record<DeckFileFormat, { contentType: string; extension: string }> = {
  pptx: { contentType: PPTX_SCENE_CONTENT_TYPE, extension: '.pptx' },
  pdf: { contentType: PDF_CONTENT_TYPE, extension: '.pdf' },
  png: { contentType: ZIP_CONTENT_TYPE, extension: '-slides.zip' },
};

/** A fixed date inside generated files, so a re-render of a revision gives the same bytes. */
const FILE_DATE = new Date('2000-01-01T00:00:00Z');

async function withinBudget<T>(work: Promise<T>, deadline: number, budgetMs: number): Promise<T> {
  const left = deadline - now();
  if (left <= 0) throw new DeckRenderBudgetError(budgetMs);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeckRenderBudgetError(budgetMs)), left); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

function check(deadline: number, budgetMs: number): void {
  if (now() > deadline) throw new DeckRenderBudgetError(budgetMs);
}

/** Renders one file of a validated spec (no cache). Throws `DeckRenderBudgetError` past the budget. */
export async function renderDeckFile(
  spec: DeckSpec, theme: DeckThemeSpec, format: DeckFileFormat, budgetMs: number = DECK_RENDER_BUDGET_MS,
): Promise<RenderedDeckFile> {
  const deadline = now() + budgetMs;
  renderStats.files += 1;
  const layout = layoutSpec(spec, theme);
  check(deadline, budgetMs);
  const { files } = deckFonts();
  let bytes: Buffer;
  if (format === 'pptx') {
    bytes = await withinBudget(paintPptx(layout, { title: spec.title, ...(spec.subtitle ? { subject: spec.subtitle } : {}) }), deadline, budgetMs);
  } else if (format === 'pdf') {
    bytes = await withinBudget(paintPdf(layout, { fonts: files, title: spec.title, ...(spec.subtitle ? { subject: spec.subtitle } : {}), creationDate: FILE_DATE }), deadline, budgetMs);
  } else {
    const zip = new JSZip();
    for (const scene of layout.scenes) {
      check(deadline, budgetMs);
      const name = `slide-${String(scene.index + 1).padStart(2, '0')}.png`;
      zip.file(name, paintPng(scene, { fonts: files, width: DECK_PNG_WIDTH, stage: layout.stage }), { date: FILE_DATE });
    }
    check(deadline, budgetMs);
    // PNG is already compressed; STORE keeps the zip fast to build.
    bytes = await withinBudget(zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), deadline, budgetMs);
  }
  check(deadline, budgetMs);
  return { bytes, ...FILE_SHAPE[format] };
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/** A stable hash of a resolved theme (key order normalised). */
export function themeHash(theme: DeckThemeSpec): string {
  const stable = (v: unknown): unknown => Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
      : v;
  return createHash('sha256').update(JSON.stringify(stable(theme))).digest('hex').slice(0, 16);
}

export const renderCache = new ByteLru<RenderedDeckFile>(DECK_RENDER_CACHE_BYTES, (f) => f.bytes.length);

/** The file of one stored (immutable) revision, from the cache when it was rendered before. */
export async function renderRevisionBytes(
  revisionId: string, spec: DeckSpec, theme: DeckThemeSpec, format: DeckFileFormat,
): Promise<RenderedDeckFile> {
  const key = `${revisionId}|${format}|${DECK_ENGINE_VERSION}|${themeHash(theme)}`;
  const hit = renderCache.get(key);
  if (hit) return hit;
  const file = await renderDeckFile(spec, theme, format);
  renderCache.set(key, file);
  return file;
}
