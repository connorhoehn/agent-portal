// Session bundles: the hooks, skills and settings a devbox session runs with.
// Read-only. The bundle rows are seeded fixtures (mock/session-bundle.ts) in
// every environment; the live one feeds the "Skills on this box" section of a
// devbox run's brief (lib/run-brief.ts) and the Local compute › Configuration
// page (GET /api/session-bundle/live).

import { MOCK_LIBRARY_VERSIONS, sessionBundles } from '../mock/session-bundle.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface SessionHook {
  event: HookEvent;
  command: string;
  description: string;
  enabled: boolean;
}

export type SkillStatus = 'current' | 'stale' | 'missing';

export interface BundledSkill {
  id: string;
  name: string;
  description: string;
  /** The version this bundle shipped — compared against the library's current
   *  version to derive `status` fresh on every read, never trusted at rest. */
  version: string;
  source: 'library' | 'baked';
  status: SkillStatus;
}

export type BundleStatus = 'live' | 'pending' | 'superseded';

export interface SessionBundle {
  id: string;
  version: string;
  publishedAt: string;
  publishedBy: string;
  hooks: SessionHook[];
  skills: BundledSkill[];
  settings: Record<string, string | boolean | number>;
  /** Box ids this bundle targets, or the literal `'fleet'` for every box. */
  appliesTo: string[];
  status: BundleStatus;
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

/** Newer wins. Library and bundle versions are both the flat integer strings
 *  the library already uses ('1', '2', '3', ...) — no semver here. */
function skillStatus(bundledVersion: string, libraryVersion: string | undefined): SkillStatus {
  if (libraryVersion == null) return 'missing'; // library dropped this skill entirely — an orphan the bundle still ships
  return Number(libraryVersion) > Number(bundledVersion) ? 'stale' : 'current';
}

const LIVE_BOX_STATUSES: ReadonlySet<string> = new Set(['provisioning', 'idle', 'running', 'waiting']);

/** How many live sessions run this bundle: `'fleet'` means every live box,
 *  otherwise only the boxes named. */
export function sessionsAffected(
  bundle: Pick<SessionBundle, 'appliesTo'>,
  boxes: Array<{ id: string; status: string }>,
): number {
  const fleetWide = bundle.appliesTo.includes('fleet');
  return boxes.filter((b) => LIVE_BOX_STATUSES.has(b.status) && (fleetWide || bundle.appliesTo.includes(b.id))).length;
}

// ─── Stored shape ────────────────────────────────────────────────────────────

/** One bundle as it is stored: `status` per skill is derived, never held. */
export interface RawSkill {
  id: string; name: string; description: string; version: string; source: 'library' | 'baked';
}

export interface RawBundle {
  id: string; version: string; publishedAt: string; publishedBy: string;
  hooks: SessionHook[]; skills: RawSkill[];
  settings: Record<string, string | boolean | number>;
  appliesTo: string[]; status: BundleStatus;
}

function toBundle(raw: RawBundle): SessionBundle {
  return {
    id: raw.id, version: raw.version, publishedAt: raw.publishedAt, publishedBy: raw.publishedBy,
    hooks: raw.hooks,
    skills: raw.skills.map((s) => ({ ...s, status: skillStatus(s.version, MOCK_LIBRARY_VERSIONS[s.id]) })),
    settings: raw.settings,
    appliesTo: raw.appliesTo,
    status: raw.status,
  };
}

// ─── Provider ────────────────────────────────────────────────────────────────

export async function getLiveBundle(): Promise<SessionBundle | null> {
  const raw = sessionBundles.rows().find((b) => b.status === 'live');
  return raw ? toBundle(raw) : null;
}
