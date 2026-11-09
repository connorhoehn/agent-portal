// Feature flags for portal surfaces.

import { TENANT_MANIFEST } from './tenants.generated.ts';
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

// ACCESS_ENABLED — the fifth tenant (access requests, approvals and governance;
// see docs/access-tenant-design.md). ON by default; set VITE_ENABLE_ACCESS=false
// to park its tile, rail and /access tree.
export const ACCESS_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_ENABLE_ACCESS !== 'false';

/**
 * VOICE_NAVIGATOR — the voice dock in the footer (docs/voice-navigator-spec.md
 * §5, §8). `VITE_VOICE_NAVIGATOR=1|true` turns it on, `0|false` off; unset it
 * follows the build: on under the dev server, off in a production bundle.
 * The dock also needs can('VoiceNavigate'), so a role without the grant never
 * sees it either way.
 */
export function voiceNavigatorEnabled(env: Record<string, unknown> | undefined): boolean {
  const raw = String(env?.['VITE_VOICE_NAVIGATOR'] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return env?.['DEV'] === true;
}

const VOICE_NAVIGATOR = voiceNavigatorEnabled((import.meta as unknown as { env?: Record<string, unknown> }).env);

export const features = {
  voiceNavigator: VOICE_NAVIGATOR,
  /** System › Logging (/iq/logging, G37; was the Voice log): the dev server with the voice navigator on — the route, its rail item and the dock's log control. */
  voiceLog: (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true && VOICE_NAVIGATOR,
} as const;

/** Whether a tenant's portal surfaces are switched on: its manifest
 *  `featureFlag` (tenants/manifest.json) is not 'false'. A tenant without a
 *  flag (orgiq) or an unknown id always is. */
export function tenantEnabled(tenant: string): boolean {
  const flag = (TENANT_MANIFEST as Record<string, { featureFlag: string | null }>)[tenant]?.featureFlag;
  if (!flag) return true;
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[flag] !== 'false';
}
