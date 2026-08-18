// Feature flags for portal surfaces.
//
// NEWSROOM_ENABLED — the newsroom demo tenant (articles/clusters/pitches) is
// parked until the synth corpus pipeline populates its tables. Backend routes
// and portal pages stay in the tree; this flag only removes the surface from
// the tenant switcher and nav. Re-enable with VITE_ENABLE_NEWSROOM=true.
export const NEWSROOM_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_NEWSROOM === 'true';
