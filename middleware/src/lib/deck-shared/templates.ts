// Deck templates and the layout gallery, served by every deck tenant's router
// (docs/deck-edit-operations.md). The templates are data (template-decks.ts);
// here they are previewed with the caller's tenant theme through the one
// rendering path (render.ts), cached per tenant (a template and a tenant's
// theme are fixed for the life of the process), and turned into the first
// revision of a new deck by the tenant's own create path and authority.

import { validateDeckSpec, type DeckSpec, type SlideLayout } from '@connorhoehn/realtime-modules/deck';
import { slideCapacity, type SlideCapacity } from '@connorhoehn/realtime-modules/deck/layout';
import type { ArtifactRevisionStore } from '../flow-artifacts/index.js';
import { deckFonts, renderPreview, type DeckPreviewRender } from './render.js';
import { exampleSourceSlideIds, SLIDE_LAYOUTS } from './operations.js';
import { summaryOf } from './service.js';
import { resolveDeckTheme, tenantDeckTheme, withDeckStyle, type DeckHostTenant } from './themes.js';
import { DECK_TEMPLATES, type DeckTemplate } from './template-decks.js';
import type { DeckRevisionSummary, Result } from './types.js';

export { DECK_TEMPLATES, type DeckTemplate } from './template-decks.js';

/** What each layout is for, one line, for the editor's layout gallery. */
export const LAYOUT_USE_FOR: Readonly<Record<SlideLayout, string>> = {
  title: 'The opening slide: the deck title and a short line above it.',
  section: 'A divider that names the next part of the talk.',
  bullets: 'A few short points, one idea each.',
  'two-column': 'One list split into two columns, with no column headings (use comparison for two titled sides).',
  chart: 'Numbers over categories or time: bar, line, stacked bar or pie.',
  quote: 'Someone\'s words, attributed.',
  image: 'A picture with its caption (described by alt text until assets exist).',
  'key-figures': 'Two to four big numbers with their labels and changes.',
  table: 'A small grid of short text: up to 5 columns and 8 rows.',
  comparison: 'Two options with their points, and the line that settles it.',
  timeline: 'Three to six dated steps in order.',
  agenda: 'The numbered parts of the talk, with the current one marked.',
  closing: 'The last word: a closing line, up to three next steps, a contact.',
  'big-quote': 'One quote, large, as the whole slide.',
  process: 'Three to five steps in order, each with a short line and an icon.',
  cards: 'Three or four ideas side by side, each with an icon and a sentence.',
  matrix: 'Four quadrants on two axes, such as effort against value.',
  'big-number': 'One number, very large, with what it is measured against and up to three lines of story.',
  'image-text': 'A picture beside its words (shows a placeholder until pictures can be uploaded).',
  'image-full': 'A picture across the whole slide with words over it (placeholder until pictures can be uploaded).',
  people: 'Two to eight people with their roles.',
  funnel: 'Three to five stages that narrow, each with its count.',
  kpi: 'Headline figures above the chart that explains them.',
};

const PREVIEW_SLIDES_IN_LIST = 3;

/** A template laid out under `tenant`'s theme, rendered once per process. */
const previews = new Map<string, DeckPreviewRender>();
export const templatePreviewStats = { renders: 0 };

/** A template in the tenant's brand, composed in the template's own style. */
function themed(template: DeckTemplate, tenant: DeckHostTenant): DeckSpec {
  return { ...structuredClone(template.spec), theme: withDeckStyle({ ref: tenant }, template.style, tenant) };
}

function previewOf(template: DeckTemplate, tenant: DeckHostTenant): DeckPreviewRender {
  const key = `${tenant}:${template.id}`;
  let hit = previews.get(key);
  if (!hit) {
    templatePreviewStats.renders += 1;
    const spec = themed(template, tenant);
    hit = renderPreview(spec, resolveDeckTheme(spec.theme, tenant));
    previews.set(key, hit);
  }
  return hit;
}

const meta = (t: DeckTemplate) => ({ id: t.id, title: t.title, description: t.description, audience: t.audience, style: t.style, slideCount: t.spec.slides.length });

