// Pure derivations for the session config page. No React — testable under
// node:test, same shape as library/libraryFormat.ts.

import type { BundleStatus, HookEvent, SessionBundle, SkillStatus } from './types';

export const STATUS_LABEL: Record<BundleStatus, string> = {
  live: 'Live', pending: 'Pending', superseded: 'Superseded',
};

export const STATUS_TONE: Record<BundleStatus, 'success' | 'info' | 'neutral'> = {
  live: 'success', pending: 'info', superseded: 'neutral',
};

export const HOOK_EVENT_LABEL: Record<HookEvent, string> = {
  SessionStart: 'Session start', PreToolUse: 'Before tool use',
  PostToolUse: 'After tool use', Stop: 'Session stop',
};

export const SKILL_STATUS_LABEL: Record<SkillStatus, string> = {
  current: 'current', stale: 'stale', missing: 'missing',
};

/** stale = the library moved past this bundled skill; missing = the library
 *  no longer has it at all, so a chip that reads "missing" is worse than
 *  "stale", not the same shade of bad. */
export function skillStatusTone(status: SkillStatus): 'success' | 'warning' | 'danger' {
  return status === 'current' ? 'success' : status === 'stale' ? 'warning' : 'danger';
}

/** "2 skills stale · 1 missing" — the one-line answer to "why does my
 *  session not know about X". Says nothing when the bundle is fully current,
 *  rather than "0 stale · 0 missing". */
export function driftLine(bundle: Pick<SessionBundle, 'skills'>): string | null {
  const stale = bundle.skills.filter((s) => s.status === 'stale').length;
  const missing = bundle.skills.filter((s) => s.status === 'missing').length;
  if (stale === 0 && missing === 0) return null;
  const parts: string[] = [];
  if (stale > 0) parts.push(`${stale} skill${stale === 1 ? '' : 's'} stale`);
  if (missing > 0) parts.push(`${missing} missing`);
  return parts.join(' · ');
}

/** A SessionStart hook whose command isn't pinned to a fixed script/version —
 *  mirrors the structural check in middleware/src/providers/session-bundle.ts
 *  so the UI can grey the Publish button out before a round trip, not just
 *  after a 409. The dry-run + approver gates still only get enforced server
 *  side, since they depend on runtime context this page doesn't have yet. */
function isUnpinnedCommand(command: string): boolean {
  return /\|\s*(sudo\s+)?(ba)?sh\b/i.test(command) || /@latest\b/i.test(command);
}

/**
 * Why a bundle can't be published right now, using only what's already on
 * the bundle — never null just because a dry run hasn't happened yet, since
 * that's a runtime fact the server decides at publish time, not a static
 * property of the bundle.
 */
export function publishBlockedReason(bundle: SessionBundle): string | null {
  if (bundle.status === 'live') return 'already live';
  if (bundle.status === 'superseded') return 'superseded — publish a newer bundle instead';
  const unpinned = bundle.hooks.find((h) => h.event === 'SessionStart' && h.enabled && isUnpinnedCommand(h.command));
  if (unpinned) return `SessionStart hook runs an unpinned command ("${unpinned.command}")`;
  return null;
}
