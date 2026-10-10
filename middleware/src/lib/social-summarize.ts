// Social `/summarize` (docs/agentic-flows-migration.md slice 2): the Social
// flow on the shared summarize core (lib/conversation-summarize.ts). The run
// kind, id prefix (`sum-`), drafter call and wire shape are unchanged from the
// original Social implementation; only the code moved into the core so the
// tenant families and huddles reuse it (routes/conversation-summarize.ts).
//
// The caller has already passed chatAccess (grants + membership) and supplies
// only messages from `readChatLines` (history floor, deletions, range).

import { defineSummarizeFlow } from './conversation-summarize.js';
import type { FlowRunRow } from './flow-runs/index.js';

export {
  SUMMARIZE_AGENT_ID, SUMMARIZE_MODE, HISTORY_LIMIT, MAX_TRANSCRIPT_CHARS, MAX_ACTIVE_RUNS_PER_USER, RUN_TTL_MS, MAX_SPANS, MAX_CONTENT,
  transcriptLines, transcriptText, digestEnvelope, acceptEnvelope, summarizeView, postMessageFor,
  type SummarizeSpan, type SummarizeResult, type SummarizePhase, type TranscriptLine,
} from './conversation-summarize.js';

export const SUMMARIZE_KIND = 'social.summarize';
export const SUMMARIZE_TENANT = 'social';

export const socialSummarizeFlow = defineSummarizeFlow({ tenant: SUMMARIZE_TENANT, kind: SUMMARIZE_KIND, idPrefix: 'sum', agentAuth: false });

export const getRunFor = (userId: string, id: string): Promise<FlowRunRow | null> => socialSummarizeFlow.getRunFor(userId, id);
export const findRun = (id: string): Promise<FlowRunRow | null> => socialSummarizeFlow.findRun(id);
export const activeRunCount = (userId: string): Promise<number> => socialSummarizeFlow.activeRunCount(userId);
export const startRun: typeof socialSummarizeFlow.startRun = input => socialSummarizeFlow.startRun(input);
export const summarizeExecutor = socialSummarizeFlow.executor;
export const markPosted = (run: FlowRunRow): Promise<boolean> => socialSummarizeFlow.markPosted(run);
