// The four WRITE paths on providers/agent-projects.ts that had no mock branch.
//
// `POST /api/agent-projects`, `DELETE /:id`, the run insert and the run update
// all called `exec()` raw, and `exec` reaches the RDS Data API whatever
// `config.mock.aurora` says — so offline a repository could not be linked,
// unlinked, or run against, and every one of those 500s was invisible to the
// judge because rule 4's evidence is a GET-only wire capture.
//
// These tests go through the PROVIDER, not the fixture, because the provider
// is where the missing branch was. What they assert is the floor's own
// contract, not merely that a row appears:
//
//   1. The mock honours the statement it stands in for — `ON CONFLICT
//      (repo_full_name) DO UPDATE` updates in place rather than adding a row.
//   2. Nothing derivable is stored: a run carries two stamps and `durationMs`
//      falls out of them, exactly as Aurora's `finishRun` computes it.
//   3. Timestamps are sampled at write time, so freezing the clock moves them.
//   4. A write is undone by the scenario control plane, not by a restart.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));

import { freezeClock } from '../core/index.js';
import { agentProjects } from '../agent-projects.js';
import { agentProjectRuns } from '../agent-project-runs.js';
import {
  finishRun, getAgentProject, linkAgentProject, listAgentProjects, listRuns,
  markCloned, startRun, unlinkAgentProject,
} from '../../providers/agent-projects.js';

const OBSERVABILITY = '4870e01d-9274-5c4a-91af-ea9acb7f857a';

beforeEach(() => {
  agentProjects.reset('default');
  agentProjectRuns.reset('default');
});

describe('linking a repository offline', () => {
  it('adds a row that the list and the detail both then show', async () => {
    const before = (await listAgentProjects()).length;
    const created = await linkAgentProject({
      repoFullName: 'connorhoehnslalom/orgiq-scratch', orgProjectId: 'p-soc2',
    });

    expect(created.repoFullName).toBe('connorhoehnslalom/orgiq-scratch');
    expect(created.defaultBranch).toBe('main');
    expect(await listAgentProjects()).toHaveLength(before + 1);
    expect(await getAgentProject(created.id)).toMatchObject({ id: created.id, orgProjectId: 'p-soc2' });
  });

  it('re-linking an existing repo UPDATES it — the conflict target is repo_full_name', async () => {
    const before = await listAgentProjects();
    const again = await linkAgentProject({
      repoFullName: 'connorhoehnslalom/orgiq-observability',
      orgProjectId: 'p-observability', defaultBranch: 'trunk',
    });

    // Same id, same fleet size: `ON CONFLICT (repo_full_name) DO UPDATE`.
    expect(again.id).toBe(OBSERVABILITY);
    expect(again.defaultBranch).toBe('trunk');
    expect(await listAgentProjects()).toHaveLength(before.length);
  });

  it('stamps createdAt from the clock, not from wall time', async () => {
    const restore = freezeClock('2026-03-01T09:00:00.000Z');
    const created = await linkAgentProject({ repoFullName: 'connorhoehnslalom/orgiq-frozen' });
    restore();
    expect(created.createdAt).toBe('2026-03-01T09:00:00.000Z');
  });

  it('lists newest link first, the way ORDER BY created_at DESC does', async () => {
    const list = await listAgentProjects();
    const stamps = list.map((p) => new Date(p.createdAt).getTime());
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });
});

describe('unlinking offline', () => {
  it('removes the row and reports true', async () => {
    expect(await unlinkAgentProject(OBSERVABILITY)).toBe(true);
    expect(await getAgentProject(OBSERVABILITY)).toBeNull();
  });

  it('reports false for a row it does not hold, rather than throwing', async () => {
    expect(await unlinkAgentProject('99999999-9999-4999-8999-999999999999')).toBe(false);
    expect(await unlinkAgentProject('not-a-uuid')).toBe(false);
  });
});

describe('running against a repository offline', () => {
  it('starts a run that is `running`, with a start stamp and no duration', async () => {
    const run = await startRun({ projectId: OBSERVABILITY, prompt: 'Tidy the collector config.' });

    expect(run.status).toBe('running');
    expect(run.finishedAt).toBeNull();
    // A run in flight has no duration. A stored zero would read as "instant".
    expect(run.durationMs).toBeNull();
    expect((await listRuns(OBSERVABILITY, 50)).map((r) => r.id)).toContain(run.id);
  });

  it('derives durationMs from the two stamps, the way Aurora computes it', async () => {
    let restore = freezeClock('2026-03-01T09:00:00.000Z');
    const run = await startRun({ projectId: OBSERVABILITY, prompt: 'Measure me.' });
    restore();

    restore = freezeClock('2026-03-01T09:00:12.500Z');
    await finishRun(run.id, { status: 'done', filesChanged: 2, diffSummary: '2 files changed', costUsd: 0.11 });
    restore();

    const finished = (await listRuns(OBSERVABILITY, 50)).find((r) => r.id === run.id);
    expect(finished).toMatchObject({ status: 'done', filesChanged: 2, costUsd: 0.11 });
    expect(finished?.finishedAt).toBe('2026-03-01T09:00:12.500Z');
    expect(finished?.durationMs).toBe(12_500);
    // Not stored anywhere — the seed row carries the stamps and nothing else.
    expect(agentProjectRuns.rows().find((r) => r.id === run.id)).not.toHaveProperty('durationMs');
  });

  it('records a failure with its error, not as a silent success', async () => {
    const run = await startRun({ projectId: OBSERVABILITY, prompt: 'Break something.' });
    await finishRun(run.id, { status: 'failed', error: 'npm test exited 1' });

    const finished = (await listRuns(OBSERVABILITY, 50)).find((r) => r.id === run.id);
    expect(finished).toMatchObject({ status: 'failed', error: 'npm test exited 1' });
  });

  it('finishing an unknown run touches nothing rather than inventing a row', async () => {
    const before = agentProjectRuns.rows().length;
    await finishRun('00000000-0000-4000-8000-000000000000', { status: 'done' });
    expect(agentProjectRuns.rows()).toHaveLength(before);
  });
});

describe('markCloned', () => {
  it('takes its stamp from the clock — it used to mint `new Date()`', async () => {
    const restore = freezeClock('2026-03-01T09:00:00.000Z');
    await markCloned(OBSERVABILITY, 'session-that-is-long-enough-for-agentcore-0001');
    restore();

    expect(await getAgentProject(OBSERVABILITY)).toMatchObject({
      sessionId: 'session-that-is-long-enough-for-agentcore-0001',
      clonedAt: '2026-03-01T09:00:00.000Z',
    });
  });
});

describe('the control plane undoes a write', () => {
  it('reset() restores the seeded fleet after a link and an unlink', async () => {
    const seeded = (await listAgentProjects()).length;
    await linkAgentProject({ repoFullName: 'connorhoehnslalom/orgiq-scratch' });
    await unlinkAgentProject(OBSERVABILITY);
    expect(await listAgentProjects()).toHaveLength(seeded);

    agentProjects.reset('default');
    const back = await listAgentProjects();
    expect(back).toHaveLength(seeded);
    expect(back.map((p) => p.id)).toContain(OBSERVABILITY);
  });

  it('declares `empty`, so an auditor can see the never-linked state', () => {
    expect(agentProjects.rows('empty')).toEqual([]);
  });
});
