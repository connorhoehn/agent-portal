// G58: held-but-inactive roles. A login lands on the least-privileged role it
// holds, by design (middleware lib/session.ts `landingRole`). A viewer whose
// session also holds a higher grant in this tenant (`switchable[tenant]`, e.g.
// Sienna Garcia: orgiq org-leader + member, lands as member) used to meet a
// locked control with no hint. Where a page refuses a write this role cannot
// make (a decision waiting on someone else, the Docs tab's New), it offers the
// switch the header's role menu already makes (POST /api/session/role), named
// for what it unlocks. Nothing when no such grant is held, or when the viewer
// already acts as it. Presentation only: the route decides after the switch.
//
// No React — node:test runs it.

/** The roles worth switching to for a refused write, most specific first. */
export const ESCALATION_ROLES = ['org-leader', 'admin'] as const;

export interface RoleSwitchOffer {
  role: (typeof ESCALATION_ROLES)[number];
  /** The button: "Switch to org-leader to decide". */
  label: string;
}

/**
 * The switch to offer, or null. `purpose` finishes the label ("decide",
 * "add files"). A viewer acting as admin is offered nothing; one acting as
 * org-leader is offered admin only.
 */
export function roleSwitchOffer(
  session: { role: string; tenant: string; switchable?: Readonly<Record<string, readonly string[]>> | null } | null | undefined,
  purpose: string,
): RoleSwitchOffer | null {
  if (!session) return null;
  const held = session.switchable?.[session.tenant] ?? [];
  const acting = (ESCALATION_ROLES as readonly string[]).indexOf(session.role);
  const role = ESCALATION_ROLES.find((r, i) => i > acting && held.includes(r));
  return role ? { role, label: `Switch to ${role} to ${purpose}` } : null;
}
