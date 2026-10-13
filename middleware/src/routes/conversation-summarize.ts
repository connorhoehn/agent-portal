// `/summarize` beyond Social — mounted at /api/conversations/summarize:
//
//   POST /run                {channel, text?}  202 {runId, pipelineId, card}
//   GET  /runs/:id           the requester's own run (progress, result)
//   POST /runs/:id/post      returns the server-built message; posts nothing
//
// The channel names the conversation: a non-Social tenant chat family
// (`orgiq:initiative|work|session:<id>`, `orgiq:invoke`, `assessment:doc:<id>`,
// `pipelines:run|def:<id>`) or a huddle (`orgiq:huddle:<callId>`). Social
// conversations keep /api/chat/commands/summarize (routes/social-summarize.ts).
//
// Authority is exactly what that conversation's chat history asks today, fresh
// on every request (live-principal.ts `authorizeConversationChat`): the
// gateway's family authority + the chat service's membership rows for a family,
// the call-chat participant authority for a huddle. Reading is asked again
// after the transcript read, so a revocation during it refuses the run. The
// history floor and deleted messages are honoured where the chat store has
// them. Posting needs the conversation's publish authority (huddle:
// PostMessage), and the portal then sends the returned text itself — over the
// gateway for a family, through the huddle's own send route for a huddle.
//
// The run is the requester's alone: an unknown id and someone else's id are the
// same 404, asked before the conversation is re-checked.

import { Router, type Request } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { parseSummarizeRange } from '../lib/social-summarize-range.js';
import {
  MAX_ACTIVE_RUNS_PER_USER, defineSummarizeFlow, postMessageFor, summarizeStatus, summarizeView, transcriptLines,
  type SummarizeFlow, type TranscriptLine,
} from '../lib/conversation-summarize.js';
import { CONVERSATION_SUMMARIZE_KINDS, pendingFlowRuns, type FlowRunRow } from '../lib/flow-runs/index.js';
import { huddleCallId, sessionGatewayContext, summarizableFamily } from '../lib/live-principal.js';
import { admitConversationChat } from '../lib/gateway/authority.js';
import { callChatRuntime } from '../lib/call-chat.js';
import { socialChat } from '../lib/social-chat.js';
import type { Session } from '../lib/session.js';
import { readChatLines } from './chat-pins.js';
import { SUMMARIZE_PIPELINE_ID } from './social-summarize.js';

export const conversationSummarizeRouter = Router();
export const pendingConversationSummaries = pendingFlowRuns;

type Tenant = 'orgiq' | 'assessment' | 'pipelines';
const FLOWS: Readonly<Record<string, SummarizeFlow>> = Object.fromEntries(Object.entries(CONVERSATION_SUMMARIZE_KINDS)
  .map(([idPrefix, { tenant, kind }]) => [idPrefix, defineSummarizeFlow({ tenant, kind, idPrefix, agentAuth: true })]));
const flowFor = (tenant: Tenant): SummarizeFlow => Object.values(FLOWS).find(f => f.spec.tenant === tenant)!;

export function sessionOf(req: Request): Session {
  if (!req.session) throw new AppError(401, 'Unauthenticated');
  return req.session;
}

/** Which tenant's flow owns this conversation; 400 for anything that is not one. */
export function conversationTenant(channel: string): Tenant {
  if (huddleCallId(channel)) return 'orgiq';
  const family = summarizableFamily(channel);
  if (!family) throw new ValidationError('channel must name a tenant conversation (a discussion, document, run or huddle chat)');
  // summarizableFamily admits only partition tenants (never the social work-graph family).
  // A partition with no summarize flow (the access tenant's request threads) is not one.
  if (!Object.values(FLOWS).some(f => f.spec.tenant === family.tenant)) {
    throw new ValidationError(`/summarize is not offered on ${family.tenant} conversations`);
  }
  return family.tenant as Tenant;
}

