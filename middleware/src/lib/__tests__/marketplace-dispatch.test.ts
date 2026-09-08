// Marketplace dispatch refusal matrix — which work items may become governed
// runs, and against which codebase. The decision is pure so every refusal
// (wrong type, terminal status, no codebase, ambiguous codebase) is pinned
// here without a database; dispatchWorkItem just executes what it decides.

// The functions under test are pure; the mocks only keep the module loadable —
// config.ts uses import.meta, which the CJS test transform cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { decideDispatch, renderWorkItemPrompt, type DispatchCandidate } from '../bot-runner.js';
import type { WorkItem } from '../../providers/work-items.js';

type Dispatchable = Pick<WorkItem, 'type' | 'status'>;

function item(over: Partial<Dispatchable> = {}): Dispatchable {
  return { type: 'story', status: 'open', ...over };
}

const repoA: DispatchCandidate = { id: 'ap-a', repoFullName: 'org/alpha' };
const repoB: DispatchCandidate = { id: 'ap-b', repoFullName: 'org/beta' };

describe('decideDispatch', () => {
  it('dispatches an open story with exactly one codebase', () => {
    expect(decideDispatch(item(), [repoA])).toEqual({ kind: 'proceed', agentProjectId: 'ap-a' });
  });

  it('dispatches a bug too — bugs are the other dispatchable unit', () => {
    expect(decideDispatch(item({ type: 'bug' }), [repoA])).toMatchObject({ kind: 'proceed' });
  });

  it('re-dispatches an in_progress item (retry after a failed run)', () => {
    expect(decideDispatch(item({ status: 'in_progress' }), [repoA])).toMatchObject({ kind: 'proceed' });
  });

  it('refuses an epic with a 400 — epics roll up, they do not run', () => {
    expect(decideDispatch(item({ type: 'epic' }), [repoA])).toMatchObject({ kind: 'error', status: 400 });
  });

  it.each(['done', 'cancelled', 'in_review'] as const)('refuses a %s item with a 400', (status) => {
    expect(decideDispatch(item({ status }), [repoA])).toMatchObject({
      kind: 'error', status: 400, error: expect.stringContaining(status) as string,
    });
  });

  it('refuses with no codebase, pointing the operator at Codebases', () => {
    expect(decideDispatch(item(), [])).toMatchObject({
      kind: 'error', status: 400, error: expect.stringMatching(/link one in Codebases/) as string,
    });
  });

  // /admin/projects (Codebases) is an hr-admin-only page (sme.md defect #3):
  // telling every other role to "link one in Codebases" sends them at a page
  // that redirects them away. callerRole steers the wording; omitted or
  // hr-admin keeps the actionable original.
  it('keeps the actionable message when the caller is hr-admin, or the role is unknown', () => {
    expect(decideDispatch(item(), [], undefined, 'hr-admin')).toMatchObject({
      error: expect.stringMatching(/link one in Codebases/) as string,
    });
    expect(decideDispatch(item(), [], undefined, null)).toMatchObject({
      error: expect.stringMatching(/link one in Codebases/) as string,
    });
  });

  it('points every other role at a human instead of a page they cannot open', () => {
    for (const role of ['sme', 'org-leader', 'program-owner', 'member']) {
      expect(decideDispatch(item(), [], undefined, role)).toMatchObject({
        kind: 'error', status: 400,
        error: 'no codebase delivers this initiative — ask a program owner to link a codebase in Codebases',
      });
    }
  });

  it('checks the item shape before codebase resolution — an epic with zero codebases is an epic problem', () => {
    expect(decideDispatch(item({ type: 'epic' }), [])).toMatchObject({
      kind: 'error', error: expect.stringMatching(/epics/) as string,
    });
  });

  it('409s on ambiguity, carrying the options to choose from', () => {
    expect(decideDispatch(item(), [repoA, repoB])).toEqual({
      kind: 'error', status: 409,
      error: expect.stringMatching(/multiple codebases/) as string,
      options: [repoA, repoB],
    });
  });

  it('an explicit agentProjectId resolves the ambiguity', () => {
    expect(decideDispatch(item(), [repoA, repoB], 'ap-b')).toEqual({ kind: 'proceed', agentProjectId: 'ap-b' });
  });

  it('rejects an agentProjectId that does not deliver this initiative', () => {
    expect(decideDispatch(item(), [repoA], 'ap-elsewhere')).toMatchObject({ kind: 'error', status: 400 });
  });
});

describe('renderWorkItemPrompt', () => {
  const wi = {
    id: 'wi-1', type: 'story' as const, title: 'Fix the login flow',
    description: 'The redirect loops on expired sessions.',
    labels: ['auth', 'bug'], storyPoints: 5,
  };

  it('renders preamble, title, description, labels and the governance line', () => {
    const p = renderWorkItemPrompt(wi);
    expect(p).toContain('Work item wi-1 (story, 5 pts)');
    expect(p).toContain('Fix the login flow');
    expect(p).toContain('The redirect loops on expired sessions.');
    expect(p).toContain('Labels: auth, bug');
    // The pipeline contract, not the old "commit your work" line: capture
    // diffs the working tree, so the agent must NOT commit.
    expect(p).toContain('do not run git commit');
    expect(p).toContain('UNCOMMITTED');
  });

  it('omits the pts suffix, description and labels when absent', () => {
    const p = renderWorkItemPrompt({ ...wi, description: null, labels: [], storyPoints: null });
    expect(p).toContain('Work item wi-1 (story)');
    expect(p).not.toContain('pts');
    expect(p).not.toContain('Labels:');
  });

  it('appends the one-shot instruction before the governance line', () => {
    const p = renderWorkItemPrompt(wi, 'touch only auth/');
    expect(p.indexOf('For this run specifically: touch only auth/'))
      .toBeLessThan(p.indexOf('UNCOMMITTED'));
  });
});
