// Wire contracts for /api/session-bundle — the Release phase's session
// config surface. Mirrors middleware/src/providers/session-bundle.ts.

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
  appliesTo: string[];
  status: BundleStatus;
}

/** GET /api/session-bundle/live carries the live impact count alongside the
 *  bundle, judged against the fleet as of the read. */
export interface SessionBundleDetail extends SessionBundle {
  sessionsAffected: number;
}
