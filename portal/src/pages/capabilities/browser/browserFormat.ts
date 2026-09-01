// Pure derivations for the Browser capability page.

import type { BrowserSession } from './types';

/** A session that has never navigated reports `about:blank`; showing that
 *  string in a URL column reads like a real destination, so it becomes a dash. */
export const BLANK_URL = 'about:blank';

export function isBlankUrl(url: string): boolean {
  return !url || url === BLANK_URL;
}

export function sessionTone(status: BrowserSession['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'IDLE') return 'warning';
  return 'neutral';
}

export function openSessions(sessions: BrowserSession[]): BrowserSession[] {
  return sessions.filter(s => s.status !== 'CLOSED');
}

export function closedSessions(sessions: BrowserSession[]): BrowserSession[] {
  return sessions
    .filter(s => s.status === 'CLOSED')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
