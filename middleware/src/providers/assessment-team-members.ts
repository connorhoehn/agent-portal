// The explicit user ↔ assessment-team link (schema/assessment_team_members_schema.sql;
// the registered `assessment-team-members` fixture under MOCK_AURORA). This is
// the ONLY source "My teams" reads (lib/mine.ts); nothing matches names.
//
// On a cluster where the additive table has not been applied, the read answers
// no rows and names the gap in `limit`, so the plane shows an honest empty
// section rather than a 503 for a schema the operator has not run — a real
// connection failure still surfaces as the provider error it is.

import { config } from '../config.js';
import { assessmentTeamMembersFixture, type AssessmentTeamMemberRole, type AssessmentTeamMemberRow } from '../mock/assessment-team-members.js';
import { exec } from './aurora.js';
import { strParam } from './projects.js';

export type { AssessmentTeamMemberRole, AssessmentTeamMemberRow };

export interface AssessmentTeamMemberships {
  rows: AssessmentTeamMemberRow[];
  /** Why the answer may be incomplete (the table not applied); null when it is the whole truth. */
  limit: string | null;
}

const MISSING_TABLE = 'assessment_team_members is not applied on this cluster (schema/assessment_team_members_schema.sql); team memberships are unknown';
const missingRelation = (err: unknown) => /does not exist|relation/i.test((err as Error)?.message ?? '');

function row(r: Record<string, unknown>): AssessmentTeamMemberRow {
  const role = String(r['role'] ?? 'member');
  return {
    teamId: String(r['team_id']), userId: String(r['user_id']),
    role: role === 'lead' || role === 'contributor' ? role : 'member',
    addedAt: String(r['added_at'] ?? ''),
  };
}

/** Every team `userId` is on. */
export async function listAssessmentTeamMemberships(userId: string): Promise<AssessmentTeamMemberships> {
  if (config.mock.aurora) {
    return { rows: assessmentTeamMembersFixture.rows().filter((m) => m.userId === userId).map((m) => ({ ...m })), limit: null };
  }
  try {
    const rows = await exec(
      'SELECT team_id, user_id, role, added_at::text AS added_at FROM assessment_team_members WHERE user_id = :me ORDER BY team_id',
      [strParam('me', userId)],
    );
    return { rows: rows.map(row), limit: null };
  } catch (err) {
    if (missingRelation(err)) return { rows: [], limit: MISSING_TABLE };
    throw err;
  }
}

/** The roster of each team named, by team id (every member row, not only the viewer's). */
export async function listAssessmentTeamRosters(teamIds: readonly string[]): Promise<Map<string, AssessmentTeamMemberRow[]>> {
  const out = new Map<string, AssessmentTeamMemberRow[]>();
  if (!teamIds.length) return out;
  const wanted = new Set(teamIds);
  let rows: AssessmentTeamMemberRow[];
  if (config.mock.aurora) {
    rows = assessmentTeamMembersFixture.rows().filter((m) => wanted.has(m.teamId)).map((m) => ({ ...m }));
  } else {
    try {
      const params = teamIds.map((id, i) => strParam(`t${i}`, id));
      rows = (await exec(
        `SELECT team_id, user_id, role, added_at::text AS added_at FROM assessment_team_members
          WHERE team_id IN (${teamIds.map((_, i) => `:t${i}`).join(', ')}) ORDER BY team_id, user_id`,
        params,
      )).map(row);
    } catch (err) {
      if (missingRelation(err)) return out;
      throw err;
    }
  }
  for (const r of rows) {
    const list = out.get(r.teamId) ?? [];
    list.push(r);
    out.set(r.teamId, list);
  }
  return out;
}
