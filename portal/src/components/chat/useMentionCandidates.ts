// The @ menu for a tenant discussion composer: the people who share the
// caller's active tenant (`GET /api/people/shared`, the shell's directory),
// filtered by what was typed. The picked name travels as `@<display name>` in
// the message text; the gateway resolves it against the tenant's directory and
// notifies only the mentioned people who can read the conversation
// (middleware realtime-gateway `tenantMentionNotifyPlugin`), so a candidate
// who cannot read it is simply not notified.

import { useCallback, useRef } from 'react';
import type { MentionCandidate } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { readSharedPeople } from '../shell/tenantDirectModel';
import { reportApiFailure, responseFailure } from '../../lib/apiFailure';

interface MentionScope { userId?: string; tenant?: string; key?: string }

export function useMentionCandidates(enabled = true, scope: MentionScope = {}): ((query: string) => Promise<MentionCandidate[]>) | undefined {
  // Fetch on @ lookup, never retain a previous account's roster through a
  // refresh failure. An in-flight answer also belongs to its original input.
  const scopeKey = `${scope.userId ?? ''}:${scope.tenant ?? ''}:${scope.key ?? ''}`;
  const latest = useRef({ enabled, scope, scopeKey });
  latest.current = { enabled, scope, scopeKey };
  const search = useCallback(async (query: string): Promise<MentionCandidate[]> => {
    const started = latest.current;
    if (!started.enabled) return [];
    try {
      const response = await fetch('/api/people/shared', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) { reportApiFailure(await responseFailure(response)); return []; }
      const directory = readSharedPeople(await response.json());
      if (!directory || !latest.current.enabled || latest.current.scopeKey !== started.scopeKey
        || (started.scope.userId && directory.me.userId !== started.scope.userId)
        || (started.scope.tenant && directory.tenant !== started.scope.tenant)) return [];
      const needle = query.trim().toLowerCase();
      return directory.people.filter(person => !needle || person.displayName.toLowerCase().includes(needle))
        .slice(0, 8).map(person => ({ id: person.userId, label: person.displayName }));
    } catch { return []; }
  }, []);
  return enabled ? search : undefined;
}
