// The waiting candidate, told to the seats (gap audit 2026-11-20 §4). Three things the knock alone did not do:
//
//   the bell       the first knock of a waiting spell rings every seat of the round (the lead and the panel) with the
//                  tenant's bell (lib/social-notify.ts notifyInterviewWaiting), opening the room. A repeat knock, a
//                  reconnect or a page refresh is the same spell and rings nothing; a new spell (the link opened again,
//                  or a knock after being turned away) rings afresh. The bells are resolved when the spell is over: the
//                  candidate let in or turned away (routes/interviews/admission.ts), the round ended or cancelled
//                  (routes/interviews/room.ts closeRoom).
//   who is here    the seats in the round's call NOW, from the call store's lobby index and each seat's verified socket
//                  context (lib/call-chat.ts usersInLobbyCall). Never a client's claim.
//   who may admit  the lead, as before; and a panel member who is in the call while the lead is not. Turning the
//                  candidate away stays the lead's.
//
// `told` (what the candidate's waiting page reads): the candidate is waiting and either a bell went to at least one seat
// for this spell or a seat is in the call. One boolean; nothing about who.

import { runWithDbTenant } from '../../providers/db-tenant.js';
import { notificationInbox, notifyInterviewWaiting, resolveInterviewWaiting, waitingBellId } from '../social-notify.js';
import { CALL_STATES, interviewLobbyName } from './lobby.js';
import { seatedOf } from './scorecard.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview, type Seat } from './types.js';
import type { Admission } from './invite/admission.js';

// ── Who is in the call ───────────────────────────────────────────────────────

/** The user ids in a lobby's live call now. */
export type RoomPresenceReader = (lobbyName: string) => Promise<string[]>;

const fromCallStore: RoomPresenceReader = async (lobbyName) => {
  const { callChatRuntime } = await import('../call-chat.js');
  return callChatRuntime().usersInLobbyCall(lobbyName);
};
let reader: RoomPresenceReader = fromCallStore;
/** For tests: who the call store says is in a lobby's call. Null puts the call store back. */
export function setRoomPresenceReader(fn: RoomPresenceReader | null): void { reader = fn ?? fromCallStore; }

/** Which of the round's seats are in its call now. No gateway, or any failed read: nobody. */
export async function seatsInRoom(interview: Pick<Interview, 'id' | 'leadId' | 'panelIds'>): Promise<{ lead: boolean; panel: Set<string> }> {
  let here: string[] = [];
  try { here = await reader(interviewLobbyName(interview.id)); } catch { here = []; }
  const set = new Set(here);
  return { lead: set.has(interview.leadId), panel: new Set(interview.panelIds.filter((p) => set.has(p))) };
}

// ── Who may admit, pure ──────────────────────────────────────────────────────

export type AdmitRefusal = 'lead-only' | 'lead-here' | 'not-in-call';

export const ADMIT_REFUSAL: Record<AdmitRefusal, string> = {
  'lead-only': 'Only the lead can turn the candidate away.',
  'lead-here': 'The lead is in the call, so the lead lets the candidate in.',
  'not-in-call': 'Join the call first. A panel member can let the candidate in from the call while the lead is not in it.',
};

/** May this seat answer the knock (`admit`: let in, else turn away), given who is in the call? */
export function admitAuthority(seat: Seat, admit: boolean, here: { lead: boolean; self: boolean }): true | AdmitRefusal {
  if (seat === 'lead') return true;
  if (!admit) return 'lead-only';
  if (here.lead) return 'lead-here';
  return here.self ? true : 'not-in-call';
}

/** The room's `mayAdmit`: whether this seat may let the candidate in now. */
export async function mayAdmitNow(interview: Pick<Interview, 'id' | 'leadId' | 'panelIds'>, seat: Seat | null, userId: string): Promise<boolean> {
  if (!seat) return false;
  if (seat === 'lead') return true;
  const here = await seatsInRoom(interview);
  return admitAuthority(seat, true, { lead: here.lead, self: here.panel.has(userId) }) === true;
}

// ── The bell ─────────────────────────────────────────────────────────────────

/** Spells (round and knock instant) whose bell reached at least one seat. Bounded; a restart falls back to the inbox. */
const toldSpells = new Set<string>();
const TOLD_MAX = 5000;
const spellKey = (interviewId: string, knockedAt: string): string => `${interviewId}\n${knockedAt}`;
function markTold(key: string): void {
  toldSpells.add(key);
  if (toldSpells.size > TOLD_MAX) toldSpells.delete(toldSpells.values().next().value as string);
}
/** For tests. */
export function resetWaitingRoom(): void { toldSpells.clear(); }

const findInterview = (interviewId: string): Promise<Interview | null> =>
  runWithDbTenant(INTERVIEWS_TENANT, () => interviewsStore().getInterview(interviewId));

async function roundTitles(interview: Interview): Promise<{ openingTitle: string; roundName: string } | null> {
  return runWithDbTenant(INTERVIEWS_TENANT, async () => {
    const store = interviewsStore();
    const [applications, openings] = await Promise.all([store.listApplications(), store.listOpenings()]);
    const application = applications.find((a) => a.id === interview.applicationId);
    const opening = application ? openings.find((o) => o.id === application.openingId) : undefined;
    if (!opening) return null;
    return { openingTitle: opening.title, roundName: opening.kit.rounds.find((r) => r.id === interview.roundId)?.name ?? 'A round' };
  });
}

/**
 * A new waiting spell began (a knock that really changed the admission): ring each seat once. Resolves to who was
 * rung; never throws. The knock's route awaits it, so its own answer can say the seats were told.
 */
export async function ringWaiting(interviewId: string, knockedAt: string | null): Promise<string[]> {
  try {
    if (!knockedAt) return [];
    const interview = await findInterview(interviewId);
    if (!interview || !CALL_STATES.includes(interview.state)) return [];
    const titles = await roundTitles(interview);
    if (!titles) return [];
    // One waiting bell per seat at a time: an earlier spell's (the link opened again) leaves first.
    await resolveInterviewWaiting(interviewId, seatedOf(interview), null);
    const sent = await notifyInterviewWaiting({ interviewId, ...titles, userIds: seatedOf(interview), knockedAt });
    if (sent.length) markTold(spellKey(interviewId, knockedAt));
    return sent;
  } catch {
    return [];
  }
}

/** The spell is over (let in, turned away, the round closed): its bells leave the seats' inboxes. Never throws. */
export async function resolveWaiting(interviewId: string, knockedAt: string | null): Promise<void> {
  try {
    const interview = await findInterview(interviewId);
    if (!interview) return;
    await resolveInterviewWaiting(interviewId, seatedOf(interview), knockedAt);
  } catch { /* the bell stays; the room shows the truth */ }
}

/** Has the waiting candidate been told the seats know: a bell went out for this spell, or a seat is in the call? */
export async function waitingTold(interviewId: string, admission: Admission): Promise<boolean> {
  try {
    if (admission.state !== 'waiting' || !admission.knockedAt) return false;
    const key = spellKey(interviewId, admission.knockedAt);
    if (toldSpells.has(key)) return true;
    const interview = await findInterview(interviewId);
    if (!interview) return false;
    const here = await seatsInRoom(interview);
    if (here.lead || here.panel.size) return true;
    // After a restart the memory is gone: the bell's own id in a seat's inbox says it was rung.
    const inbox = notificationInbox();
    if (!inbox) return false;
    for (const userId of seatedOf(interview)) {
      if ((await inbox.listForUser(userId).catch(() => [])).some((r) => r.id === waitingBellId(interviewId, userId, admission.knockedAt!))) {
        markTold(key);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
