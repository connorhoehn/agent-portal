// The code pad's carrier (docs/interviews-tenant-plan.md, "I0.7 answer"):
// realtime-modules' `collabDocs` feature, the CRDT service the document
// gateways run, attached to the BFF's own /ws gateway. The client is the
// library's GatewayProvider (`useYjsDoc`) on the socket the portal already
// holds, so the mock world, the journeys and a deployment carry the pad the
// same way, and a guest reaches it through the same admission as its call.
//
// Two checks guard every document action, and both must pass:
//   - this `authz` hook: only a pad's channel, and only reading, editing and
//     carets. Creating, deleting, restoring, saving versions, seeding and
//     renaming are server work (or nobody's), never a client's;
//   - the router's channel decision (lib/gateway/authority.ts, which asks
//     ./authority.ts): who holds a seat on that interview's pad.
//
// Snapshots and the hot cache are the library's memory stores: a pad lives as
// long as the process. Row I4.3 keeps the durable record (the pad log).
import { collabDocs, type CRDTDocumentAction, type RealtimeFeature } from '@connorhoehn/realtime-modules/server';
import { config } from '../../../config.js';
import { seededPadSnapshots } from '../../../mock/interviews-pad-seed.js';
import { padInterviewId } from './channel.js';
import { boardInterviewId } from '../board/channel.js';

const PAD_ACTIONS: ReadonlySet<CRDTDocumentAction> = new Set<CRDTDocumentAction>(['read', 'update', 'awareness']);

/** The CRDT service's document hook: a pad's or a whiteboard's channel (../board/channel.ts), and only the three client actions. */
export function padDocumentAuthz(_clientId: string, channel: string, _service: unknown, action: CRDTDocumentAction): boolean {
  return PAD_ACTIONS.has(action) && (padInterviewId(channel) !== null || boardInterviewId(channel) !== null);
}

/** The gateway feature that carries interview pads. In the mock world the live seeded round's pad opens with its code. */
export function interviewPads(): RealtimeFeature {
  return collabDocs({ authz: padDocumentAuthz, ...(config.mock?.aurora ? { snapshotStore: seededPadSnapshots() } : {}) });
}
