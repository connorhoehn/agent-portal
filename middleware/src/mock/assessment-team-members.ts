// Which app users are on which assessment team — the explicit membership
// source behind "My teams" on the Communication plane (lib/mine.ts, kind
// `assessment-team`). Before 2026-10-08 the plane matched a user onto a team by
// DISPLAY NAME or email against `assessment_teams.assessment_lead` /
// `contributors` / `contacts` (docs/audit/2026-10-07-audit-plan.md D4): an
// authority rule one namesake away from being wrong. The link is now a row.
//
// Live: `assessment_team_members` (schema/assessment_team_members_schema.sql,
// additive, not yet applied to Aurora — the provider says so in `limits`
// until it is). This registered fixture under MOCK_AURORA; `POST
// /api/__mock/reset` restores it.
//
// The seed is exactly the membership the retired name match produced for the
// seeded cast: Asha Nair (u-asha) is a contributor on TEAM-001 (Northstar
// Payments). The other leads and contributors the team fixture names (Priya
// Natarajan, Jordan Lee, …) have no app account, so they hold no row; u-jonas
// and u-farah are on no team — as before, and now for a reason the data states.

import { clock, defineFixture } from './core/index.js';

export type AssessmentTeamMemberRole = 'lead' | 'contributor' | 'member';

export interface AssessmentTeamMemberRow {
  teamId: string;
  userId: string;
  role: AssessmentTeamMemberRole;
  addedAt: string;
}

export const assessmentTeamMembersFixture = defineFixture<AssessmentTeamMemberRow>({
  key: 'assessment-team-members',
  scenarios: {
    default: () => [
      { teamId: 'TEAM-001', userId: 'u-asha', role: 'contributor', addedAt: clock.daysAgo(30) },
    ],
    empty: () => [],
  },
});
