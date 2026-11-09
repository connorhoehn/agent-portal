// A tenant switch ends the voice session (spec §2), and it reloads the page
// (lib/auth.tsx enterContext), so the dock would otherwise close as a
// `beforeunload` drop and offer a resume in the next workspace (G44, session
// vs_16ca8e51). The switch announces itself first; the voice pane closes the
// session as `tenant-switch`, which is never resumable.

export const TENANT_SWITCH_EVENT = 'voice:tenant-switch';

/** Called by the tenant switch before it changes the cookie and reloads. */
export function announceTenantSwitch(tenant: string): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try { window.dispatchEvent(new CustomEvent(TENANT_SWITCH_EVENT, { detail: { tenant } })); } catch { /* nothing listens */ }
}
