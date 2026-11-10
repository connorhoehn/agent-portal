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

// ─── Once per page for the demo identity (UX leftovers, 10 November) ─────────
//
// The cookie-less demo identity's `switchable` is every role in every tenant
// (middleware `switchableGrants`), so every locked control on a page offered
// "Switch to <role>". On in-page controls the offer now appears once per page:
// the first locked control to claim it carries the switch, the others give their
// plain reason. A real persona's switch is a grant it really holds, so every
// locked control keeps offering it. The no-access page is not an in-page control
// and does not use this.

/** The cookie-less demo identity's subject (middleware lib/session.ts `DEMO_SUB`). */
export const DEMO_SUB = 'demo-user';

/** Whether the session's `switchable` is the permissive demo set rather than real grants. */
export function permissiveSwitchable(session: { sub?: string | null } | null | undefined): boolean {
  return session?.sub === DEMO_SUB;
}

/** Whether `control` carries the offer, given the page's claimants in claim order. */
export function offerOnThisControl(
  session: { sub?: string | null } | null | undefined,
  claimants: readonly string[],
  control: string,
): boolean {
  if (!permissiveSwitchable(session)) return true;
  return claimants[0] === control;
}

/**
 * The page's claim list: each locked control that would offer a switch claims a
 * slot under the page's path while it is mounted. Snapshots are stable arrays
 * (a new one only when the list changes), as `useSyncExternalStore` needs.
 */
export class SwitchOfferSlots {
  private pages = new Map<string, readonly string[]>();
  private listeners = new Set<() => void>();
  private static readonly NONE: readonly string[] = Object.freeze([]);

  claimants(page: string): readonly string[] {
    return this.pages.get(page) ?? SwitchOfferSlots.NONE;
  }

  claim(page: string, control: string): void {
    const now = this.claimants(page);
    if (now.includes(control)) return;
    this.pages.set(page, Object.freeze([...now, control]));
    this.emit();
  }

  release(page: string, control: string): void {
    const now = this.claimants(page);
    if (!now.includes(control)) return;
    const next = now.filter((c) => c !== control);
    if (next.length) this.pages.set(page, Object.freeze(next)); else this.pages.delete(page);
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
