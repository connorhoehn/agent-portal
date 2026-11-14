// Telling the people a proposal needs who are not in the call (docs/meeting-consent-design.md, "The consent rule" 2, package 6).
//
// The rules kept here:
//   - Only a named person or the executor who has not answered, and who is not seated in the call, is told.
//   - The notification says only "A proposal from this meeting needs you" and links to the meeting page. It carries no statement,
//     reason or name of the proposal: the notification service cannot delete, and the inviter's delete must leave nothing behind.
//   - Each person is told once per proposal in this process: when it is created (those not in the call), and when the call ends
//     or Nova leaves (those still owing an answer who are not seated then).
import { callChatRuntime } from '../call-chat.js';
import { notify } from '../social-notify.js';
import { ANSWERABLE, onProposalChanged } from './proposals.js';
import type { AssistantStore } from './store.js';
import type { Proposal } from './types.js';

export const PROPOSAL_NOTICE_TITLE = 'A proposal from this meeting needs you';
/** The portal's meeting page (minutes-service.ts `meetingPagePath`, kept here to avoid loading the minutes stack). */
const meetingPage = (callId: string): string => `/iq/meetings/${encodeURIComponent(callId)}`;

const told = new Set<string>();
/** Tests start clean. */
export function forgetProposalNotices(): void { told.clear(); }

/** The people this proposal still waits for: the executor and everyone named who has not answered. */
export function owedBy(p: Pick<Proposal, 'executor' | 'named' | 'responses'>): string[] {
  const answered = new Set(p.responses.map((r) => r.userId));
  return [...new Set([p.executor, ...p.named])].filter((u) => !answered.has(u));
}

async function seatedNow(callId: string): Promise<Set<string>> {
  try { return new Set((await callChatRuntime().seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId)); } catch { return new Set(); }
}

/** Tell the people `p` still needs who are not in `seated`, once each. Returns who was told. */
export async function notifyProposalNeeds(p: Proposal, seated: ReadonlySet<string>): Promise<string[]> {
  if (!ANSWERABLE.includes(p.state)) return [];
  const who = owedBy(p).filter((u) => !seated.has(u) && !told.has(`${p.callId}\0${p.id}\0${u}`));
  if (!who.length) return [];
  for (const u of who) told.add(`${p.callId}\0${p.id}\0${u}`);
  return notify(who, {
    type: 'meeting-proposal-needs-you', title: PROPOSAL_NOTICE_TITLE,
    action: { label: 'Open the meeting', href: meetingPage(p.callId) },
    payload: { tenant: p.tenant, kind: 'meeting-proposal-needs-you', callId: p.callId },
  });
}

/** The call ended or Nova left: everyone still owed an answer who is not seated now is told. Never throws. */
export async function notifyOpenProposals(store: AssistantStore, callId: string): Promise<number> {
  try {
    const seated = await seatedNow(callId);
    let n = 0;
    for (const p of await store.listProposals(callId)) n += (await notifyProposalNeeds(p, seated)).length;
    return n;
  } catch (e) { console.warn('[meeting-assistant] proposal notices failed', (e as Error).message); return 0; }
}

let hooked: (() => void) | null = null;
/** A new proposal tells the people it needs who are not in the call. Subscribed once. */
export function hookProposalNotices(): void {
  hooked ??= onProposalChanged(async (p, how) => {
    if (how !== 'created') return;
    await notifyProposalNeeds(p, await seatedNow(p.callId));
  });
}
