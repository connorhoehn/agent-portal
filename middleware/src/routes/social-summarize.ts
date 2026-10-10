// Social `/summarize` — mounted at /api/chat/commands beside chatPinsRouter
// (the reference's route is platform-api `POST /api/chat/commands/:trigger/run`,
// src/routes/chatCommands.ts:93, with its membership check at :76-79).
//
//   POST /summarize/run                {channel, text?}  202 {runId, pipelineId, card}
//   GET  /summarize/runs/:id           the requester's own run (progress, result)
//   POST /summarize/runs/:id/post      PostMessage; returns the server-built message
//
// Reading goes through chatAccess (the same grant + membership gate the pin
// routes use, ViewSocial) and the same history floor / deletion rule. The run
// is private: another user's id is a 404. Nothing reaches the conversation
// until the requester calls /post AND sends what it returns over the gateway.

import { Router, type Request } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { parseSummarizeArgs } from '../lib/social-summarize-args.js';
import { ROOM_LOBBY, assertRecordingParticipant, readRecordingLines } from '../lib/recording-source.js';
import {
  MAX_ACTIVE_RUNS_PER_USER, activeRunCount, findRun, getRunFor, markPosted, postMessageFor, startRun, summarizeView,
} from '../lib/social-summarize.js';
import { summarizeStatus } from '../lib/conversation-summarize.js';
import { pendingFlowRuns } from '../lib/flow-runs/index.js';
import type { FlowRunRow } from '../lib/flow-runs/index.js';
import { chatAccess, readChatLines, socialSubject } from './chat-pins.js';

export const socialSummarizeRouter = Router();
export const SUMMARIZE_PIPELINE_ID = 'conversation-summarize';

/** Settles when every started run has finished (tests await it; the route never does). */
export const pendingSummaries = pendingFlowRuns;

const statusOf = summarizeStatus;

/** The run's start, shared by the route and the `/agent` loop's step (same gate, fresh each call). */
export async function beginSocialSummarize(req: Request, channel: string, text: string): Promise<FlowRunRow> {
  const range = parseSummarizeArgs(text, new Date());
  if (!range.ok) throw new ValidationError(range.error);
  // A room's call lobby carries no chat: its recording is summarized into a private card in the
  // Recordings pane (slice 7). Only `--recording` is meaningful there, and the call's own
  // participation (recordingTranscript) is the authority; the channel is picked at Post.
  const room = ROOM_LOBBY.test(channel);
  if (room && !range.recordingId) throw new ValidationError('A room has no conversation to read; name a recording with --recording <id>.');
  // Reading a conversation is ViewSocial, even though this is a POST.
  const userId = room ? await socialSubject(req, 'ViewSocial') : await chatAccess(req, channel, 'ViewSocial');
  if (await activeRunCount(userId) >= MAX_ACTIVE_RUNS_PER_USER) throw new AppError(429, 'Wait for your running summaries to finish');
  // `--recording <id>` summarizes that call's transcript instead of the thread (slice 7).
  const lines = range.recordingId
    ? await readRecordingLines(req, userId, channel, range.recordingId)
    : await readChatLines(channel, userId, range.sinceMs);
  return startRun({ userId, channel, instruction: range.instruction, sinceMs: range.sinceMs, lines, ...(room && range.recordingId ? { recordingId: range.recordingId } : {}) });
}

socialSummarizeRouter.post('/summarize/run', asyncHandler(async (req, res) => {
  const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
  if (!channel || channel.length > 240) throw new ValidationError('channel is required');
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.length > 200) throw new ValidationError('range text is too long');
  const run = await beginSocialSummarize(req, channel, text);
  res.status(202).json({
    runId: run.id, pipelineId: SUMMARIZE_PIPELINE_ID,
    card: { kind: 'agent-run', command: '/summarize', instruction: text.trim() || '/summarize', agentName: 'Nova' },
  });
}));

function runId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^sum-[0-9a-f-]{36}$/.test(raw)) throw new NotFoundError('run not found');
  return raw;
}

/**
 * The run, if it is the caller's. Membership is re-checked for the run's
 * channel (it can end after the run started), then ownership: someone else's
 * run answers exactly like an unknown id.
 */
async function ownRun(req: Request, id: string, action: 'ViewSocial' | 'PostMessage'): Promise<FlowRunRow> {
  const any = await findRun(id);
  if (!any) throw new NotFoundError('run not found');
  if (ROOM_LOBBY.test(any.scope)) {
    // A room-recording run: the requester's own, and still a participant of that call.
    const userId = await socialSubject(req, 'ViewSocial');
    const run = await getRunFor(userId, id);
    const recordingId = run?.meta['recordingId'];
    if (!run || typeof recordingId !== 'string') throw new NotFoundError('run not found');
    await assertRecordingParticipant(req, userId, run.scope, recordingId);
    return run;
  }
  const userId = await chatAccess(req, any.scope, action);
  const run = await getRunFor(userId, id);
  if (!run) throw new NotFoundError('run not found');
  return run;
}

socialSummarizeRouter.get('/summarize/runs/:id', asyncHandler(async (req, res) => {
  const id = runId(req.params['id']);
  const run = await ownRun(req, id, 'ViewSocial');
  res.json(statusOf(run));
}));

socialSummarizeRouter.post('/summarize/runs/:id/post', asyncHandler(async (req, res) => {
  const id = runId(req.params['id']);
  const run = await ownRun(req, id, 'PostMessage');
  // A room has no chat: the requester names where it goes, and that target passes the normal channel authority.
  let target = run.scope;
  if (ROOM_LOBBY.test(run.scope)) {
    const picked = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
    if (!picked || picked.length > 240) throw new ValidationError('Choose a channel or direct message to post to');
    await chatAccess(req, picked, 'PostMessage');
    target = picked;
  }
  if (summarizeView(run).phase !== 'completed') throw new AppError(409, 'The summary is not finished');
  if (summarizeView(run).postedAt) throw new AppError(409, 'This summary was already posted');
  const message = postMessageFor(run);
  if (!message) throw new AppError(409, 'There is nothing to post');
  if (!await markPosted(run)) throw new AppError(409, 'This summary was already posted');
  res.json({ channel: target, ...message });
}));
