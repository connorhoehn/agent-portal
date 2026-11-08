// Devbox policy profiles, offline — the `devbox_profiles` rows (DE-40).
//
// The seed is exactly what schema/devbox_profiles_schema.sql inserts as
// ('default', 1) and ('restricted', 1): the pre-profile deployment's values, so an offline box runs
// under the same rules a deployed one did before profiles existed. Rows are
// append-only here as in Aurora: a mock write pushes (id, version + 1) and a
// reset puts the one seeded row back. The initiative → profile pointer is NOT
// here: it is `projects.devbox_profile_id`, read from the `initiatives`
// fixture (mock/initiatives.ts `devboxProfileId`), as the spec says.
//
// Scenarios: `empty` is a cluster whose table exists with no rows — the
// provider bootstraps `default` into it, as it does against Aurora.

import { clock, defineFixture } from './core/index.js';
import { DEFAULT_PROFILE_INPUT, RESTRICTED_PROFILE_INPUT, type DevboxProfile } from '../lib/devbox-profile.js';

export const devboxProfiles = defineFixture<DevboxProfile>({
  key: 'devbox-profiles',
  scenarios: {
    default: () => [{
      id: 'default', version: 1, ...DEFAULT_PROFILE_INPUT, models: [...DEFAULT_PROFILE_INPUT.models],
      created_by: 'seed', reason: 'Seeded from the pre-profile deployment values (DE-40).',
      created_at: clock.daysAgo(30),
    }, {
      // The microVM runner's profile, as the SQL seeds it. No initiative points
      // at it offline, so nothing routes to the runner unless a test does.
      id: 'restricted', version: 1, ...RESTRICTED_PROFILE_INPUT, models: [...RESTRICTED_PROFILE_INPUT.models],
      created_by: 'seed', reason: 'The microVM runner profile (docs/microvm-runner-design.md §13).',
      created_at: clock.daysAgo(30),
    }],
    empty: () => [],
  },
});

const copy = (r: DevboxProfile): DevboxProfile => ({ ...r, models: [...r.models] });

/** `SELECT * ... WHERE id = :id ORDER BY version DESC LIMIT 1`. */
export function mockLatestProfile(id: string): DevboxProfile | null {
  const rows = devboxProfiles.rows().filter((r) => r.id === id).sort((a, b) => b.version - a.version);
  return rows[0] ? copy(rows[0]) : null;
}

export function mockGetProfileVersion(id: string, version: number): DevboxProfile | null {
  const row = devboxProfiles.rows().find((r) => r.id === id && r.version === version);
  return row ? copy(row) : null;
}

/** The latest version of every profile id, by id. */
export function mockListProfiles(): DevboxProfile[] {
  const latest = new Map<string, DevboxProfile>();
  for (const r of devboxProfiles.rows()) {
    const seen = latest.get(r.id);
    if (!seen || seen.version < r.version) latest.set(r.id, r);
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copy);
}

export function mockListProfileVersions(id: string): DevboxProfile[] {
  return devboxProfiles.rows().filter((r) => r.id === id).sort((a, b) => b.version - a.version).map(copy);
}

/** `INSERT ... ON CONFLICT (id, version) DO NOTHING RETURNING *`: null when the version exists. */
export function mockInsertProfileVersion(input: Omit<DevboxProfile, 'created_at'>): DevboxProfile | null {
  const rows = devboxProfiles.rows();
  if (rows.some((r) => r.id === input.id && r.version === input.version)) return null;
  const row: DevboxProfile = { ...input, models: [...input.models], created_at: clock.nowIso() };
  rows.push(row);
  return copy(row);
}
