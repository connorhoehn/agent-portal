jest.mock('../../config.js', () => ({ config: { mock: { aurora: false, agentcore: false } } }));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../providers/assessment-aurora.js', () => ({ claimAssessmentRun: jest.fn(), expireAssessmentClaims: jest.fn() }));
jest.mock('../../providers/assessment.js', () => ({ completeRun: jest.fn() }));
import { agentcore } from '../../providers/index.js';
import { completeRun } from '../../providers/assessment.js';
import { executeClaim, scoreResult } from '../assessment-dispatcher.js';
import type * as M from '../../mock/assessment.js';
const invoke = agentcore.invokeAgent as jest.Mock;
const complete = completeRun as jest.Mock;
const run = { id: 'run-test', command: 'score-dimensions', team_id: 'TEAM-001' } as M.MockRun;
const claim = { run, dispatch: { agentId: 'orgiq-assessment-scorer', payload: {
  auth: { tenant: 'assessment', sub: 'u-asha' }, evidence: [{ id: 'e1', text: 'CI tests run' }],
} } };
beforeEach(() => { jest.clearAllMocks(); complete.mockResolvedValue({ ok: true }); });
const score = { dimension_id: '1', current_level: 2, confidence: 'moderate', rationale: 'CI evidence',
  evidence_excerpts: ['CI tests run'], follow_up_questions: [], evidence_class: 'documented', self_claimed_level: null };
it('dispatches trusted structured input and completes via deterministic scoring seam', async () => {
  invoke.mockResolvedValue({ text: JSON.stringify({ scores: [score] }), raw: {} });
  await executeClaim(claim);
  expect(invoke).toHaveBeenCalledWith('orgiq-assessment-scorer', expect.objectContaining({
    timeoutMs: 900000, structuredInput: { ...claim.dispatch.payload, run_id: run.id },
  }));
  expect(complete).toHaveBeenCalledWith(run.id, expect.objectContaining({ status: 'completed',
    scoring_log: [expect.objectContaining({ dimension_id: '1', suggested_level: 2 })] }));
});
it.each([
  { text: '', raw: { error: 'forbidden' } },
  { text: 'not JSON', raw: {} },
  { text: '{"scores":[]}', raw: {} },
])('records failed output instead of leaving a running row or claiming completion', async result => {
  invoke.mockResolvedValue(result);
  await executeClaim(claim);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledWith(run.id, expect.objectContaining({ status: 'failed' }));
});
it('transport failure becomes a terminal ledger failure', async () => {
  invoke.mockRejectedValue(new Error('Runtime not found'));
  await executeClaim(claim);
  expect(complete).toHaveBeenCalledWith(run.id, { status: 'failed', error: 'Runtime not found' });
});
it('rejects model output with unsupported level before score application', () => {
  expect(() => scoreResult(JSON.stringify({ scores: [{ ...score, current_level: 99 }] }))).toThrow('invalid');
});

it('rejects a valid rubric dimension outside the persisted submission input', () => {
  expect(() => scoreResult(JSON.stringify({ scores: [score] }), ['10'])).toThrow('out-of-scope');
});
