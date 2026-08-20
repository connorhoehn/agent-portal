// Feature flags for portal surfaces.
//
// NEWSROOM_ENABLED — the second tenant (articles/clusters/pitches). This is the
// multi-tenant demo surface, so it's ON by default now; set
// VITE_ENABLE_NEWSROOM=false to park it (e.g. before the synth corpus has
// populated its tables). The flag only controls the tenant switcher + nav +
// the /newsroom route tree; backend routes stay live regardless.
export const NEWSROOM_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_NEWSROOM !== 'false';
