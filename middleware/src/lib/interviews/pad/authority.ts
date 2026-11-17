// Who may read and write an interview's code pad (docs/interviews-tenant-plan.md,
// "I0.7 answer"). The gateway's one authority facade (lib/gateway/authority.ts)
// hands every `doc:` name here; this module holds the rule and nothing else.
//
// A pad belongs to one technical interview. Its seats are the people in that
// interview's call: the lead and the panel (decision 20). The recruiter and the
// hiring manager read the interview over REST but hold no seat on the live pad;
// a behavioural round has no pad (decision 11). Row I2.2 adds the candidate:
// a guest principal whose invite names this interview, and only this one, once
// the lead has admitted it from the waiting room (lib/interviews/lobby.ts
// `guestHoldsInterviewSeat`; the guest is read from its invite, never the
// directory).
//
// Every subscribe, every write and every fan-out to a recipient asks this,
// fresh: the principal reloaded from the directory, the socket's tenant, the
// Cedar read action, the interview row, then the principal again after that
// read, as every other channel decision does. A refusal is the same for a pad
// that does not exist and one the caller may not open.
import type { LiveChannelAuthorization } from '../../live-principal.js';
import { getLivePrincipal } from '../../live-principal.js';
import { isAllowed } from '../../authz.js';
import type { Session } from '../../session.js';
import { interviewsEnabled } from '../flag.js';
import { interviewsStore } from '../store-select.js';
import { padInterviewId } from './channel.js';
import { claimsGuest, guestHoldsInterviewSeat } from '../lobby.js';

const TENANT = 'interviews';

/** Does this session hold a seat on `interviewId`'s pad now? */
export async function padSeatHolds(session: Session, interviewId: string): Promise<boolean> {
  if (session.tenant !== TENANT) return false;
  if (!await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'ViewInterviews')) return false;
  const interview = (await interviewsStore().listInterviews()).find((i) => i.id === interviewId);
  if (!interview || interview.type !== 'technical') return false;
  return interview.leadId === session.sub || interview.panelIds.includes(session.sub);
}

/**
 * The router's channel decision for a `doc:` name: subscribe (the pad's reads)
 * and publish (its edits and carets) have the same seats. Only the exact pad
 * name passes; a service-wrapped name (`presence:doc:…`) and any other document
 * are refused, and so is everything while the tenant's flag is off.
 */
export async function admitPadChannel(args: LiveChannelAuthorization, base: string): Promise<boolean> {
  const interviewId = padInterviewId(base);
  if (!interviewId || args.channel !== base || !interviewsEnabled()) return false;
  // The candidate's seat: its own interview's pad, a technical round, admitted, its invite read twice.
  if (claimsGuest(args.ctx)) return guestHoldsInterviewSeat(args.ctx, interviewId, { pad: true });
  try {
    const first = await getLivePrincipal(args.ctx);
    if (!await padSeatHolds(first.session, interviewId)) return false;
    const latest = await getLivePrincipal(args.ctx);
    return latest.session.sub === first.session.sub && latest.session.tenant === TENANT;
  } catch {
    return false;
  }
}
