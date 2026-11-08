// Shared "Leaderboard access needed" state for every Scores surface.
//
// /iq/scores/cohorts and /iq/scores/compare used to let a denied fetch fall
// straight through to a raw "Failed to load cohorts / 403 Forbidden" inside
// the full Scores sub-rail (Overview/Cohorts/Compare/Graph) — the exact
// denial /iq/scores already explains. Neither page carries a route-level
// RequireRole, so a role without ViewLeaderboard got a navigable sub-rail
// whose every entry failed raw. docs/orgiq-journeys/sme/DEFECTS.md #6.
import { CapabilityDeniedFallback } from '@connorhoehn/ui-components/shared';

export function LeaderboardAccessNeeded() {
  return (
    <CapabilityDeniedFallback
      capabilityName="Leaderboard"
      title="Leaderboard access needed"
      description="The scoring dashboard is limited to the org-leader and HR Admin roles (the ViewLeaderboard permission). Switch role from the identity menu, top right — or ask an admin for the grant."
    />
  );
}

/**
 * The capability probe is the primary guard (skips the request entirely —
 * see ScoresPage.tsx). This is the fallback for the gap the probe can't
 * close: the server can still deny a request the client expected to
 * succeed (tenant scope, a policy condition change mid-session). Matched
 * against the exact shape `useFetch` gives a non-ok response
 * (`${res.status} ${res.statusText}`, e.g. "403 Forbidden") — a leading
 * status-code match, never a loose substring test against arbitrary error
 * text, so a real outage never gets mistaken for a permission denial.
 */
export function isLeaderboardForbiddenError(error: string | null): boolean {
  return !!error && /^403\b/.test(error.trim());
}