/** Every template's metadata and its first three slides' preview SVGs, in the tenant's theme. */
export function listTemplates(tenant: DeckHostTenant) {
  return {
    templates: DECK_TEMPLATES.map((t) => ({
      ...meta(t),
      layouts: t.spec.slides.map((s) => s.layout),
      preview: previewOf(t, tenant).slides.slice(0, PREVIEW_SLIDES_IN_LIST).map((s) => ({ id: s.id, title: s.title, svg: s.svg })),
    })),
  };
}

/** One template: its metadata, its full deck and every slide's preview (Sources last); null when unknown. */
export function readTemplate(tenant: DeckHostTenant, templateId: string) {
  const t = DECK_TEMPLATES.find((x) => x.id === templateId);
  if (!t) return null;
  const preview = previewOf(t, tenant);
  return { ...meta(t), spec: themed(t, tenant), preview: { slides: preview.slides, warnings: preview.warnings, findings: preview.findings } };
}

const capacities = new Map<string, SlideCapacity>();

/** Every layout the engine knows: what it is for, what fits under the tenant's theme, and an example from the templates. */
export function listLayouts(tenant: DeckHostTenant) {
  const theme = tenantDeckTheme(tenant);
  return {
    layouts: SLIDE_LAYOUTS.map((layout) => {
      const key = `${tenant}:${layout}`;
      let capacity = capacities.get(key);
      if (!capacity) { capacity = slideCapacity(layout, theme, deckFonts().metrics); capacities.set(key, capacity); }
      const from = DECK_TEMPLATES.find((t) => t.spec.slides.some((s) => s.layout === layout));
      const slide = from?.spec.slides.find((s) => s.layout === layout);
      const svg = from && slide ? previewOf(from, tenant).slides.find((s) => s.id === slide.id)?.svg : undefined;
      return {
        layout, useFor: LAYOUT_USE_FOR[layout], capacity: capacity.regions,
        example: from && slide && svg ? { templateId: from.id, slideId: slide.id, svg } : null,
      };
    }),
  };
}

/** A new deck's first revision from a template: the caller's title, the tenant's theme reference. */
export function templateDeckSpec(body: { templateId?: unknown; title?: unknown }, tenant: DeckHostTenant): Result<{ template: DeckTemplate; spec: DeckSpec }> {
  const template = DECK_TEMPLATES.find((t) => t.id === body.templateId);
  if (!template) return { ok: false, status: 400, reason: `templateId must be one of ${DECK_TEMPLATES.map((t) => t.id).join(', ')}` };
  if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120)) {
    return { ok: false, status: 400, reason: 'title must be a non-empty string of at most 120 characters' };
  }
  const spec = themed(template, tenant);
  if (typeof body.title === 'string') spec.title = body.title.trim();
  const valid = validateDeckSpec(spec);
  if (!valid.ok) return { ok: false, status: 400, reason: 'the template deck is not valid', details: { errors: valid.errors } };
  return { ok: true, value: { template, spec: valid.spec } };
}

export interface TemplateDeckOut {
  deckId: string;
  revisionId: string;
  revision: DeckRevisionSummary;
  templateId: string;
  /** Slides still citing only the template's example source: every slide, at first. */
  exampleSourceSlideIds: string[];
}

/**
 * Writes revision 1 of a deck whose row the tenant has just inserted. The
 * revision is produced by `template:<id>`; its summary says which template.
 */
export async function appendTemplateRevision(
  revisions: ArtifactRevisionStore<DeckSpec>, deckId: string, made: { template: DeckTemplate; spec: DeckSpec }, sub: string | null,
): Promise<Result<TemplateDeckOut>> {
  const appended = await revisions.append({
    id: revisions.newRevisionId(), deckId, baseRevisionId: null, label: `From the ${made.template.title} template`,
    spec: made.spec, lockedSlideIds: [], producedBy: `template:${made.template.id}`, createdBy: sub,
    summary: `Created from the ${made.template.title} template; every slide cites the template's example source until it is replaced.`,
  });
  if (!appended.ok) return { ok: false, status: 409, reason: 'the deck changed while it was created' };
  return {
    ok: true,
    value: { deckId, revisionId: appended.revision.id, revision: summaryOf(appended.revision), templateId: made.template.id, exampleSourceSlideIds: exampleSourceSlideIds(made.spec) },
  };
}
