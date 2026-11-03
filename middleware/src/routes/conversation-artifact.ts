// `/diagram` and `/doc` on a conversation (docs/agentic-flows-migration.md
// slice 12). Two mounts of one handler set, like /summarize:
//
//   Social channels, teams and DMs   /api/chat/commands/{diagram,doc}/...
//   tenant discussions and huddles   /api/conversations/{diagram,doc}/...
//
//   POST /run              {channel, text?}   202 {runId, pipelineId, card}
//   GET  /runs/:id         the requester's own run (progress, result)
//   POST /runs/:id/post    /diagram only: PostMessage / publish; returns the server-built message
//   POST /runs/:id/save    /doc only: the once-only claim of "Save as document"; returns the
//                          reference message. The page itself is made by the tenant's EXISTING
//                          document route (assessment: POST /api/assessment/knowledge/doc/create,
//                          gated ManageKnowledge there; Social: the conversation's attachment
//                          upload; orgiq since 2026-11-03: POST /api/graph/projects/:id/workspace-documents,
//                          the Docs tab's own page store, gated DispatchAgentRun + the initiative
//                          scope there). pipelines has no document-creation path, so Save answers
//                          409 there rather than minting a store.
//
// Authority is the /summarize authority, unchanged and fresh on every request:
// Social = chatAccess (ViewSocial to read, PostMessage to post, live membership);
// tenant conversations = the conversation's own chat history authority
// (live-principal.ts authorizeConversationChat), re-asked after the transcript
// read. A run is the requester's alone: an unknown id and someone else's id are
// one 404, asked before the conversation is re-checked. Nothing posts without
// the explicit /post or /save call AND the portal then sending what it returns.

import { Router, type Request, type RequestHandler } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import {
  MAX_ACTIVE_RUNS_PER_USER, artifactPostMessage, artifactStatus, defineArtifactFlow, pageReferenceMessage, parseArtifactArgs,
  type ArtifactCommand, type ArtifactFlow, type ArtifactTenant,
} from '../lib/conversation-artifact.js';
import { CONVERSATION_ARTIFACT_KINDS, pendingFlowRuns, type FlowRunRow } from '../lib/flow-runs/index.js';
import type { TranscriptLine } from '../lib/conversation-summarize.js';
import { chatAccess, readChatLines } from './chat-pins.js';
import { isAllowed } from '../lib/authz.js';
import { currentLiveSession } from '../lib/live-principal.js';
import { getKnowledgeDoc } from '../providers/assessment.js';
import { getWorkspaceDocument } from '../providers/work-documents.js';
import { assertChat, conversationLines, conversationTenant, sessionOf } from './conversation-summarize.js';

export const pendingArtifacts = pendingFlowRuns;
export const ARTIFACT_PIPELINE_ID: Readonly<Record<ArtifactCommand, string>> = { diagram: 'conversation-diagram', doc: 'conversation-doc' };

const SOCIAL_PREFIX: Readonly<Record<ArtifactCommand, string>> = { diagram: 'sdg', doc: 'sdc' };
const SOCIAL_FLOWS: Readonly<Record<ArtifactCommand, ArtifactFlow>> = {
  diagram: defineArtifactFlow({ tenant: 'social', command: 'diagram', kind: 'social.diagram', idPrefix: SOCIAL_PREFIX.diagram, agentAuth: false }),
  doc: defineArtifactFlow({ tenant: 'social', command: 'doc', kind: 'social.doc', idPrefix: SOCIAL_PREFIX.doc, agentAuth: false }),
};
const TENANT_FLOWS: Readonly<Record<string, ArtifactFlow>> = Object.fromEntries(Object.entries(CONVERSATION_ARTIFACT_KINDS)
  .map(([idPrefix, { tenant, kind, command }]) => [idPrefix, defineArtifactFlow({ tenant, command, kind, idPrefix, agentAuth: true })]));
const tenantFlow = (tenant: Exclude<ArtifactTenant, 'social'>, command: ArtifactCommand): ArtifactFlow =>
  Object.values(TENANT_FLOWS).find(f => f.spec.tenant === tenant && f.spec.command === command)!;

/** Where a saved page can land, by tenant. Anything else has no existing document-creation path. */
export const SAVE_TARGET: Readonly<Record<ArtifactTenant, 'document' | 'attachment' | null>> = {
  assessment: 'document', social: 'attachment', orgiq: 'document', pipelines: null,
};

