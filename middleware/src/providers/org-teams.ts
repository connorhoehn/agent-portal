// Org-graph teams of one person (docs/communication-plane-goal.md §1.4):
// `teams` + `team_memberships` in Aurora (schema/orgiq_schema.sql) through the
// RDS Data API, with each member resolved to an app user where one is linked
// (`app_users.person_id`) so presence — which knows users, not people — can
// overlay. Under MOCK_AURORA the registered `graph.teams` fixture and the
// people fixture's `department` (mock/people.ts) are the same two tables.
//
// "Mine" is the caller's concern: this module takes a person id the route
// already resolved from the directory, never from a request body.

import { config } from '../config.js';
import { graphPeople, graphTeams } from '../mock/people.js';
import { exec } from './aurora.js';
import { listUsers } from './identity.js';
import { strParam } from './projects.js';

export interface OrgTeamMember { personId: string; name: string; userId: string | null }
export interface OrgTeam { id: string; name: string; parentId: string | null; role: string | null; members: OrgTeamMember[] }

const MEMBER_CAP = 200;

/** `app_users.person_id` → user id, for everyone linked. */
async function linkedUsers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const u of await listUsers()) if (u.personId && !out.has(u.personId)) out.set(u.personId, u.id);
  return out;
}

/** The teams `personId` belongs to, each with its full member list. Empty when the person is on none. */
export async function listTeamsForPerson(personId: string): Promise<OrgTeam[]> {
  if (config.mock.aurora) {
    const people = graphPeople.rows();
    const me = people.find(p => p.id === personId);
    if (!me) return [];
    const users = await linkedUsers();
    return graphTeams.rows()
      .filter(team => team.name === me.department)
      .map(team => ({
        id: team.id, name: team.name, parentId: team.parentId, role: me.title || null,
        members: people.filter(p => p.department === team.name).slice(0, MEMBER_CAP)
          .map(p => ({ personId: p.id, name: p.name, userId: users.get(p.id) ?? null })),
      }));
  }
  const mine = await exec(
    `SELECT t.id, t.name, t.parent_id, tm.role
       FROM team_memberships tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.person_id = :me
      ORDER BY t.name`,
    [strParam('me', personId)],
  );
  if (!mine.length) return [];
  const teamIds = mine.map(r => String(r['id']));
  const params = teamIds.map((id, i) => strParam(`t${i}`, id));
  const members = await exec(
    `SELECT tm.team_id, p.id AS person_id, p.name, u.id AS user_id
       FROM team_memberships tm
       JOIN people p ON p.id = tm.person_id
       LEFT JOIN LATERAL (SELECT id FROM app_users WHERE person_id = p.id ORDER BY id LIMIT 1) u ON TRUE
      WHERE tm.team_id IN (${teamIds.map((_, i) => `:t${i}`).join(', ')})
      ORDER BY p.name`,
    params,
  );
  const byTeam = new Map<string, OrgTeamMember[]>();
  for (const row of members) {
    const list = byTeam.get(String(row['team_id'])) ?? [];
    if (list.length < MEMBER_CAP) list.push({ personId: String(row['person_id']), name: String(row['name']), userId: row['user_id'] == null ? null : String(row['user_id']) });
    byTeam.set(String(row['team_id']), list);
  }
  return mine.map(r => ({
    id: String(r['id']), name: String(r['name']), parentId: r['parent_id'] == null ? null : String(r['parent_id']),
    role: r['role'] == null ? null : String(r['role']), members: byTeam.get(String(r['id'])) ?? [],
  }));
}
