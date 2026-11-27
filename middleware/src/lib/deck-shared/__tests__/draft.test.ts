// An unfinished draft previews: a slide just added from the layout gallery (no
// title, blank fields, no source, fields left from another layout) is drawn
// from stand-ins and named in the warnings; what is not a deck is still a 400,
// and nothing here loosens what save accepts.

jest.mock('../../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));

import { validateDeckSpec } from '@connorhoehn/realtime-modules/deck';
import { DRAFT_TITLE, previewableDraft } from '../draft.js';
import { previewSpec } from '../service.js';

const src = [{ title: 'Status note', documentId: 'doc-1' }];
const titleSlide = { id: 'title', layout: 'title', title: 'Quarter review', sources: src };

describe('previewing an unfinished draft', () => {
  it('draws a gallery slide with no title, blank cells and a leftover field, and names it unfinished', () => {
    const raw = {
      title: 'Quarter review',
      slides: [
        titleSlide,
        { id: 's2', layout: 'table', title: '', table: { header: ['Item', ''], rows: [['Cell', '']] }, bullets: [''], timeline: [{ date: '', label: '' }], sources: [] },
      ],
    };
    expect(validateDeckSpec(raw).ok).toBe(false); // save still refuses it
    const draft = previewableDraft(raw)!;
    expect(draft).not.toBeNull();
    const slide = draft.spec.slides[1]!;
    expect(slide.title).toBe(DRAFT_TITLE);
    expect(slide.table?.header).toEqual(['Item', '…']);
    expect(slide.table?.rows[0]).toEqual(['Cell', '…']);
    expect(slide.timeline).toBeUndefined();
    expect(slide.sources[0]!.documentId).toBe('example:unsourced');
    expect(draft.unfinished).toEqual([expect.stringMatching(/^Slide 2 \(s2\) is unfinished: it needs .*a title/)]);
    expect(draft.spec.slides[0]).toEqual(expect.objectContaining({ title: 'Quarter review' }));
  });

  it('a payload that cannot pass even with blanks filled is drawn from the layout starter', () => {
    const draft = previewableDraft({ title: 'T', slides: [{ id: 'a', layout: 'timeline', title: 'Plan', sources: src }] })!;
    expect(draft.spec.slides[0]!.timeline!.length).toBeGreaterThanOrEqual(2);
    expect(draft.unfinished[0]).toMatch(/Slide 1 \(a\) is unfinished/);
  });

  it('the preview route answers 200 for the draft with the unfinished sentence first, and 400 for what is not a deck', () => {
    const out = previewSpec({ title: 'T', slides: [titleSlide, { id: 'b', layout: 'bullets', title: 'Points', bullets: ['One', ''], sources: src }] }, 'orgiq');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.slides.map((s) => s.id)).toEqual(['title', 'b', 'sources']);
    expect(out.value.warnings[0]).toMatch(/^Slide 2 \(b\) is unfinished: it needs its blank fields\./);
    expect(previewSpec({ title: '', slides: [] }, 'orgiq').ok).toBe(false);
    expect(previewSpec({ title: 'T', slides: [{ id: 'x', layout: 'no-such', title: 'X', sources: src }] }, 'orgiq').ok).toBe(false);
  });

  it('a valid spec previews as before, with no unfinished sentence', () => {
    const out = previewSpec({ title: 'T', slides: [titleSlide] }, 'orgiq');
    expect(out.ok && out.value.warnings.some((w) => /unfinished/.test(w))).toBe(false);
  });
});
