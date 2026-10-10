jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
import { selectMockResponse } from '../responses.js';
import type { PresentationQuestionContext } from '../../lib/presentation-context.js';
import '../work-items.js';
const context: PresentationQuestionContext = { kind: 'initiative-deck', deckId: 'idk-one', revisionId: 'irev-seven', title: 'Observability review',
  scope: 'slide', slideId: 'sprints', provenance: 'saved-revision', href: '/iq/decks/idk-one', content: { title: 'Review', slides: [
    { id: 'sprints', layout: 'chart', title: 'Sprints', chart: { kind: 'bar', labels: ['Sprint 98', 'Sprint 99'], series: [{ name: 'Delivered', values: [18, 5] }] },
      notes: 'Verify span metrics.', sources: [{ title: 'Sprint ledger', documentId: 'initiative:p-observability' }] },
  ] } };
it('summarizes the selected Sprints content ahead of generic Observability keyword matching', () => {
  const result = selectMockResponse('Observability — Summarize this slide', { presentationQuestion: context });
  expect(result.response).toContain('Offline presentation preview'); expect(result.response).toContain('Sprints');
  expect(result.response).toContain('Sprint 98'); expect(result.response).toContain('Delivered: 18 · 5');
  expect(result.response).toContain('Verify span metrics.'); expect(result.response).toContain('Sprint ledger');
  expect(result.response).toContain('version `irev-seven`'); expect(result.response).not.toContain('ORG-OBS-');
  expect(result.response).toContain('No language model, initiative lookup, or source-document retrieval ran');
  expect(result.toolCalls).toEqual([]);
});
it('supports native two-column content and visible draft truthfully without fabricated inference', () => {
  const draft = structuredClone(context); draft.provenance = 'visible-draft';
  draft.content.slides = [{ id: 'next', title: 'Next discussion', layout: 'two-column', columns: [['Check alert parity'], ['Keep rollback ready']], sources: [] }];
  const out = selectMockResponse('Observability', { presentationQuestion: draft });
  expect(out.response).toContain('Check alert parity'); expect(out.response).toContain('Keep rollback ready');
  expect(out.response).toContain('visible unsaved draft'); expect(out.toolCalls).toEqual([]);
});
it('keeps existing initiative questions compatible when there is no presentation context', () => {
  expect(selectMockResponse('Find the dependency issue in Observability Platform').response).toContain('ORG-OBS-11');
});
