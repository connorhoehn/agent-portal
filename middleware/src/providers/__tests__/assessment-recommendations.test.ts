// Provider-level test for the Aurora path of getTeamRecommendations
// (providers/assessment.ts) — this is the "derived recommendation" case
// called for in the task: recommendations are computed from dimension
// scores + follow-ups, never read back as stored rows, on both the mock and
// Aurora paths (see computeTeamPlan, shared by buildTeamPlan and this
// function). Everything below the provider is stubbed: `exec` never talks
// to a real Aurora cluster, and config.mock.aurora is forced to `false` so
// the Aurora branch runs instead of the MOCK_AURORA fixture (see
// assessment-fixes.test.ts for the mirror-image mock-path config).
//
// This file is a separate module from assessment-aurora.test.ts so the
// config.js mock below (needed to reach the Aurora branch of the provider)
// never touches that file's existing tests, which exercise
// providers/assessment-aurora.ts directly and don't import config at all.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import { exec } from '../aurora.js';
import * as provider from '../assessment.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => execMock.mockReset());

const TEAM_ROW = {
  id: 'TEAM-001', name: 'Payments Core', cohort: 'white_glove', status: 'ACTIVE', workflow_step: 3,
  assessment_lead: 'lee@example.com', contacts: [], repos: '[]', contributors: '[]', archetype: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
};

const SCORE_ROW_DIM1 = {
  team_id: 'TEAM-001', dimension_id: '1', current_level: 2, is_na: false, confidence: 'high',
  self_claimed_level: 2, evidence_class: 'observed', cap_applied: false, updated_at: '2026-01-15T00:00:00Z',
};

const STORY_ROW = {
  filename: 'story-dim1-ci-evidence.md', team_id: 'TEAM-001', dimension_id: '1',
  title: 'Close the open claim', markdown: '## Close the claim\n', status: 'ready', jira_key: null,
  created_at: '2026-01-20T00:00:00Z',
};

describe('getTeamRecommendations (Aurora path)', () => {
  it('derives a recommendation from a below-target dimension score, ranked ahead of the unscored dimensions, with its existing story attached', async () => {
    execMock
      .mockResolvedValueOnce([TEAM_ROW]) // fetchTeam: team row
      .mockResolvedValueOnce([]) // fetchTeam: exceptions
      .mockResolvedValueOnce([SCORE_ROW_DIM1]) // fetchDimensionScores: scores
      .mockResolvedValueOnce([]) // fetchDimensionScores: evidence
      .mockResolvedValueOnce([]) // fetchDimensionScores: follow-ups
      .mockResolvedValueOnce([]) // fetchDimensionScores: history
      .mockResolvedValueOnce([{ target_level: 3, motions: '[]', updated_at: '2026-01-01T00:00:00Z' }]) // fetchConfiguration
      .mockResolvedValueOnce([STORY_ROW]); // fetchStories

    const plan = await provider.getTeamRecommendations('TEAM-001');

    expect(plan).not.toBeNull();
    expect(plan!.team_id).toBe('TEAM-001');
    expect(plan!.target_level).toBe(3);
    // Dimension "1" is verified at Level 2 against a Level 3 target -> "advance",
    // ranked ahead of every unscored ("answer") dimension.
    expect(plan!.counts).toEqual({ close_claim: 0, advance: 1, answer: 16, sustain: 0, not_applicable: 0 });
    expect(plan!.recommendations).toHaveLength(17);
    const top = plan!.recommendations[0]!;
    expect(top.dimension_id).toBe('1');
    expect(top.kind).toBe('advance');
    expect(top.rank).toBe(1);
    expect(top.certification.verified_level).toBe(2);
    expect(top.existing_stories).toEqual([{
      filename: 'story-dim1-ci-evidence.md', team_id: 'TEAM-001', dimension_id: '1',
      title: 'Close the open claim', markdown: '## Close the claim\n', status: 'ready', jira_key: null,
      created_at: '2026-01-20T00:00:00Z',
    }]);
    // A dimension with no score at all (e.g. "2") never scored is classified "answer".
    const answerDim = plan!.recommendations.find((r) => r.dimension_id === '2')!;
    expect(answerDim.kind).toBe('answer');
    expect(answerDim.existing_stories).toEqual([]);
  });

  it('returns null for a team Aurora has never heard of, without touching dimension scores or configuration', async () => {
    execMock.mockResolvedValueOnce([]); // fetchTeam -> no row
    const plan = await provider.getTeamRecommendations('TEAM-999');
    expect(plan).toBeNull();
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
