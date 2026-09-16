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

export function useTeams(): UseTeamsResult {
  const { data, isLoading, error, degraded, refresh } = useFetch<TeamSummary[]>('/api/assessment/teams');
  return {
    teams: data ?? [],
    isLoading,
    isError: error !== null,
    degraded,
    refresh,
  };
}
