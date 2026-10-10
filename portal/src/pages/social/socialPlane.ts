// Where the Social chat workspace reads and links (docs/social-tenant-design.md
// §4.6 "Communication"). In the Social tenant it is `/api/social` and
// `/social/*`. Embedded as another tenant's Communication page it is the
// grant-gated plane router (`/api/social/plane`, the SAME handlers behind the
// caller's current Social grants) and that page's own routes, so the session
// never leaves its tenant. One composition, two mounts — never a copy.
import { createContext, useContext } from 'react';

export interface SocialPlane {
  /** The BFF prefix every Social read and write goes to. */
  api: string;
  /** The portal prefix the workspace's destinations live under (`/social`, `/iq/communication`). */
  route: string;
  /** Embedded in another tenant: Social capabilities come from the plane, not the session's tenant. */
  embedded: boolean;
}

export const SOCIAL_TENANT_PLANE: SocialPlane = { api: '/api/social', route: '/social', embedded: false };
export const SocialPlaneContext = createContext<SocialPlane>(SOCIAL_TENANT_PLANE);
export const useSocialPlane = (): SocialPlane => useContext(SocialPlaneContext);

/** The plane's API for a session standing in another tenant, under `route`. */
export function embeddedPlane(route: string): SocialPlane {
  return { api: '/api/social/plane', route, embedded: true };
}
