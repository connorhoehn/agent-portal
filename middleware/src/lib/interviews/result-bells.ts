// The bells after the call (docs/interviews-tenant-plan.md row I5.6: scorecard due, submitted, decided; contract E4).
//
//   interviewEnded(interviewId)                       → each seat of the round: "your scorecard is due", opening My interviews
//   scorecardSubmitted(interviewId, authorId, version) → the opening's recruiter ("submitted", or "corrected" for a later
//                                                       version), and the opening's hiring manager once every seat's
//                                                       first version is in; each opens the debrief
//   stageDecided(applicationId, deciderId)            → the opening's recruiter: "a decision was recorded", opening the debrief
//
// The integrator adds the two calling lines (this lane edits neither route file):
//   routes/interviews/scorecards.ts, after `await scoreIfComplete(i.id);`:   void scorecardSubmitted(i.id, session.sub, row.version);
//   routes/interviews/room.ts, where an end succeeds:                         void interviewEnded(<the interview's id>);
// (with `import { interviewEnded, scorecardSubmitted } from '../../lib/interviews/result-bells.js';`). The third is called
// by routes/interviews/debrief.ts itself. Each never throws and logs nothing of the interview.
import { runWithDbTenant } from '../../providers/db-tenant.js';
import { notifyInterviewDecided, notifyInterviewScorecardDue, notifyInterviewScorecardIn } from '../social-notify.js';
import { seatedOf } from './scorecard.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview, type InterviewsWorld, type Opening } from './types.js';

const load = (): Promise<InterviewsWorld> => runWithDbTenant(INTERVIEWS_TENANT, () => loadWorld(interviewsStore()));

function roundOf(world: InterviewsWorld, interviewId: string): { interview: Interview; opening: Opening; roundName: string } | null {
  const interview = world.interviews.find((i) => i.id === interviewId);
  const application = interview && world.applications.find((a) => a.id === interview.applicationId);
  const opening = application && world.openings.find((o) => o.id === application.openingId);
  if (!interview || !opening) return null;
  return { interview, opening, roundName: opening.kit.rounds.find((r) => r.id === interview.roundId)?.name ?? 'A round' };
}

/** A round ended: tell each seat their scorecard is due. */
export async function interviewEnded(interviewId: string): Promise<string[]> {
  try {
    const found = roundOf(await load(), interviewId);
    if (!found || found.interview.state !== 'ended') return [];
    return await notifyInterviewScorecardDue({
      interviewId, openingTitle: found.opening.title, roundName: found.roundName, userIds: seatedOf(found.interview),
    });
  } catch {
    return [];
  }
}

/** A scorecard version was stored: tell the recruiter, and the hiring manager when the last seat's first version is in. */
export async function scorecardSubmitted(interviewId: string, authorId: string, version: number): Promise<string[]> {
  try {
    const world = await load();
    const found = roundOf(world, interviewId);
    if (!found) return [];
    const { interview, opening, roundName } = found;
    const authors = new Set(world.scorecards.filter((s) => s.interviewId === interviewId).map((s) => s.interviewerId));
    if (!authors.has(authorId)) return [];
    const corrected = version > 1;
    const allIn = !corrected && seatedOf(interview).every((p) => authors.has(p));
    return await notifyInterviewScorecardIn({
      interviewId, openingTitle: opening.title, roundName, authorId, recruiterId: opening.recruiterId, corrected,
      allInTo: allIn ? opening.hiringManagerId : null,
    });
  } catch {
    return [];
  }
}

/** The hiring manager recorded a decision on an application: tell the opening's recruiter. */
export async function stageDecided(applicationId: string, deciderId: string): Promise<string[]> {
  try {
    const world = await load();
    const application = world.applications.find((a) => a.id === applicationId);
    const opening = application && world.openings.find((o) => o.id === application.openingId);
    if (!application || !opening) return [];
    // The bell opens the debrief through a round, so it stores no candidate id: the latest round that was held.
    const held = world.interviews.filter((i) => i.applicationId === applicationId && ['ended', 'scored', 'reviewed'].includes(i.state))
      .sort((a, b) => (b.endedAt ?? b.scheduledAt ?? '').localeCompare(a.endedAt ?? a.scheduledAt ?? ''));
    const round = held[0] ?? world.interviews.find((i) => i.applicationId === applicationId);
    if (!round) return [];
    return await notifyInterviewDecided({ interviewId: round.id, applicationId, openingTitle: opening.title, recruiterId: opening.recruiterId, deciderId });
  } catch {
    return [];
  }
}
