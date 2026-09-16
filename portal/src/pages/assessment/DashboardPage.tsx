// Two views behind one route tree: the assessor's desk (every team, with the
// motion as a `?cohort=` filter) -> team scorecard. State lives in the URL
// (`?cohort=`, `/teams/:teamId?tab=`) via react-router, never
// `window.history` directly — App.tsx already routes both `teams` and
// `teams/:teamId` here. The source app's three-view split (cohort landing ->
// per-cohort list -> scorecard) collapsed into the desk on 2026-09-15
// (docs/assessment-ux-goal.md): the cards and the per-cohort table were two
// pages spent on numbers one strip carries.
//
// The shell breadcrumb (Assessment › Teams › TEAM-002) is derived from the
// URL path alone (components/shell/Breadcrumbs.tsx); this page does not
// touch it. The trailing dimension crumb lives inside TeamScorecard.

import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AssessorDesk } from './dashboard/AssessorDesk';
import { NewTeamModal } from './dashboard/NewTeamModal';
import { TeamScorecard } from './dashboard/TeamScorecard';
import { useTeams } from './dashboard/useTeams';
import type { Cohort } from './types';

const COHORTS: Array<Cohort | 'all'> = ['all', 'white_glove', 'self_service', 'general'];

type ScorecardTab = 'scorecard' | 'plan' | 'stories' | 'evidence' | 'documents';
const VALID_TABS: ScorecardTab[] = ['scorecard', 'plan', 'stories', 'evidence', 'documents'];

function DashboardPage() {
  const { teamId } = useParams<{ teamId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { teams, isLoading, isError, degraded, refresh } = useTeams();
  const [newTeamOpen, setNewTeamOpen] = useState(false);

  // ── View 3: scorecard ──────────────────────────────────────────────────
  if (teamId) {
    const requestedTab = searchParams.get('tab');
    const tab: ScorecardTab = VALID_TABS.includes(requestedTab as ScorecardTab)
      ? (requestedTab as ScorecardTab)
      : 'scorecard';

    return (
      <TeamScorecard
        teamId={teamId}
        tab={tab}
        onTabChange={(next) => {
          const params = new URLSearchParams(searchParams);
          if (next === 'scorecard') params.delete('tab');
          else params.set('tab', next);
          setSearchParams(params, { replace: true });
        }}
      />
    );
  }

  // ── View 1: the assessor's desk ──────────────────────────────────────────
  const cohortParam = searchParams.get('cohort');
  const cohort: Cohort | 'all' = COHORTS.includes(cohortParam as Cohort | 'all') ? (cohortParam as Cohort | 'all') : 'all';
  return (
    <>
      <AssessorDesk
        teams={teams}
        isLoading={isLoading}
        isError={isError}
        degraded={degraded}
        cohort={cohort}
        onCohortChange={(next) => {
          const params = new URLSearchParams(searchParams);
          if (next === 'all') params.delete('cohort'); else params.set('cohort', next);
          setSearchParams(params, { replace: true });
        }}
        onSelectTeam={(id) => navigate(`/assessment/teams/${encodeURIComponent(id)}`)}
        onNewTeam={() => setNewTeamOpen(true)}
        onRetry={refresh}
      />
      <NewTeamModal
        open={newTeamOpen}
        onClose={() => setNewTeamOpen(false)}
        onCreated={(team) => {
          refresh();
          navigate(`/assessment/teams/${encodeURIComponent(team.id)}`);
        }}
      />
    </>
  );
}

export default DashboardPage;
