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
import { tenantEnabled } from './features.ts';
import { TENANT_HOME as MANIFEST_TENANT_HOME } from './tenants.generated.ts';
import type { Session } from './auth';

/** A tenant's landing route — the front door of that product. Each is the
 *  manifest's `home` (tenants/manifest.json, DE-29): orgiq lands on Plan's
 *  program wall (not the Automate loop, legitimately all-zeros on a quiet
 *  morning), social on the conversation (design §4.1), pipelines on the run
 *  ledger (§5.3), access on a person's own requests (access design §6). */
export const TENANT_HOME: Record<string, string> = { ...MANIFEST_TENANT_HOME };

/** Where a role lands when its tenant has a home per role (docs/interviews-tenant-plan.md
 *  "Pages"): the interviews tenant's front door is the recruiter's Candidates, and
 *  its interviewer and hiring manager each land on their own desk instead. A role
 *  not listed lands on its tenant's home. */
export const ROLE_HOME: Record<string, Record<string, string>> = {
  interviews: { interviewer: '/interviews/my-interviews', 'hiring-manager': '/interviews/my-openings' },
};

/** The home of this role in this tenant: its own desk where it has one, else the tenant's front door. */
export function roleHome(tenant: string, role: string | undefined): string {
  return (role && ROLE_HOME[tenant]?.[role]) || tenantHome(tenant);
}

/** The workspace chooser. Where an identity goes when no single home fits. */
export const CHOOSER = '/workspaces';

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
  // A parked tenant (its VITE_ENABLE_* flag off) offers no usable workspace.
  const usable = contextCount(Object.fromEntries(
    Object.entries(session.grants ?? {}).filter(([t]) => tenantEnabled(t)),
  ));
  if (usable === 0) return CHOOSER;
  if (usable > 1 && !session.masquerading && !hasChosenContext(session.sub ?? '')) return CHOOSER;
  if (!tenantEnabled(session.tenant)) return TENANT_HOME.orgiq;
  return TENANT_HOME[session.tenant] ? roleHome(session.tenant, session.role) : CHOOSER;
}

/** The tenant's front door, ignoring the chooser step. Used by the tenant
 *  switch, which has already chosen and is mid-navigation into that tenant. */
export function tenantHome(tenant: string): string {
  return TENANT_HOME[tenant] ?? CHOOSER;
}
