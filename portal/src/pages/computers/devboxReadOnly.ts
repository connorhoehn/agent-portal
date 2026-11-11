// The Computer Lab for a viewer who can see the fleet but not drive it (UX walk, 9 November 2026): the
// org-leader's Nudge bar sent its task and met a 403 under a banner saying it could not. No React — node:test runs it.

/** What a viewer without the driving capabilities is told — the banner and a refused Nudge say the same. */
export const READ_ONLY_REASON = 'You can see the fleet but not drive it. Opening a shell or dispatching work needs computer access, which an SME or a platform operator can grant.';

/**
 * The Nudge bar for a read-only viewer (ComputerLab `onInstruct`): refused in place, never sent —
 * POST /api/devbox/:id/task (RunDevboxTask) would answer 403. The library keeps the typed text for a retry.
 */
export async function refuseInstruction(): Promise<never> {
  throw new Error(READ_ONLY_REASON);
}
