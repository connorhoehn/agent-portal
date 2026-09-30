// Feature flags for portal surfaces.
//
// ASSESSMENT_ENABLED — the second tenant (engineering-maturity assessments).
// ON by default; set VITE_ENABLE_ASSESSMENT=false to park it. Only gates the
// tenant switcher + nav + the /assessment route tree; backend routes stay
// live regardless.
export const ASSESSMENT_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_ASSESSMENT !== 'false';

// SOCIAL_ENABLED — the third tenant (channels, DMs, calls, rooms; see
// docs/social-tenant-design.md §4). ON by default like the others; set
// VITE_ENABLE_SOCIAL=false to park its switcher tile, rail and /social tree.
export const SOCIAL_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_SOCIAL !== 'false';

// PIPELINES_ENABLED — the fourth tenant (definitions, runs, approvals; see
// docs/social-tenant-design.md §5). ON by default; set
// VITE_ENABLE_PIPELINES=false to park its tile, rail and /pipelines tree.
export const PIPELINES_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_PIPELINES !== 'false';

/** Whether a tenant's portal surfaces are switched on. orgiq always is. */
export function tenantEnabled(tenant: string): boolean {
  if (tenant === 'assessment') return ASSESSMENT_ENABLED;
  if (tenant === 'social') return SOCIAL_ENABLED;
  if (tenant === 'pipelines') return PIPELINES_ENABLED;
  return true;
}
