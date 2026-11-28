// What the deck editor tells the voice is open (lib/voice/pageContext.ts): the deck as the record in view
// (`deck:<id>`), its slides as the page's rows (`slide:<id>`, the layout as the row's status, capped as the
// helper caps rows), and the deck facts the voice's deck operations resolve against: the tenant, the saved head,
// the slide in view, unsaved edits. Free of runtime imports so `node --test` loads it.

import type { PublishedPage } from '../../lib/voice/pageContext.ts';
import type { DeckSpec, DeckTenantId } from './deckApi.ts';

/** `?tab=` values the editor publishes as its tabs: `layouts` shows the example layouts in place of the stage. */
export const DECK_LAYOUTS_TAB = 'layouts';
export const DECK_TABS: readonly string[] = ['slides', DECK_LAYOUTS_TAB];

/** What the page offers by voice; within PAGE_OFFER_MAX. */
export const DECK_OFFER = 'add or change slides, fill a chart from a report, show example layouts (tab layouts) or templates.';

export interface DeckVoiceInput {
  path: string;
  tenant: DeckTenantId;
  deckId: string;
  title: string;
  spec: DeckSpec;
  headRevisionId: string | null;
  viewedRevisionId: string | null;
  selectedSlideId: string | null;
  dirty: boolean;
  readOnly: boolean;
}

const layoutWords = (layout: string) => layout.replace(/-/g, ' ');

export function deckVoiceContext(i: DeckVoiceInput): PublishedPage {
  const selected = i.spec.slides.findIndex((s) => s.id === i.selectedSlideId);
  return {
    path: i.path,
    record: { ref: `deck:${i.deckId}`, title: i.title },
    rowsLabel: 'slides',
    rows: i.spec.slides.map((s, n) => ({ ref: `slide:${s.id}`, title: s.title?.trim() || `Untitled ${layoutWords(s.layout)} slide ${n + 1}`, status: layoutWords(s.layout) })),
    total: i.spec.slides.length,
    offer: i.readOnly ? null : DECK_OFFER,
    deck: {
      tenant: i.tenant, id: i.deckId, headRevisionId: i.headRevisionId, viewedRevisionId: i.viewedRevisionId,
      selectedSlideId: selected >= 0 ? i.spec.slides[selected]!.id : i.spec.slides[0]?.id ?? null,
      selectedPosition: selected >= 0 ? selected + 1 : 1,
      dirty: i.dirty, readOnly: i.readOnly,
      // ui-components' DeckSpec predates the engine's items; the saved spec carries them on cards and process slides.
      slides: i.spec.slides.map((s) => { const items = (s as { items?: Array<{ title: string; text?: string; icon?: string }> }).items; return { id: s.id, title: s.title ?? '', layout: s.layout, ...(items?.length ? { items } : {}) }; }),
    },
  };
}
