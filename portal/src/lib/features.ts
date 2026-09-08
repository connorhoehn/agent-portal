// Feature flags for portal surfaces.
//
// ASSESSMENT_ENABLED — the second tenant (engineering-maturity assessments).
// ON by default; set VITE_ENABLE_ASSESSMENT=false to park it. Only gates the
// tenant switcher + nav + the /assessment route tree; backend routes stay
// live regardless.
export const ASSESSMENT_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_ASSESSMENT !== 'false';
