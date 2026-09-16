// Roster fetch for the cohort landing + team list views.
//
// Thin wrapper over the shared `useFetch` hook (portal/src/hooks/useFetch.ts) —
// no react-query here, matching the rest of the portal's mock-friendly pages.

import { useFetch } from '../../../hooks/useFetch';
import type { TeamSummary } from '../types';

export interface UseTeamsResult {
  teams: TeamSummary[];
  isLoading: boolean;
  isError: boolean;
  /**
   * The wire's "we could not look" marker (lib/degraded.ts), already unwrapped
   * by `useFetch`. `/api/assessment/teams` answers a bare array on a healthy
   * read, so this is `null` in practice today — carried anyway so the roster
   * fetch matches every other page's shape and a future degraded envelope on
   * this route does not need a second wiring pass.
   */
  degraded: string | null;
  refresh: () => void;
}

/**
 * `enabled` (default true) lets a caller that does not need the roster right
 * now — the team scorecard view, which renders one team, not the list —
 * skip the fetch entirely by passing a null URL to `useFetch`. Without this,
 * opening a scorecard fetched the whole roster and never read it
 * (CLAUDE.md's request-budget audit finding #2).
 */
export function useTeams(enabled = true): UseTeamsResult {
  const { data, isLoading, error, degraded, refresh } = useFetch<TeamSummary[]>(enabled ? '/api/assessment/teams' : null);
  return {
    teams: data ?? [],
    isLoading,
    isError: error !== null,
    degraded,
    refresh,
  };
}
