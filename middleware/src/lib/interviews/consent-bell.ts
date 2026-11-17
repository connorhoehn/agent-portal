// The recruiter is told when a round runs without a part (docs/interviews-tenant-plan.md decision 5, row I2.5): a bell to the
// recruiter who owns the opening when the candidate's answers are first complete with a part off, and again only when the set
// of parts that are off changes (including back to nothing off, so a replacement can be called off). The bell names the
// opening, the round and the parts, never the candidate (lib/social-notify.ts `notifyInterviewConsentOff`).
//
// Called from the candidate's consent write with one line the integrator adds to routes/interview-invite-consents.ts, after
// the `if (!result.ok) { … }` block of PUT /consents and before `res.json(...)`:
//
//     void consentsSaved(interview.id, before, result.row);
//
// (with `import { consentsSaved } from '../lib/interviews/consent-bell.js';`). Never throws, never logs an answer.
import { runWithDbTenant } from '../../providers/db-tenant.js';
import { notifyInterviewConsentOff } from '../social-notify.js';
import { partsOffOf, type ConsentAnswersIn, type OffPart } from './consent/effects.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT } from './types.js';

const WORDS: Record<OffPart, string> = { recording: 'no recording', transcription: 'no transcript', milo: 'no Milo' };

/** What is off, in plain words: "no recording, no Milo"; empty when nothing is. */
export function offLabel(off: readonly OffPart[]): string {
  return off.map((p) => WORDS[p]).join(', ');
}

/** The parts off after a write when the recruiter must be told (first complete with a part off, or a changed set), else null. */
export function consentBellChange(before: ConsentAnswersIn | null, after: ConsentAnswersIn): OffPart[] | null {
  const now = partsOffOf(after);
  if (!before) return now.length ? now : null;
  const was = partsOffOf(before);
  return was.length === now.length && was.every((p, i) => p === now[i]) ? null : now;
}

/** The hook: ring the opening's recruiter if this write changed what the round runs without. */
export async function consentsSaved(interviewId: string, before: ConsentAnswersIn | null, after: ConsentAnswersIn): Promise<string[]> {
  try {
    const off = consentBellChange(before, after);
    if (!off) return [];
    const world = await runWithDbTenant(INTERVIEWS_TENANT, () => loadWorld(interviewsStore()));
    const interview = world.interviews.find((i) => i.id === interviewId);
    const application = interview && world.applications.find((a) => a.id === interview.applicationId);
    const opening = application && world.openings.find((o) => o.id === application.openingId);
    if (!interview || !opening) return [];
    const roundName = opening.kit.rounds.find((r) => r.id === interview.roundId)?.name ?? 'A round';
    return await notifyInterviewConsentOff({ interviewId, openingTitle: opening.title, roundName, recruiterId: opening.recruiterId, offLabel: offLabel(off) });
  } catch {
    return [];
  }
}
