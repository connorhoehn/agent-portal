// The pad log (docs/interviews-tenant-plan.md decision 12, row I4.3; contract U3).
//
//   checkPadPost / capPost         ./rules.ts: a post checked field by field, and the interview's caps
//   appendPadEvents / readPadLog   for routes/interviews/pad.ts and routes/interview-invite-pad.ts
//   latestPadSnapshot              U3: the pad as last snapshotted, for the coach (through the integrator's seam) and the record
//   erasePadLog                    registered as the `pad-log` eraser, class `media` (decision 17: the code log is media)
//
// Panel side only (decision 4): nothing here is exported to the candidate, and the record's export of what Milo showed
// (lib/interviews/export/sections.ts) does not include it.
import { runWithDbTenant } from '../../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../../types.js';
import { padLogStore } from './store.js';

export {
  BAD_POST, MAX_COUNT, MAX_EVENTS_PER_INTERVIEW, MAX_EVENTS_PER_POST, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_INTERVIEW, PAD_EVENT_KINDS,
  capPost, checkPadEvent, checkPadPost, type PadEventIn, type PadEventKind, type PadSide,
} from './rules.js';
export { MemoryPadLogStore, padLogStore, setPadLogStore, type NewPadEvent, type PadEventRecord, type PadLogCounts, type PadLogStore } from './store.js';
export { CANDIDATE_NAME, READ_PAGE_EVENTS, READ_TEXT_BUDGET, appendPadEvents, padEventView, readPadLog, type PadEvent, type PadWriter } from './service.js';

/** U3: the interview's last snapshot (its text, its language, when it was stored), or null when none. */
export async function latestPadSnapshot(interviewId: string): Promise<{ text: string; language: string | null; at: string } | null> {
  const row = await runWithDbTenant(INTERVIEWS_TENANT, () => padLogStore().latestSnapshot(interviewId));
  return row ? { text: row.text ?? '', language: row.language, at: row.at } : null;
}

/** Remove these interviews' pad logs; how many events went. Runs in the interviews tenant's db context. */
export async function erasePadLog(interviewIds: readonly string[]): Promise<number> {
  if (!interviewIds.length) return 0;
  return runWithDbTenant(INTERVIEWS_TENANT, () => padLogStore().erase(interviewIds));
}
