// The candidate's frame (UI round 2, lane GUEST; docs/interviews-tenant-plan.md decisions 3 and 21).
//
// A candidate has no account, so no staff shell: the page draws the library's `AppShell` itself with one thing in
// its header, the tenant's name the way the staff shell carries it (`AppBrand`, "Candidates"). No rails, no bell,
// no switcher, no search. Two bodies:
//   - `GuestStepFrame`: every step before and after the call (landing, your answers, camera and microphone,
//     waiting, held, ended, and the plain pages for a dead link) in ONE centred `PageFrame`, with the library's
//     `WorkflowStepper` over the four steps a candidate walks.
//   - `GuestShell` alone, full bleed, for the room (JoinRoom), whose stage and pane fill it.
import type { ReactNode } from 'react';
import { AppBrand, AppShell, PageFrame, Stack, WorkflowStepper } from '@connorhoehn/ui-components/shared';
import { TENANT_DISPLAY_NAMES } from '../../lib/tenants.generated.ts';
import { walkedSteps, type JoinStep } from './steps.ts';

/** The tenant's name, as the staff shell shows it ("Candidates"). */
export const GUEST_TENANT_NAME = TENANT_DISPLAY_NAMES.interviews;

/** The library's shell with the tenant's name in its header and nothing else of the staff chrome. */
export function GuestShell({ children, bleed = false }: { children: ReactNode; bleed?: boolean }) {
  return <AppShell layout="fill" contentPadding={bleed ? 'none' : 'md'} toastRegion={null}
    header={<AppBrand name={GUEST_TENANT_NAME} secondary="Interview" size="sm" aria-label={GUEST_TENANT_NAME} />}>
    {children}
  </AppShell>;
}

/**
 * One centred page frame for every step. `step` draws the strip (omit it for a page outside the walk, such as a
 * dead link); `fill` gives the body a fixed height whose columns scroll themselves (the answers page).
 */
export function GuestStepFrame({ title, description, step, fill = false, children }: {
  title: string; description?: string; step?: JoinStep; fill?: boolean; children: ReactNode;
}) {
  return <GuestShell>
    <PageFrame title={title} {...(description ? { description } : {})} body={fill ? 'fill' : 'scroll'}
      className="mx-auto w-full max-w-4xl" data-testid="join-page">
      <Stack gap="lg" className={fill ? 'min-h-0 flex-1' : undefined}>
        {step && <WorkflowStepper steps={walkedSteps(step)} aria-label="Your steps to the interview" data-testid="join-steps" />}
        {children}
      </Stack>
    </PageFrame>
  </GuestShell>;
}