export async function assertChat(session: Session, channel: string, kind: 'subscribe' | 'publish'): Promise<void> {
  const ok = await admitConversationChat({ ctx: sessionGatewayContext(session), channel, kind, clientId: 'rest:summarize' });
  if (!ok) throw new AppError(403, kind === 'publish' ? 'You cannot post to this conversation' : 'You cannot read this conversation');
}

/** What this reader may see of the conversation now: history floor, deletions, range. */
export async function conversationLines(session: Session, channel: string, sinceMs: number | null): Promise<TranscriptLine[]> {
  const callId = huddleCallId(channel);
  if (callId) {
    // The huddle's own read: floor, incarnation and deletions are applied there.
    const snapshot = await callChatRuntime().get(callId, session, 100);
    return transcriptLines(snapshot.messages.map(message => ({
      message, author: typeof message.metadata?.['displayName'] === 'string' ? message.metadata['displayName'] as string : message.userId ?? 'Unknown',
    })), sinceMs);
  }
  await socialChat().ready;
  return readChatLines(channel, session.sub, sinceMs);
}

/** The run's start, shared by the route and the `/agent` loop's step (same gate, fresh each call). */
export async function beginConversationSummarize(session: Session, channel: string, text: string): Promise<FlowRunRow> {
  const flow = flowFor(conversationTenant(channel));
  await assertChat(session, channel, 'subscribe');
  const range = parseSummarizeRange(text, new Date());
  if (!range.ok) throw new ValidationError(range.error);
  if (await flow.activeRunCount(session.sub) >= MAX_ACTIVE_RUNS_PER_USER) throw new AppError(429, 'Wait for your running summaries to finish');
  const lines = await conversationLines(session, channel, range.sinceMs);
  // The transcript read can outlive a revocation: nothing is stored unless the
  // reader still holds the conversation after it.
  await assertChat(session, channel, 'subscribe');
  return flow.startRun({ userId: session.sub, channel, instruction: text.trim(), sinceMs: range.sinceMs, lines });
}

conversationSummarizeRouter.post('/run', asyncHandler(async (req, res) => {
  const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
  if (!channel || channel.length > 300) throw new ValidationError('channel is required');
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.length > 200) throw new ValidationError('range text is too long');
  const run = await beginConversationSummarize(sessionOf(req), channel, text);
  res.status(202).json({
    runId: run.id, pipelineId: SUMMARIZE_PIPELINE_ID,
    card: { kind: 'agent-run', command: '/summarize', instruction: text.trim() || '/summarize', agentName: 'Nova' },
  });
}));

const RUN_ID = /^([a-z]{3})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The caller's own run, then the conversation's authority asked now. */
async function ownRun(req: Request, kind: 'subscribe' | 'publish'): Promise<FlowRunRow> {
  const id = req.params['id'];
  const flow = typeof id === 'string' ? FLOWS[id.match(RUN_ID)?.[1] ?? ''] : undefined;
  if (!flow || typeof id !== 'string') throw new NotFoundError('run not found');
  const session = sessionOf(req);
  const run = await flow.getRunFor(session.sub, id);
  if (!run || run.kind !== flow.spec.kind) throw new NotFoundError('run not found');
  await assertChat(session, run.scope, kind);
  return run;
}

conversationSummarizeRouter.get('/runs/:id', asyncHandler(async (req, res) => {
  res.json(summarizeStatus(await ownRun(req, 'subscribe')));
}));

conversationSummarizeRouter.post('/runs/:id/post', asyncHandler(async (req, res) => {
  const run = await ownRun(req, 'publish');
  const view = summarizeView(run);
  if (view.phase !== 'completed') throw new AppError(409, 'The summary is not finished');
  if (view.postedAt) throw new AppError(409, 'This summary was already posted');
  const message = postMessageFor(run);
  if (!message) throw new AppError(409, 'There is nothing to post');
  const flow = FLOWS[run.id.match(RUN_ID)![1]!]!;
  if (!await flow.markPosted(run)) throw new AppError(409, 'This summary was already posted');
  res.json({ channel: run.scope, ...message });
}));
