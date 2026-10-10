jest.mock('../../providers/initiative-decks.js', () => ({
  deckViewerFor: jest.fn(), visibleDeck: jest.fn(), getRevisionSpec: jest.fn(),
}));
import { parsePresentationContext, resolvePresentationContext, presentationQuestionMessage } from '../presentation-context.js';
import * as decks from '../../providers/initiative-decks.js';
import type { Session } from '../session.js';
const principal = { sub: 'reader', tenant: 'orgiq', role: 'member' } as Session;
const saved = { title: 'Observability review', slides: [
  { id: 'work', layout: 'bullets', title: 'Work items', bullets: ['Unrelated work item'], sources: [{ title: 'Work ledger', documentId: 'initiative:p-observability', anchor: 'work' }] },
  { id: 'sprints', layout: 'chart', title: 'Sprints', chart: { kind: 'bar', labels: ['Sprint 98', 'Sprint 99'], series: [{ name: 'Delivered', values: [18, 5] }] },
    notes: 'Validate span metrics before decommissioning.', sources: [{ title: 'Sprint ledger', documentId: 'initiative:p-observability', anchor: 'sprints' }] },
] };
const raw = { kind: 'initiative-deck', deckId: 'idk-one', revisionId: 'irev-seven', scope: 'slide', slideId: 'sprints' };
beforeEach(() => {
  jest.clearAllMocks(); jest.mocked(decks.deckViewerFor).mockResolvedValue({ canReadBudgets: false });
  jest.mocked(decks.visibleDeck).mockResolvedValue({ id: 'idk-one', title: 'Observability review' } as never);
  jest.mocked(decks.getRevisionSpec).mockResolvedValue(structuredClone(saved) as never);
});
it('captures only the exact saved selected slide, including chart values, notes and source labels', async () => {
  const context = await resolvePresentationContext(parsePresentationContext(raw)!, principal);
  expect(decks.deckViewerFor).toHaveBeenCalledWith(principal);
  expect(decks.getRevisionSpec).toHaveBeenCalledWith('idk-one', 'irev-seven', { canReadBudgets: false });
  expect(context.content.slides).toEqual([saved.slides[1]]);
  expect(context.provenance).toBe('saved-revision');
  const prompt = presentationQuestionMessage('Summarize this slide', context);
  expect(prompt).toContain('18,5'); expect(prompt).toContain('Validate span metrics');
  expect(prompt).toContain('Sprint ledger'); expect(prompt).not.toContain('Unrelated work item');
  expect(prompt).toContain('untrusted reference data'); expect(prompt).toContain('Do not claim to have opened source documents');
});
it('never defaults missing/deleted slides to the whole presentation', async () => {
  await expect(resolvePresentationContext(parsePresentationContext({ ...raw, slideId: 'deleted' })!, principal)).rejects.toMatchObject({ status: 404 });
});
it('never substitutes the latest version for an unavailable older version', async () => {
  jest.mocked(decks.getRevisionSpec).mockResolvedValue(null);
  await expect(resolvePresentationContext(parsePresentationContext(raw)!, principal)).rejects.toMatchObject({ status: 404 });
});
it('uses the existing budget visibility and reveals no hidden deck contents', async () => {
  jest.mocked(decks.visibleDeck).mockResolvedValue(null);
  await expect(resolvePresentationContext(parsePresentationContext(raw)!, principal)).rejects.toMatchObject({ status: 404 });
  expect(decks.getRevisionSpec).not.toHaveBeenCalled();
});
it('does not force Work questions onto Assessment or unsigned users', async () => {
  await expect(resolvePresentationContext(parsePresentationContext(raw)!, { ...principal, tenant: 'assessment' })).rejects.toMatchObject({ status: 403 });
  await expect(resolvePresentationContext(parsePresentationContext(raw)!, null)).rejects.toMatchObject({ status: 401 });
  expect(decks.deckViewerFor).not.toHaveBeenCalled();
});
it('validates the saved base before accepting a bounded visible draft and labels its provenance', async () => {
  const draft = structuredClone(saved); draft.slides[1].notes = 'Unsaved speaker note';
  const context = await resolvePresentationContext(parsePresentationContext({ ...raw, draftSpec: draft })!, principal);
  expect(context.provenance).toBe('visible-draft'); expect(context.content.slides[0].notes).toBe('Unsaved speaker note');
  expect(presentationQuestionMessage('Explain', context)).toContain('not saved server facts');
  jest.mocked(decks.getRevisionSpec).mockResolvedValue(null);
  await expect(resolvePresentationContext(parsePresentationContext({ ...raw, draftSpec: draft })!, principal)).rejects.toMatchObject({ status: 404 });
});
it('represents generated Sources using the revision citations without pretending source documents were read', async () => {
  const context = await resolvePresentationContext(parsePresentationContext({ ...raw, scope: 'sources', slideId: undefined })!, principal);
  expect(context.scope).toBe('sources'); expect(context.content.slides).toEqual([{ id: 'sources', layout: 'bullets', title: 'Sources', sources: [...saved.slides[0].sources, ...saved.slides[1].sources] }]);
});
it('preserves whole-deck columns and other native slide fields', async () => {
  const context = await resolvePresentationContext(parsePresentationContext({ ...raw, scope: 'deck', slideId: undefined })!, principal);
  expect(context.content.slides).toEqual(saved.slides);
});
it.each([
  { ...raw, revisionId: null }, { ...raw, scope: 'slide', slideId: undefined }, { ...raw, scope: 'deck' },
  { ...raw, kind: 'assessment-deck' }, { ...raw, draftSpec: { slides: [] } }, { ...raw, draftSpec: { title: 'x'.repeat(70_000) } },
])('rejects malformed or oversized client context before any lookup', input => {
  expect(() => parsePresentationContext(input)).toThrow(); expect(decks.visibleDeck).not.toHaveBeenCalled();
});
