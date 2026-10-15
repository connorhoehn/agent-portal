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
// The seed is the assessment cast's work (docs/demo-content-audit.md, the
// assessment story): each team's `assessment_lead` in mock/assessment.ts is the
// cast member with a lead row here. Jonas Lindqvist leads Northstar Payments
// and Kubernetes Operator; Asha Nair leads Checkout Experience and Fraud
// Detection ML and contributes on Northstar; Farah Osei (program lead) leads
// Data Platform and Notifications Service. The teams' own engineers the
// fixture names (Deepa Natarajan, Jordan Lee, …) have no app account, so they
// hold no row.

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
      { teamId: 'TEAM-001', userId: 'u-jonas', role: 'lead', addedAt: clock.daysAgo(45) },
      { teamId: 'TEAM-001', userId: 'u-asha', role: 'contributor', addedAt: clock.daysAgo(30) },
      { teamId: 'TEAM-002', userId: 'u-jonas', role: 'lead', addedAt: clock.daysAgo(40) },
      { teamId: 'TEAM-003', userId: 'u-asha', role: 'lead', addedAt: clock.daysAgo(38) },
      { teamId: 'TEAM-004', userId: 'u-farah', role: 'lead', addedAt: clock.daysAgo(36) },
      { teamId: 'TEAM-005', userId: 'u-farah', role: 'lead', addedAt: clock.daysAgo(33) },
      { teamId: 'TEAM-006', userId: 'u-asha', role: 'lead', addedAt: clock.daysAgo(20) },
    ],
    empty: () => [],
  },
});
