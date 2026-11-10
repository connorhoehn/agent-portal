import { humanizeSlug, presentRunTitles, type RunNames } from '../pipeline-run-titles.js';
import { marketplaceFallbackTitle, projectRuns, type Run } from '../pipeline-runs.js';

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
      run('bot_runs', { title: 'Marketplace work · Coding agent', workItemId: 'wi-1' }),
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

  it('a marketplace dispatch whose work item cannot be found reads "Marketplace work · Coding agent", never its id', () => {
    const [r] = projectRuns({
      agentJobs: [], agentProjectRuns: [], assessmentRuns: [], invocations: [], liveAgentRuns: [], changes: [],
      botRuns: [{ id: 'br-1', botId: null, trigger: 'marketplace', runId: null, jobId: null, workItemId: 'wi-gone', status: 'running', costUsd: null, startedAt: '2026-11-10T00:00:00Z', finishedAt: null, dispatchedBy: null }],
    }).runs;
    presentRunTitles([r!], names);
    expect(r!.context.title).toBe(marketplaceFallbackTitle());
    expect(r!.context.title).toBe('Marketplace work · Coding agent');
    expect(r!.context.title).not.toMatch(/wi-/);
    expect(r!.context.workItemId).toBe('wi-gone');
  });

  it('a bot firing whose bot cannot be named reads "Bot firing", never "bot <uuid>"', () => {
    const [r] = projectRuns({
      agentJobs: [], agentProjectRuns: [], assessmentRuns: [], invocations: [], liveAgentRuns: [], changes: [],
      botRuns: [{ id: 'br-2', botId: '32970d0a-e28e-5100-8fb0-a5cbb87dac99', trigger: 'cron', runId: null, jobId: null, workItemId: null, status: 'done', costUsd: 0.1, startedAt: '2026-11-10T00:00:00Z', finishedAt: '2026-11-10T00:01:00Z', dispatchedBy: null }],
    }).runs;
    presentRunTitles([r!], names);
    expect(r!.context.title).toBe('Bot firing');
    expect(r!.definitionId).toBe('bot:32970d0a-e28e-5100-8fb0-a5cbb87dac99');
  });

  it('leaves a title alone when no name is known: an id beats a guess', () => {
    const r = run('assessment_runs', { title: 'score-dimensions · TEAM-999', definitionId: 'assessment:score-dimensions' });
    presentRunTitles([r], names);
    expect(r.context.title).toBe('score-dimensions · TEAM-999');
  });
});
