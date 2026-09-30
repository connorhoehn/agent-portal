// GET /api/roster — the org's people as a flat pick-list.
//
// Audit RM-5: the New Sprint steward picker and the grant-grantee picker were
// sourced only from one initiative's own contributors, so a cross-initiative
// SME — the operating model's whole point (one owner per initiative, a few SMEs
// attaching across several) — could not be made steward or granted an envelope
// from the UI, even though POST /api/sprints and POST /api/grants accept ANY
// existing person. This is the eligible-people source both pickers read.
//
// Deliberately NOT the org-chart/leaderboard surfaces: /api/graph/entities
// returns the whole relationship graph (many joins) just to spell names, and it
// plus /api/scores gate on ViewOrgChart / ViewLeaderboard. Choosing a steward
// is not org-chart-privileged, so this sits at a bare requireSession floor
// (applied at the mount in index.ts, together with requireTenant('orgiq')):
// any signed-in orgiq member may read it, which is exactly the set who can be
// picked. Read-only, parameterized SQL, with a mock-mode path.
//
// `isSme` flags anyone holding an 'sme' contribution role on any initiative, so
// the picker can surface SMEs — the people RM-5 is about — distinctly.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { config } from '../config.js';
import { exec } from '../providers/aurora.js';
import { mockPeople } from '../mock/people.js';
import { listUsers } from '../providers/identity.js';

export interface RosterEntry {
  id: string;
  name: string;
  title: string | null;
  isSme: boolean;
}

export const rosterRouter = Router();

// A silent clamp, not a 400 — every picker on the portal reads this list
// unconditionally with no query params of its own, so a caller that never
// asks for `limit` must keep getting everyone the seed has today (well under
// the default) while a cluster that outgrows it is bounded rather than an
// unbounded SELECT with no LIMIT at all.
const DEFAULT_ROSTER_LIMIT = 500;
const MAX_ROSTER_LIMIT = 2000;

function clampRosterLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_ROSTER_LIMIT) : DEFAULT_ROSTER_LIMIT;
}

// GET /api/roster?limit= → { people: RosterEntry[] }
rosterRouter.get('/', asyncHandler(async (req, res) => {
  const limit = clampRosterLimit(req.query['limit']);
  res.json({ people: await listRoster(limit) });
}));

// GET /api/roster/users?personIds=p-002,p-004 → { users, unlinked }
//
// Org people → the app_users who sign in as them, for the initiative call
// (docs/social-calls-plan.md step 5): a call rings USER ids (the realtime
// token's `sub`), while an initiative's owner and SMEs are PERSON ids. Only
// users holding a grant in the caller's current tenant are returned, so a
// person linked to a user in another tenant reads as unlinked here. A person
// with no linked user is listed in `unlinked` so the page can say who it
// cannot ring. Same bare session floor as the roster (mounted in index.ts).
// `social` (lane E, design §4.6): whether that user holds a social grant, so
// Search's Message button can say who a DM would not reach — present only
// when the CALLER holds a social grant (it is a fact about the social tenant).
export interface RosterUser { personId: string; userId: string; displayName: string; social?: boolean }
const MAX_PERSON_IDS = 50;

rosterRouter.get('/users', asyncHandler(async (req, res) => {
  const raw = String(req.query['personIds'] ?? '');
  const personIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_PERSON_IDS);
  const tenant = req.session?.tenant ?? null;
  const users = personIds.length ? await listUsers() : [];
  const out: RosterUser[] = [];
  const unlinked: string[] = [];
  const callerInSocial = (req.session?.grants?.['social']?.length ?? 0) > 0;
  for (const personId of personIds) {
    const u = users.find((x) => x.personId === personId && (!tenant || (x.grants[tenant]?.length ?? 0) > 0));
    if (u) out.push({ personId, userId: u.id, displayName: u.displayName, ...(callerInSocial ? { social: (u.grants['social']?.length ?? 0) > 0 } : {}) });
    else unlinked.push(personId);
  }
  res.json({ users: out, unlinked });
}));

async function listRoster(limit: number): Promise<RosterEntry[]> {
  if (config.mock.aurora) return mockRoster().slice(0, limit);

  // BOOL_OR over the LEFT JOIN marks anyone who is an SME on ANY initiative;
  // people with no contributions still appear (is_sme = false).
  const rows = await exec(
    `SELECT p.id AS id, p.name AS name, p.title AS title,
            COALESCE(BOOL_OR(pc.role = 'sme'), FALSE) AS is_sme
       FROM people p
       LEFT JOIN project_contributions pc ON pc.person_id = p.id
      GROUP BY p.id, p.name, p.title
      ORDER BY p.name
      LIMIT :lim`,
    [{ name: 'lim', value: { longValue: limit } }],
  );
  return rows
    .map<RosterEntry>((r) => ({
      id: r['id'] != null ? String(r['id']) : '',
      name: r['name'] != null ? String(r['name']) : '',
      title: r['title'] != null ? String(r['title']) : null,
      isSme: r['is_sme'] === true,
    }))
    .filter((p) => p.id !== '');
}

// Mock parity: the same in-memory cast the graph mock serves. No SME column
// exists in the mock arrays, so isSme is false — the picker still lists everyone
// and the initiative's own contributors are surfaced first from the project
// detail, so dev:mock keeps full parity on the fix (all people selectable).
function mockRoster(): RosterEntry[] {
  return mockPeople
    .map<RosterEntry>((p) => ({
      id: p.id,
      name: p.name,
      title: p.title ?? null,
      isSme: false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
