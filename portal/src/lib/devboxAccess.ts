// Who can open Computer Lab, in one place.
//
// This predicate had started to multiply: DevboxPage carried FLEET_READ_ROLES,
// App.tsx a RequireRole, Layout.tsx a rail `requireRoles`, portalCommands.ts a
// DEVBOX const — four spellings of one rule, and
// scripts/validate-nav-parity.sh exists because three of them had already
// drifted apart (org-leader, the role devbox-visibility.ts treats as
// FLEET_WIDE, could not open the page at all). The nav gates have to stay
// literal for the validator to read them statically, but nothing else does, so
// anything asking the question at RUNTIME asks it here.

/** Roles the server lets read the fleet without `ManageDevbox` — mirrors the
 *  `/api/devbox` mount in `middleware/src/index.ts`. Keep the two in step: a
 *  wider list here is a door onto a 403, a narrower one hides real access. */
export const FLEET_READ_ROLES = ['org-leader', 'hr-admin', 'program-owner', 'admin'];

/**
 * Whether this session can open Computer Lab at all.
 *
 * Reading the fleet and driving it are different rights: `ManageDevbox` is the
 * write capability, and the roles above get a read-only view without it.
 */
export function canOpenComputerLab(
  hasManageDevbox: boolean,
  role: string | null | undefined,
): boolean {
  return hasManageDevbox || FLEET_READ_ROLES.includes(role ?? '');
}

/** Where "Open Computer Lab" should actually land for this session. */
export const COMPUTER_LAB_PATH = '/admin/devbox';
export const LOCAL_COMPUTE_PATH = '/iq/local-compute';
