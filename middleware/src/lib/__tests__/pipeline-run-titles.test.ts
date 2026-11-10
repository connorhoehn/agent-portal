import { humanizeSlug, presentRunTitles, type RunNames } from '../pipeline-run-titles.js';
import type { Run } from '../pipeline-runs.js';

const run = (table: Run['context']['table'], over: Partial<Run['context']> & { definitionId?: string } = {}): Run => {
  const { definitionId, ...context } = over;
  return {
    id: `r-${table}`, definitionId: definitionId ?? 'x', tenant: 'orgiq', status: 'completed', triggeredBy: null, triggerType: 'manual',
    startedAt: null, finishedAt: null, costUsd: null,
    context: { tenant: 'orgiq', kind: 'agent', table, id: 'i', sourceStatus: 'done', sources: [], title: 'raw', ...context },
  };
};
const names: RunNames = {
  team: (id) => (id === 'TEAM-003' ? 'Northstar Payments' : null),
  workItem: (id) => (id === 'wi-1' ? { title: 'Logout leaves the shim cookie alive', initiative: 'Auth Migration' } : null),
  bot: (id) => (id === 'b1' ? { name: 'auth-dep-watch', initiative: 'Auth Migration' } : null),
  project: (id) => (id === 'p1' ? 'Observability Platform' : null),
  owner: () => null,
};

describe('humanizeSlug', () => {
  it('reads a slug as a title and spells the words a title spells', () => {
    expect(humanizeSlug('score-dimensions')).toBe('Score dimensions');
    expect(humanizeSlug('develop-jira-story')).toBe('Develop Jira story');
    expect(humanizeSlug('process-self-assessment')).toBe('Process self-assessment');
    expect(humanizeSlug('Already Titled')).toBe('Already Titled');
  });
});

describe('presentRunTitles', () => {
  it('names an assessment run by command and team, a dispatch by its work item, a bot job by the bot', () => {
    const runs = [
      run('assessment_runs', { title: 'score-dimensions · TEAM-003', definitionId: 'assessment:score-dimensions' }),
      run('bot_runs', { title: 'marketplace work wi-1', workItemId: 'wi-1' }),
      run('agent_jobs', { title: 'auth-dep-watch', definitionId: 'bot:b1' }),
      run('agent_project_runs', { title: 'Do a thing.', projectId: 'p1' }),
    ];
    presentRunTitles(runs, names);
    expect(runs.map((r) => r.context.title)).toEqual([
      'Score dimensions · Northstar Payments', 'Dispatched: Logout leaves the shim cookie alive', 'Auth dep watch', 'Do a thing.',
    ]);
    expect(runs.map((r) => r.context.initiativeName ?? null)).toEqual([null, 'Auth Migration', 'Auth Migration', 'Observability Platform']);
  });

  it('names a governed run for a work item by the item, never by the bracketed id in its prompt', () => {
    const r = run('agent_project_runs', { title: 'Work item AUTH-7 [wi-1] (bug, 2 pts)', workItemId: 'wi-1', projectId: 'p1' });
    presentRunTitles([r], names);
    expect(r.context.title).toBe('Logout leaves the shim cookie alive');
  });

  it('leaves a title alone when no name is known: an id beats a guess', () => {
    const r = run('assessment_runs', { title: 'score-dimensions · TEAM-999', definitionId: 'assessment:score-dimensions' });
    presentRunTitles([r], names);
    expect(r.context.title).toBe('score-dimensions · TEAM-999');
  });
});
