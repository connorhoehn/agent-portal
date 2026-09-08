// Three views behind one route tree, exactly like the source's
// AssessmentDashboardIsland: cohort landing -> team list (per cohort or all)
// -> team scorecard. State lives in the URL (`?cohort=`, `/teams/:teamId?tab=`)
// via react-router, never `window.history` directly — App.tsx already routes
// both `teams` and `teams/:teamId` here (see docs/assessment-tenant.md
// "Assessment page (/teams)").
//
// The shell breadcrumb (Assessment › Teams › TEAM-002) is derived from the
// URL path alone (components/shell/Breadcrumbs.tsx); this page does not
// touch it. The trailing dimension crumb lives inside TeamScorecard.

import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { CohortLanding } from './dashboard/CohortLanding';
import { NewTeamModal } from './dashboard/NewTeamModal';
import { TeamList } from './dashboard/TeamList';
import { TeamScorecard } from './dashboard/TeamScorecard';
import { useTeams } from './dashboard/useTeams';
import { cohortTitle, teamsForCohort } from './assessmentFormat';
import type { Cohort } from './types';

type ScorecardTab = 'scorecard' | 'plan' | 'stories' | 'evidence' | 'documents';
const VALID_TABS: ScorecardTab[] = ['scorecard', 'plan', 'stories', 'evidence', 'documents'];

function DashboardPage() {
  const { teamId } = useParams<{ teamId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { teams, isLoading, isError, refresh } = useTeams();
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

  // ── View 2: team list (per cohort or all) ──────────────────────────────
  const cohortParam = searchParams.get('cohort');
  if (cohortParam) {
    const cohort = cohortParam as Cohort | 'all';
    return (
      <TeamList
        teams={teamsForCohort(teams, cohort)}
        cohort={cohort}
        cohortTitle={cohortTitle(cohort)}
        onSelectTeam={(id) => navigate(`/assessment/teams/${encodeURIComponent(id)}`)}
      />
    );
  }

  // ── View 1: cohort landing ──────────────────────────────────────────────
  return (
    <>
      <CohortLanding
        teams={teams}
        isLoading={isLoading}
        isError={isError}
        onSelectCohort={(cohort) => setSearchParams({ cohort })}
        onSelectTeam={(team) => navigate(`/assessment/teams/${encodeURIComponent(team.id)}`)}
        onViewAllTeams={() => setSearchParams({ cohort: 'all' })}
        onNewTeam={() => setNewTeamOpen(true)}
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
