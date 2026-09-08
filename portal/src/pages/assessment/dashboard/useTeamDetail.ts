// One team's full scorecard — team, workflow steps, and all 17 dimensions.

import { useFetch } from '../../../hooks/useFetch';
import type { TeamDetailResponse } from '../types';

export interface UseTeamDetailResult {
  data: TeamDetailResponse | null;
  isLoading: boolean;
  isError: boolean;
  /** The server said 404 — a bad id, not an outage. Rendered differently. */
  notFound: boolean;
  refresh: () => void;
}

export function useTeamDetail(teamId: string | null): UseTeamDetailResult {
  const { data, isLoading, error, refresh } = useFetch<TeamDetailResponse>(
    teamId ? `/api/assessment/teams/${encodeURIComponent(teamId)}` : null,
  );
  return {
    data,
    isLoading,
    isError: error !== null,
    // useFetch surfaces `${status} ${statusText}`; a 404 is the one failure
    // the page can name precisely ("no such team") instead of blaming the API.
    notFound: error !== null && error.startsWith('404'),
    refresh,
  };
}
