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
  refresh: () => void;
}

export function useTeams(): UseTeamsResult {
  const { data, isLoading, error, refresh } = useFetch<TeamSummary[]>('/api/assessment/teams');
  return {
    teams: data ?? [],
    isLoading,
    isError: error !== null,
    refresh,
  };
}
