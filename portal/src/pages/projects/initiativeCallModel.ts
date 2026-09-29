// The initiative call, as data (docs/social-calls-plan.md step 5). The
// page-agnostic model moved to lib/conversationCallModel.ts when Search got
// its own Start call (step 6); this module keeps the initiative's names for
// it and adds the one initiative-only rule — who an initiative's call rings.

import {
  callAvailability,
  callTargets,
  uniquePeople,
  type CallAvailability,
  type CallPerson,
  type CallTarget,
  type CallTargets,
  type RosterUser,
} from '../../lib/conversationCallModel.ts';

export {
  initiativeCallChannel,
  initiativeFromChannel,
  lobbyPrefix,
  skippedNotice,
} from '../../lib/conversationCallModel.ts';
export type { CallAvailability, CallTarget, RosterUser };
export type InitiativeCallPerson = CallPerson;
export type InitiativeCallTargets = CallTargets;

/** The owner first, then SMEs; a person listed twice counts once. */
export function initiativeCallPeople(
  owner: InitiativeCallPerson | null,
  smes: InitiativeCallPerson[],
): InitiativeCallPerson[] {
  return uniquePeople([...(owner ? [owner] : []), ...smes]);
}

export const initiativeCallTargets = callTargets;

export function initiativeCallAvailability(input: Omit<Parameters<typeof callAvailability>[0], 'nobodyReason'>): CallAvailability {
  return callAvailability({ ...input, nobodyReason: 'Nobody else on this initiative has an OrgIQ sign-in to call' });
}
