// Where does this identity belong? — one answer, for everybody who asks.
//
// There used to be three, and they drifted: `/` sent an orgiq user to
// /iq/projects, `enterContext` sent them to /iq/work, NotFoundPage's "back to
// home" link sent them somewhere else again, and the route guards in App.tsx
// answered with a hardcoded /iq/projects — *including the guards on the /iq
// and /admin trees themselves*, so an assessment role who typed an orgiq URL
// was redirected into the very tree that had just refused them. The guard
// denied, the fallback re-entered, the guard denied again: the URL never
// moved and the page painted empty under the other product's breadcrumb.
// (docs/assessment-journeys/isolation/DEFECTS.md #1.)
//
// So: this module is the only place that names a home route. Import it;
// do not write a fourth answer.

// Explicit .ts extensions: this module is covered by a plain `node --test`
// unit test (__tests__/tenantHome.test.ts) and node's ESM resolver does not
// guess extensions. Vite and tsc both resolve them fine.
import { contextCount, hasChosenContext } from './contextChoice.ts';
import { ASSESSMENT_ENABLED } from './features.ts';
import type { Session } from './auth';

/** A tenant's landing route — the front door of that product. */
export const TENANT_HOME: Record<string, string> = {
  // Plan's front door (the program wall), not the Automate loop: a person's
  // first screen should be the work of the org, not an ops queue that is
  // legitimately all-zeros on a quiet morning.
  orgiq: '/iq/projects',
  assessment: '/assessment/teams',
};

/** The workspace chooser. Where an identity goes when no single home fits. */
export const CHOOSER = '/select';

/**
 * Resolve the route this session should land on.
 *
 * - No session at all → the chooser (which is also the sign-in surface).
 * - No usable workspace → the chooser, which explains the empty roster;
 *   there is no product page that would mean anything to this identity.
 * - More than one workspace and no pick made this session → the chooser
 *   (AWS-style). Masqueraders skip it: the operator already chose who to
 *   view as, and bouncing them to the picker would undo that.
 * - Otherwise → the front door of the tenant the session is standing in.
 *   A cross-tenant `admin` is not special here: `session.tenant` is whichever
 *   workspace they entered, and that workspace's home is the right answer.
 */
export function resolveHome(session: Session | null): string {
  if (!session) return CHOOSER;
  const usable = ASSESSMENT_ENABLED
    ? contextCount(session.grants)
    : contextCount(Object.fromEntries(
        Object.entries(session.grants ?? {}).filter(([t]) => t !== 'assessment'),
      ));
  if (usable === 0) return CHOOSER;
  if (usable > 1 && !session.masquerading && !hasChosenContext(session.sub ?? '')) return CHOOSER;
  if (session.tenant === 'assessment' && !ASSESSMENT_ENABLED) return TENANT_HOME.orgiq;
  return TENANT_HOME[session.tenant] ?? CHOOSER;
}

/** The tenant's front door, ignoring the chooser step. Used by the tenant
 *  switch, which has already chosen and is mid-navigation into that tenant. */
export function tenantHome(tenant: string): string {
  return TENANT_HOME[tenant] ?? CHOOSER;
}
