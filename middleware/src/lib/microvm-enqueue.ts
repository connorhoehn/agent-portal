// Which runner a queued job takes (docs/microvm-runner-design.md §4, §5, §9, §14 step 3).
//
// Decided at enqueue, once, from the initiative's devbox profile — never from
// the caller: `network_class = 'egress-allowlist'` → 'microvm', anything else
// → 'fleet'. Every enqueue path goes through providers/agent-jobs.ts
// `enqueueJob`, which calls this, so a route, a bot firing or a marketplace
// dispatch on a restricted initiative cannot put its work on the public fleet.
//
// Fails closed. The profile is read through the provider directly rather than
// `profileForInitiative`, whose store-outage fallback is the in-code `default`
// (public): right for a box's lifetime, wrong here, where it would quietly move
// a restricted initiative's work onto the fleet. A read that throws fails the
// enqueue instead.
//
// A job with no initiative keeps the fleet: there is no profile to name.

import { ValidationError } from './async-handler.js';
import type { JobRunner } from '../providers/agent-jobs.js';

/** The payload fields the microVM runner refuses (§4): its resume is §9's, and it has no box. */
export const MICROVM_REFUSED_PAYLOAD = ['resume', 'boxId'] as const;

export async function resolveJobRunner(input: {
  kind: string;
  payload: Record<string, unknown>;
  resumeOfJobId?: string | null;
}): Promise<JobRunner> {
  const initiative = typeof input.payload['initiativeId'] === 'string' && input.payload['initiativeId'].trim()
    ? input.payload['initiativeId'].trim() : null;
  let runner: JobRunner = 'fleet';
  if (input.kind === 'devbox:task' && initiative) {
    const p = await import('../providers/devbox-profiles.js');
    const id = (await p.initiativeProfileId(initiative)) ?? 'default';
    const profile = await p.latestProfile(id);
    if (profile?.network_class === 'egress-allowlist') runner = 'microvm';
  }
  if (runner === 'microvm') {
    for (const field of MICROVM_REFUSED_PAYLOAD) {
      if (field in input.payload) {
        throw new ValidationError(`${field} is not accepted for microVM work: this initiative's profile runs each job in a fresh session (resume with resumeOfJobId)`);
      }
    }
  } else if (input.resumeOfJobId) {
    throw new ValidationError('resumeOfJobId is only accepted for microVM work (an egress-allowlist profile)');
  }
  return runner;
}
