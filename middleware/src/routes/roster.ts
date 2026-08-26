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

export interface RosterEntry {
  id: string;
  name: string;
  title: string | null;
  isSme: boolean;
}

export const rosterRouter = Router();

// GET /api/roster → { people: RosterEntry[] }
rosterRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ people: await listRoster() });
}));

async function listRoster(): Promise<RosterEntry[]> {
  if (config.mock.aurora) return mockRoster();

  // BOOL_OR over the LEFT JOIN marks anyone who is an SME on ANY initiative;
  // people with no contributions still appear (is_sme = false).
  const rows = await exec(
    `SELECT p.id AS id, p.name AS name, p.title AS title,
            COALESCE(BOOL_OR(pc.role = 'sme'), FALSE) AS is_sme
       FROM people p
       LEFT JOIN project_contributions pc ON pc.person_id = p.id
      GROUP BY p.id, p.name, p.title
      ORDER BY p.name`,
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
