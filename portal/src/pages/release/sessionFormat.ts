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
  current: 'Up to date', stale: 'Update available', missing: 'Not in library',
};

/** A newer or unlisted library version does not prove a pinned skill broken. */
export function skillStatusTone(status: SkillStatus): 'success' | 'info' | 'neutral' {
  return status === 'current' ? 'success' : status === 'stale' ? 'info' : 'neutral';
}

/** Neutral update availability, not an operational-health warning. */
export function driftLine(bundle: Pick<SessionBundle, 'skills'>): string | null {
  const stale = bundle.skills.filter((s) => s.status === 'stale').length;
  const missing = bundle.skills.filter((s) => s.status === 'missing').length;
  if (stale === 0 && missing === 0) return null;
  const parts: string[] = [];
  if (stale > 0) parts.push(`${stale} update${stale === 1 ? '' : 's'} available`);
  if (missing > 0) parts.push(`${missing} not in library`);
  return parts.join(' · ');
}

export function versionLabel(version: string): string {
  return `v${version.replace(/^v/i, '')}`;
}
