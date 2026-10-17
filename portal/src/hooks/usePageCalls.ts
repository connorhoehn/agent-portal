// A page's call history and the names to draw it with. The rows come from the
// BFF (`GET /api/calls?lobby=` for one page lobby, `/api/calls/tenant` for the
// actor's calls across the active tenant), which asks the page's own read
// authority on every request — a reader without it gets a 403/404 here, never
// rows. Names: the active tenant's shared directory (`/api/people/shared`),
// else the caller named on the row, else the id.
import { useCallback, useMemo } from 'react';
import { useFetch } from './useFetch';
import { readSharedPeople } from '../components/shell/tenantDirectModel';
import type { PageCallsResponse } from '../lib/pageCalls';
import type { NameOf } from '../pages/social/socialPlatform';

export interface PageCallsState {
  data: PageCallsResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/** The lobby's calls; `null` lobby = no request (a page with no huddle, or a view nobody opened). */
export function usePageCalls(lobby: string | null): PageCallsState {
  const { data, isLoading, error, refresh } = useFetch<PageCallsResponse>(lobby ? `/api/calls?lobby=${encodeURIComponent(lobby)}` : null);
  return { data, isLoading, error, refresh };
}

/** The actor's calls across the active tenant's pages. */
export function useTenantCalls(enabled = true): PageCallsState {
  const { data, isLoading, error, refresh } = useFetch<PageCallsResponse>(enabled ? '/api/calls/tenant' : null, 60_000);
  return { data, isLoading, error, refresh };
}

/** Your own portrait from the shared directory (same shared fetch as usePeopleNames); undefined → initials. */
export function useSelfAvatar(enabled = true): string | undefined {
  const fetched = useFetch<unknown>(enabled ? '/api/people/shared' : null, 120_000, { share: true });
  return useMemo(() => readSharedPeople(fetched.data)?.me.avatarUrl, [fetched.data]);
}

export function usePeopleNames(enabled = true): NameOf {
  const fetched = useFetch<unknown>(enabled ? '/api/people/shared' : null, 120_000, { share: true });
  const people = useMemo(() => readSharedPeople(fetched.data), [fetched.data]);
  return useCallback((userId: string) => {
    if (people?.me.userId === userId) return people.me.displayName;
    return people?.people.find(p => p.userId === userId)?.displayName ?? userId;
  }, [people]);
}

/**
 * The call host's directory (`CallHostProvider nameFor`): a person's name and portrait from the shared
 * directory, or null for someone it does not know (the call keeps its own name, then the id).
 */
export function usePeopleDirectory(enabled = true): (userId: string) => { displayName: string; avatarUrl?: string } | null {
  const fetched = useFetch<unknown>(enabled ? '/api/people/shared' : null, 120_000, { share: true });
  const people = useMemo(() => readSharedPeople(fetched.data), [fetched.data]);
  return useCallback((userId: string) => {
    const person = people?.me.userId === userId ? people.me : people?.people.find(p => p.userId === userId);
    if (!person?.displayName || person.displayName === userId) return null;
    return { displayName: person.displayName, ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}) };
  }, [people]);
}

