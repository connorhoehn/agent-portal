// The candidate's frame (UI round 2, lane GUEST; docs/interviews-tenant-plan.md decisions 3 and 21).
//
// A candidate has no account, so no staff shell: the page draws the library's `AppShell` itself with one thing in
// its header, the interview it is for (`AppBrand`, "Senior Backend Engineer interview"; "Interview" before the page
// knows the role). Never the staff tenant's name, "Candidates" (E4 #31). No rails, no bell, no switcher, no search.
// Two bodies:
//   - `GuestStepFrame`: every step before and after the call (landing, your answers, camera and microphone,
//     waiting, held, ended, and the plain pages for a dead link) in ONE centred `PageFrame`, with the library's
//     `WorkflowStepper` over the four steps a candidate walks.
//   - `GuestShell` alone, full bleed, for the room (JoinRoom), whose stage and pane fill it.
//
// UI round 3 (lane ROOM-2): the steps sit on the library's centred column (`PageFrame column="centered"`), and the
// guest's pages carry the Candidates tenant's accent the way the staff shell does: the tenant is written on the
// document root (components/shell/Layout.tsx does the same), so the shell, its buttons and tabs, and anything the
// library draws in a portal (tooltips, menus) read the tenant's tokens (app.css `[data-tenant="interviews"]`).
import { useEffect, type ReactNode } from 'react';
import { AppBrand, AppShell, PageFrame, Stack, WorkflowStepper } from '@connorhoehn/ui-components/shared';
import { walkedSteps, type JoinStep } from './steps.ts';

/** The header's name: the role's interview, or "Interview" while the page does not know the role yet. */
export const guestBrandName = (role?: string | null): string => (role?.trim() ? `${role.trim()} interview` : 'Interview');
/** The tenant id the theme reads (`data-tenant`). */
export const GUEST_TENANT_ID = 'interviews';

/** The tenant's accent on the document root while a guest page is mounted; the earlier value comes back after. */
function useGuestTenantTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    const before = root.getAttribute('data-tenant');
    root.setAttribute('data-tenant', GUEST_TENANT_ID);
    return () => { if (before === null) root.removeAttribute('data-tenant'); else root.setAttribute('data-tenant', before); };
  }, []);
}

/** The library's shell with the interview's name in its header and nothing else of the staff chrome. `role`: the opening's title. */
export function GuestShell({ children, bleed = false, role }: { children: ReactNode; bleed?: boolean; role?: string | null }) {
  useGuestTenantTheme();
  const name = guestBrandName(role);
  return <AppShell layout="fill" contentPadding={bleed ? 'none' : 'md'} toastRegion={null}
    header={<AppBrand name={name} size="sm" aria-label={name} />}>
    {children}
  </AppShell>;
}

/**
 * One centred page frame for every step. `step` draws the strip (omit it for a page outside the walk: a dead link, and
 * the ended page, whose steps are all behind it, E4 #36); `fill` gives the body a fixed height whose columns scroll
 * themselves (the answers page). `role` names the interview in the header.
 */
export function GuestStepFrame({ title, description, step, fill = false, role, children }: {
  title: string; description?: string; step?: JoinStep; fill?: boolean; role?: string | null; children: ReactNode;
}) {
  return <GuestShell role={role ?? null}>
    <PageFrame title={title} {...(description ? { description } : {})} body={fill ? 'fill' : 'scroll'}
      column="centered" columnWidth="4xl" data-testid="join-page">
      <Stack gap="lg" className={fill ? 'min-h-0 flex-1' : undefined}>
        {step && <WorkflowStepper currentTone="primary" steps={walkedSteps(step)} aria-label="Your steps to the interview" data-testid="join-steps" />}
        {children}
      </Stack>
    </PageFrame>
  </GuestShell>;
}
