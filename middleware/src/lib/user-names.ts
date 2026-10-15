// A session subject printed as a person.
//
// Audit rows, traffic tables and approval notes store the SUBJECT that acted
// (`u-vera`, or a dev:mock clone's `u-vera-clone-504ccd4a`); a page that prints
// it shows a peer an account id where a name belongs (docs/demo-content-goal.md
// rubric d). Resolve it here, once: a live clone prints its persona's name
// (`recordUserId`, the same rule that keys the persona's records), a seeded user
// its display name, anything else null so the caller keeps the raw subject
// rather than inventing one. Synchronous and fallback-only, like
// `displayNameForSubject` it wraps: the Aurora paths do not resolve here.

import { displayNameForSubject } from '../providers/identity.js';
import { recordUserId } from './record-owner.js';

export function userNameFor(subject: string | null | undefined): string | null {
  if (!subject) return null;
  return displayNameForSubject(recordUserId(subject)) ?? displayNameForSubject(subject);
}
