jest.mock('../../config.js', () => ({ config: { mock: { aurora: false }, auth: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../lib/assessment-broker.js', () => ({ assessmentBroker: { publish: jest.fn() } }));
import { exec, withTransaction } from '../aurora.js';
import { completeRun, stopRun, applyScores } from '../assessment.js';
import { assessmentBroker } from '../../lib/assessment-broker.js';

let state: { status: string; logs: number; scores: number };
let failScore: boolean;
let locks: string[];
let tail: Promise<unknown>;
const run = { id: 'r1', command: 'score-dimensions', team_id: 'TEAM-002', args: '{}', source: 'agent',
  started_at: '2026-09-19T10:00:00Z', finished_at: null, summary: '', error: null, files_written: [] };
const score = { dimension_id: '10', is_na: false, suggested_level: 2, confidence: 'moderate' as const,
  rationale: 'A real evidence quote', evidence_excerpts: [], follow_up_questions: [],
  na_claimed: false, self_claimed_level: null, evidence_class: 'documented' as const, cap_applied: false };
beforeEach(() => {
  jest.clearAllMocks(); locks = []; state = { status: 'running', logs: 0, scores: 0 }; failScore = false; tail = Promise.resolve();
  (exec as jest.Mock).mockImplementation(() => { throw new Error('Escaped transaction'); });
  (withTransaction as jest.Mock).mockImplementation(work => {
    const result = tail.then(async () => {
      const draft = { ...state };
      let busy = false;
      const query = async (sql: string, params: any[] = []) => {
        if (busy) throw new Error('Concurrent Data API transaction call');
        busy = true;
        await new Promise(resolve => setImmediate(resolve));
        busy = false;
        if (sql.endsWith('FOR UPDATE')) { locks.push(sql); return [{ id: 'r1' }]; }
        if (sql.includes('FROM assessment_runs')) return [{ ...run, status: draft.status }];
        if (sql.includes('FROM assessment_teams')) return [{ id: 'TEAM-002', name: 'T', cohort: 'general', contacts: [], repos: '[]', contributors: '[]' }];
        if (sql.includes('INSERT INTO assessment_scoring_logs')) {
          expect(locks).toContain('SELECT id FROM assessment_teams WHERE id = :id FOR UPDATE');
          draft.logs++; return [];
        }
        if (sql.includes('INSERT INTO assessment_dimension_scores')) {
          if (failScore) throw new Error('score persistence failed');
          draft.scores++; return [];
        }
        if (sql.includes('UPDATE assessment_runs SET status')) {
          draft.status = params.find(p => p.name === 'status').value.stringValue;
        }
        return [];
      };
      const value = await work(query);
      state = draft; // commit only once work finishes; throw leaves original intact
      return value;
    });
    tail = result.catch(() => undefined);
    return result;
  });
});
it('serializes duplicate callbacks: one score/log and one terminal event', async () => {
  const results = await Promise.all([1, 2].map(() => completeRun('r1', { status: 'completed', scoring_log: [score] })));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok)).toEqual([{ ok: false, status: 409, reason: 'run is already completed' }]);
  expect(state).toEqual({ status: 'completed', logs: 1, scores: 1 });
  expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
  expect(exec).not.toHaveBeenCalled();
});
it('rolls scoring log back when applying the score fails and emits no terminal event', async () => {
  failScore = true;
  await expect(completeRun('r1', { status: 'completed', scoring_log: [score] })).rejects.toThrow('score persistence failed');
  expect(state).toEqual({ status: 'running', logs: 0, scores: 0 });
  expect(assessmentBroker.publish).not.toHaveBeenCalled();
});
it('a stop that wins the lock prevents a later completion from applying scores', async () => {
  const [stopped, completed] = await Promise.all([stopRun('r1'), completeRun('r1', { status: 'completed', scoring_log: [score] })]);
  expect(stopped.ok).toBe(true);
  expect(completed.ok).toBe(false);
  expect(state).toEqual({ status: 'failed', logs: 0, scores: 0 });
});

it('human score application locks the same team as agent completion', async () => {
  await applyScores('TEAM-002', { relevant_dimension_ids: ['10'], scores: [{ dimension_id: '10',
    suggested_level: 2, confidence: 'moderate', rationale: 'Pipeline document', evidence_class: 'documented' }] });
  expect(locks).toContain('SELECT id FROM assessment_teams WHERE id = :id FOR UPDATE');
  expect(state.scores).toBe(1);
  expect(exec).not.toHaveBeenCalled();
});
