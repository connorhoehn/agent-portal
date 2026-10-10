// `/summarize` in a Social channel or DM — the Social mount of the shared
// client (components/chat/conversationSummarize.ts), against
// middleware/src/routes/social-summarize.ts. The exported names are unchanged.

import type { ChatCommand } from '@connorhoehnslalom/ui-components/social';
import { SOCIAL_SUMMARIZE_BASE, summarizeApi, summarizeCommand, type PostedSummary, type SummarizeRunStatus, type SummarizeStarted } from '../../components/chat/conversationSummarize.ts';

export {
  MAX_POLLS, agentRunStatusOf, canPost, isTerminal, pollDelayMs, reviewMarkdown,
  type PostedSummary, type SummarizePhase, type SummarizeResult, type SummarizeRunStatus, type SummarizeSpan,
} from '../../components/chat/conversationSummarize.ts';

export const socialSummarizeApi = summarizeApi(SOCIAL_SUMMARIZE_BASE);

type Fetch = typeof fetch;
export const startSummarize = (channel: string, argumentText: string, doFetch: Fetch = fetch): Promise<SummarizeStarted> =>
  socialSummarizeApi.start(channel, argumentText, doFetch);
export const fetchSummarizeStatus = (runId: string, doFetch: Fetch = fetch): Promise<SummarizeRunStatus> =>
  socialSummarizeApi.status(runId, doFetch);
/** Asks the server for the message to send. Sending it is the caller's explicit act. */
export const requestSummaryPost = (runId: string, doFetch: Fetch = fetch): Promise<PostedSummary> =>
  socialSummarizeApi.requestPost(runId, doFetch);

/** `/summarize` or `/summarize last 24h` — the private card, not a message. */
export const socialSummarizeCommand: ChatCommand = summarizeCommand(socialSummarizeApi);
