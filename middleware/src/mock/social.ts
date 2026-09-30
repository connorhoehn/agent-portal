// The social tenant's surface catalog — what the tenant's rail offers and
// which lane brings each surface its data (docs/social-tenant-design.md §4, §7).
//
// Phase S0 registers the tenant and ships every page as an honest empty state;
// channels, rooms, teams and recordings arrive in S1/S2 with their own
// fixtures (mock/social-channels.ts and friends). Until then this is the one
// thing the tenant has rows for, so `GET /api/social/summary` counts it rather
// than typing "8 surfaces, 0 live" next to rows that could say so themselves
// (mock contract rule 1).
//
// The catalog is product metadata, not tenant data: live mode reads the same
// rows. `empty` exists so an audit can see the summary's zero state without
// mutating anything (contract rule 4).

import { defineFixture } from './core/index.js';

/** A lane of the design's §7 table — the phase that gives a surface its data. */
export type SocialPhase = 'S1' | 'S2';

export interface SocialSurface {
  /** The route segment under /social. */
  id: string;
  label: string;
  /** Rail group (GROUP_ORDER_BY_TENANT.social in the portal). */
  group: 'Talk' | 'Meet' | 'People' | 'Library' | 'System';
  /** The lane that brings this surface its data. */
  phase: SocialPhase;
  /** True once the surface reads real rows; every one is false at S0. */
  live: boolean;
}

export const socialSurfaces = defineFixture<SocialSurface>({
  key: 'social.surfaces',
  scenarios: {
    default: () => [
      { id: 'channels', label: 'Channels', group: 'Talk', phase: 'S1', live: false },
      { id: 'dms', label: 'Direct messages', group: 'Talk', phase: 'S1', live: false },
      { id: 'calls', label: 'Calls', group: 'Meet', phase: 'S2', live: false },
      { id: 'rooms', label: 'Rooms', group: 'Meet', phase: 'S2', live: false },
      { id: 'contacts', label: 'Contacts', group: 'People', phase: 'S2', live: false },
      { id: 'teams', label: 'Teams', group: 'People', phase: 'S2', live: false },
      { id: 'recordings', label: 'Recordings', group: 'Library', phase: 'S2', live: false },
      { id: 'configuration', label: 'Configuration', group: 'System', phase: 'S2', live: false },
    ],
    empty: () => [],
  },
});

/** Surfaces, counted — a selector, never a stored number. */
export function socialSurfaceCounts(rows: SocialSurface[] = socialSurfaces.rows()): { total: number; live: number; pending: number } {
  const live = rows.filter((r) => r.live).length;
  return { total: rows.length, live, pending: rows.length - live };
}
