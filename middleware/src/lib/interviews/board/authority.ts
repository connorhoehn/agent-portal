// Who may read and draw on an interview's whiteboard (WHITEBOARD-PLAN step 1): the pad's seats exactly
// (../pad/authority.ts). The lead and the panel of that technical interview while its call can run, and the
// candidate whose invite names this interview, once admitted from the waiting room. The recruiter, the hiring
// manager, other interviews' people, other tenants and Milo hold no seat (Milo's board tools are a later step).
//
// Every subscribe, write and fan-out asks this fresh, as the pad's decision does: the principal reloaded, the
// interview read, the principal again after that read. A refusal is the same for a board that does not exist and
// one the caller may not open.
import type { LiveChannelAuthorization } from '../../live-principal.js';
import { getLivePrincipal } from '../../live-principal.js';
import { interviewsEnabled } from '../flag.js';
import { claimsGuest, guestHoldsInterviewSeat } from '../lobby.js';
import { admitPadChannel, padSeatHolds } from '../pad/authority.js';
import { claimsMiloPad } from '../pad/milo-seat.js';
import { boardInterviewId } from './channel.js';

const TENANT = 'interviews';

/** The router's channel decision for a board's `doc:` name: subscribe and publish have the same seats. */
export async function admitBoardChannel(args: LiveChannelAuthorization, base: string): Promise<boolean> {
  const interviewId = boardInterviewId(base);
  if (!interviewId || args.channel !== base || !interviewsEnabled()) return false;
  // The candidate's seat: the technical round's seat its pad has (`pad: true` is the lobby's technical-round rule).
  if (claimsGuest(args.ctx)) return guestHoldsInterviewSeat(args.ctx, interviewId, { pad: true });
  if (claimsMiloPad(args.ctx)) return false;
  try {
    const first = await getLivePrincipal(args.ctx);
    if (!await padSeatHolds(first.session, interviewId)) return false;
    const latest = await getLivePrincipal(args.ctx);
    return latest.session.sub === first.session.sub && latest.session.tenant === TENANT;
  } catch {
    return false;
  }
}

/** Every `doc:` name on this gateway: an interview's board or its pad, each by its own rule; anything else is refused by the pad's. */
export function admitInterviewDocument(args: LiveChannelAuthorization, base: string): Promise<boolean> {
  return boardInterviewId(base) !== null ? admitBoardChannel(args, base) : admitPadChannel(args, base);
}
