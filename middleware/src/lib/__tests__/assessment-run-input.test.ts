import { assessmentRunInput } from '../assessment-run-input.js';
import type * as M from '../../mock/assessment.js';
const submission = { envelope_id: 's1', dimension_hints: [{ dimension_id: '10', self_level: 3 }] } as unknown as M.SubmissionEnvelope;
it('pins survey evidence and relevant dimensions to the chosen submission', () => {
  const run = assessmentRunInput('process-self-assessment', { submission: 's1' }, 'TEAM-001', [], submission, []);
  expect(run.agentId).toBe('orgiq-assessment-scorer');
  expect(run.payload).toMatchObject({ mode: 'survey', relevant_dimension_ids: ['10'],
    evidence: [{ id: 's1', source_type: 'survey', text: JSON.stringify(submission.dimension_hints) }] });
});
it('requires explicit submission instead of scoring unrelated evidence as a survey', () => {
  expect(() => assessmentRunInput('process-self-assessment', {}, 'TEAM-001', [], undefined, [])).toThrow('Choose a committed submission');
});
it.each(['validate-outputs', 'draft-confluence-page', 'suggest-confluence-content', 'draw-diagram'])(
  '%s reaches its own supported drafter mode with source content', command => {
    expect(assessmentRunInput(command, { document: { text: 'Source' } }, 'TEAM-001', [], undefined, [])).toMatchObject({
      agentId: 'orgiq-assessment-drafter', payload: { mode: command, document: { text: 'Source' } },
    });
  });
it('classifies the supplied transcript without inventing saved evidence', () => {
  const run = assessmentRunInput('classify-transcript', { document: { text: 'CI runs per merge.' } }, 'TEAM-001', [], undefined, []);
  expect(run.payload['evidence']).toEqual([{ id: 'source-document', text: 'CI runs per merge.', source_type: 'transcript' }]);
});
it('rejects missing source rather than enqueuing a guaranteed agent failure', () => {
  expect(() => assessmentRunInput('draw-diagram', {}, 'TEAM-001', [], undefined, [])).toThrow('requires document.text');
});