interface Authority {
  /** Reads the conversation for a new run: access, lines, the flow that owns them. */
  begin(req: Request, command: ArtifactCommand, channel: string): Promise<{ userId: string; flow: ArtifactFlow; read(): Promise<TranscriptLine[]>; recheck(): Promise<void> }>;
  /** The caller's own run, then the conversation's authority asked now. */
  own(req: Request, command: ArtifactCommand, kind: 'subscribe' | 'publish'): Promise<{ run: FlowRunRow; flow: ArtifactFlow }>;
}

const idOf = (req: Request): string => {
  const id = req.params['id'];
  if (typeof id !== 'string') throw new NotFoundError('run not found');
  return id;
};

const socialAuthority: Authority = {
  async begin(req, command, channel) {
    const userId = await chatAccess(req, channel, 'ViewSocial');
    return { userId, flow: SOCIAL_FLOWS[command], read: () => readChatLines(channel, userId, null), recheck: async () => { await chatAccess(req, channel, 'ViewSocial'); } };
  },
  async own(req, command, kind) {
    const flow = SOCIAL_FLOWS[command];
    const id = idOf(req);
    if (!new RegExp(`^${SOCIAL_PREFIX[command]}-[0-9a-f-]{36}$`).test(id)) throw new NotFoundError('run not found');
    const any = await flow.findRun(id);
    if (!any) throw new NotFoundError('run not found');
    const userId = await chatAccess(req, any.scope, kind === 'publish' ? 'PostMessage' : 'ViewSocial');
    const run = await flow.getRunFor(userId, id);
    if (!run) throw new NotFoundError('run not found');
    return { run, flow };
  },
};

const RUN_ID = /^([a-z]{3})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tenantAuthority: Authority = {
  async begin(req, command, channel) {
    const session = sessionOf(req);
    const flow = tenantFlow(conversationTenant(channel) as Exclude<ArtifactTenant, 'social'>, command);
    await assertChat(session, channel, 'subscribe');
    return {
      userId: session.sub, flow,
      read: () => conversationLines(session, channel, null),
      // The transcript read can outlive a revocation: nothing is stored unless the reader still holds the conversation after it.
      recheck: () => assertChat(session, channel, 'subscribe'),
    };
  },
  async own(req, command, kind) {
    const id = idOf(req);
    const flow = TENANT_FLOWS[id.match(RUN_ID)?.[1] ?? ''];
    if (!flow || flow.spec.command !== command) throw new NotFoundError('run not found');
    const session = sessionOf(req);
    const run = await flow.getRunFor(session.sub, id);
    if (!run || run.kind !== flow.spec.kind) throw new NotFoundError('run not found');
    await assertChat(session, run.scope, kind);
    return { run, flow };
  },
};

// Handlers are built per command and authority, then registered with LITERAL paths below: the wire
// capture's route enumeration (mock/core/wire/routes.ts) reads the router source, and a path built
// from a template string would hide these routes from it and from the route-coverage scan.
/** The run's start, shared by the routes and the `/agent` loop's step (same gate, fresh each call). */
async function beginArtifact(authority: Authority, req: Request, command: ArtifactCommand, channel: string, text: string): Promise<FlowRunRow> {
  const args = parseArtifactArgs(text, command);
  if (!args.ok) throw new ValidationError(args.error);
  const access = await authority.begin(req, command, channel);
  if (await access.flow.activeRunCount(access.userId) >= MAX_ACTIVE_RUNS_PER_USER) throw new AppError(429, 'Wait for your running requests to finish');
  const lines = await access.read();
  await access.recheck();
  return access.flow.startRun({ userId: access.userId, channel, title: args.title, topic: args.topic, lines });
}
export const beginSocialArtifact = (req: Request, command: ArtifactCommand, channel: string, text: string): Promise<FlowRunRow> =>
  beginArtifact(socialAuthority, req, command, channel, text);
export const beginTenantArtifact = (req: Request, command: ArtifactCommand, channel: string, text: string): Promise<FlowRunRow> =>
  beginArtifact(tenantAuthority, req, command, channel, text);

const runHandler = (command: ArtifactCommand, authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
  if (!channel || channel.length > 300) throw new ValidationError('channel is required');
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const parsed = parseArtifactArgs(text, command);
  if (!parsed.ok) throw new ValidationError(parsed.error);
  const run = await beginArtifact(authority, req, command, channel, text);
  res.status(202).json({
    runId: run.id, pipelineId: ARTIFACT_PIPELINE_ID[command],
    card: { kind: 'agent-run', command: `/${command}`, instruction: text.trim() || `/${command}`, agentName: 'Nova' },
  });
});

const statusHandler = (command: ArtifactCommand, authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const { run } = await authority.own(req, command, 'subscribe');
  res.set('Cache-Control', 'no-store').json({ ...artifactStatus(run), saveTarget: SAVE_TARGET[run.tenant as ArtifactTenant] });
});

const postHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const { run, flow } = await authority.own(req, 'diagram', 'publish');
  if (run.status !== 'completed') throw new AppError(409, 'The diagram is not finished');
  if (run.meta['postedAt']) throw new AppError(409, 'This diagram was already posted');
  const message = artifactPostMessage(run);
  if (!message) throw new AppError(409, 'There is nothing to post');
  if (!await flow.markPosted(run)) throw new AppError(409, 'This diagram was already posted');
  res.json({ channel: run.scope, ...message });
});

/**
 * A Save into an existing document is asked of the document's own authority, fresh on this request:
 * the actor's current session must hold ManageKnowledge in the run's tenant (the gate the create route
 * uses), and the document must exist and be editable. Missing is a 404, not an accepted string.
 */
async function assertDocumentTarget(req: Request, tenant: string, documentId: string, scope: string): Promise<void> {
  const session = await currentLiveSession(sessionOf(req));
  if (tenant === 'orgiq') {
    // A Work page (providers/work-documents.ts): the saver must hold the page store's own write
    // authority, and an initiative discussion saves only into its own initiative.
    if (session.tenant !== 'orgiq' || !await isAllowed(session, 'DispatchAgentRun')) throw new AppError(403, 'Forbidden');
    const page = await getWorkspaceDocument(documentId);
    if (!page) throw new NotFoundError('document not found');
    const initiative = /^orgiq:initiative:([^\s/?#]{1,128})$/.exec(scope)?.[1];
    if (initiative && page.projectId !== initiative) throw new AppError(403, 'That page belongs to another initiative');
    return;
  }
  if (session.tenant !== tenant || !await isAllowed(session, 'ManageKnowledge')) throw new AppError(403, 'Forbidden');
  const doc = await getKnowledgeDoc(documentId);
  if (!doc) throw new NotFoundError('document not found');
  if (doc.editable === false) throw new AppError(403, 'Forbidden');
}

const saveHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const { run, flow } = await authority.own(req, 'doc', 'publish');
  if (run.status !== 'completed') throw new AppError(409, 'The page is not finished');
  if (run.meta['savedAs']) throw new AppError(409, 'This page was already saved');
  const target = SAVE_TARGET[run.tenant as ArtifactTenant];
  if (!target) throw new AppError(409, 'This workspace has no document store to save a page into');
  const raw = req.body?.documentId;
  // A page is made by the tenant's own route; the id it minted is only the reference carried in the message.
  if (target === 'document' && (typeof raw !== 'string' || !/^[a-zA-Z0-9:_.\-/]{1,256}$/.test(raw))) throw new ValidationError('documentId is required');
  if (target === 'attachment' && raw !== undefined) throw new ValidationError('A conversation page is saved as an attachment; documentId is not accepted');
  if (target === 'document') await assertDocumentTarget(req, run.tenant, raw as string, run.scope);
  const message = pageReferenceMessage(run, target === 'document' ? raw as string : null);
  if (!message) throw new AppError(409, 'There is nothing to save');
  if (!await flow.markSaved(run, target === 'document' ? raw as string : 'attachment')) throw new AppError(409, 'This page was already saved');
  res.json({ channel: run.scope, saveTarget: target, title: (run.result as { title: string }).title, ...message });
});

/** /api/chat/commands: Social conversations. */
export const socialArtifactRouter = Router();
socialArtifactRouter.post('/diagram/run', runHandler('diagram', socialAuthority));
socialArtifactRouter.get('/diagram/runs/:id', statusHandler('diagram', socialAuthority));
socialArtifactRouter.post('/diagram/runs/:id/post', postHandler(socialAuthority));
socialArtifactRouter.post('/doc/run', runHandler('doc', socialAuthority));
socialArtifactRouter.get('/doc/runs/:id', statusHandler('doc', socialAuthority));
socialArtifactRouter.post('/doc/runs/:id/save', saveHandler(socialAuthority));

/** /api/conversations: tenant discussions and huddles. */
export const conversationArtifactRouter = Router();
conversationArtifactRouter.post('/diagram/run', runHandler('diagram', tenantAuthority));
conversationArtifactRouter.get('/diagram/runs/:id', statusHandler('diagram', tenantAuthority));
conversationArtifactRouter.post('/diagram/runs/:id/post', postHandler(tenantAuthority));
conversationArtifactRouter.post('/doc/run', runHandler('doc', tenantAuthority));
conversationArtifactRouter.get('/doc/runs/:id', statusHandler('doc', tenantAuthority));
conversationArtifactRouter.post('/doc/runs/:id/save', saveHandler(tenantAuthority));
