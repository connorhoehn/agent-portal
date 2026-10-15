// The two creation steps of the `/agent` loop (docs/agentic-flows-migration.md slice 10):
// `document:create` and `meeting:create`. Unlike the flow steps they start no child run: each
// makes one thing through the tenant's EXISTING create path, as the requester's freshly reloaded
// session, and the step completes holding a link to it.
//
//   document:create  assessment  createDocumentDraft, the function behind the Documents tab's
//                                "New" (POST /api/assessment/knowledge/doc/create): tenant and
//                                ManageKnowledge asked again inside it.
//                    social      a stored markdown file in the conversation's upload store, the way
//                                a document already arrives in a Social thread (PostMessage plus
//                                membership asked first; the file is readable by whoever may read
//                                the conversation, through GET /api/uploads/:id).
//                    orgiq,      no document store exists: refused (the planner never offers it).
//                    pipelines
//   meeting:create   social      a room through createRoom, the route behind "New room"
//                                (ManageChannels), open to the org, the requester its creator.
//                                The rooms API has no member invite, so the conversation's members
//                                are NOT invited; they join from the link.
//                    orgiq,      the conversation's own call lobby (an initiative discussion, an
//                    assessment  assessment document): the lobby the footer's Huddle starts. Nothing
//                                is dialled from the server; the step records the lobby name.
//                    pipelines   no lobby family: refused.
//
// A refusal is the create path's own AppError, so a failed step stops the loop with its reason.

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { AppError } from '../lib/async-handler.js';
import { isAllowed } from '../lib/authz.js';
import { huddleCallId } from '../lib/live-principal.js';
import { admitLobbyReadFor } from '../lib/gateway/authority.js';
import { gatewayUploadBackend, gatewayUploadConfig } from '../lib/gateway-attachments.js';
import { requiredName } from '../lib/social-names.js';
import type { Session } from '../lib/session.js';
import type { AgentTenant, PlanStep } from '../lib/agent-loop/plan.js';
import type { FlowRunStep } from '../mock/flow-runs.js';
import { createDocumentDraft } from '../providers/document-drafts.js';
import { DocumentSourceError } from '../providers/document-source.js';
import { createRoom } from '../providers/social-platform.js';
import { chatAccess } from './chat-pins.js';
import { assertChat } from './conversation-summarize.js';


export interface CreatedStep { kind: 'created'; link: NonNullable<FlowRunStep['link']>; detail: string }

const bodyOf = (step: PlanStep): string => {
  const text = step.body?.trim() || step.instruction.trim();
  const heading = `# ${step.title}`;
  return text ? (/^#\s/.test(text) ? text : `${heading}\n\n${text}`) : heading;
};

/** The conversation still admits the requester to post, asked again for this step. */
async function assertMayPost(req: Request, session: Session, tenant: AgentTenant, channel: string): Promise<void> {
  if (tenant === 'social') { await chatAccess(req, channel, 'PostMessage'); return; }
  await assertChat(session, channel, 'subscribe');
  await assertChat(session, channel, 'publish');
}

export async function createDocumentStep(req: Request, session: Session, tenant: AgentTenant, channel: string, step: PlanStep): Promise<CreatedStep> {
  if (session.tenant !== tenant) throw new AppError(403, 'Forbidden');
  await assertMayPost(req, session, tenant, channel);
  const title = step.title.slice(0, 240);
  const markdown = bodyOf(step);
  if (tenant === 'assessment') {
    try {
      const made = await createDocumentDraft({ title, sectionKey: 'workspace_drafts', markdown }, session);
      return { kind: 'created', detail: `Created the document "${title}".`,
        link: { kind: 'document', label: title, href: `/assessment/workspace?doc=${encodeURIComponent(made.id)}` } };
    } catch (error) {
      if (error instanceof DocumentSourceError) throw new AppError(error.status, error.message);
      throw error;
    }
  }
  if (tenant === 'social') {
    const config = gatewayUploadConfig();
    if (!config.enabled) throw new AppError(503, 'File uploads are not enabled, so a document cannot be stored here');
    const bytes = Buffer.from(markdown, 'utf8');
    if (bytes.length > config.maxBytes) throw new AppError(413, 'The document is too large');
    const be = gatewayUploadBackend(config);
    const uploadId = randomUUID();
    const filename = `${title.replace(/[^A-Za-z0-9 _.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document'}.md`;
    await be.metadata.create({ uploadId, channel, uploader: session.sub, filename, size: bytes.length, status: 'pending', contentType: 'text/markdown' });
    try {
      const size = await be.blobStore.putStream(uploadId, Readable.from([bytes]) as never, be.maxBytes);
      await be.metadata.updateStatus(uploadId, 'completed', { size, contentType: 'text/markdown' });
    } catch (error) {
      await be.metadata.updateStatus(uploadId, 'failed').catch(() => undefined);
      throw new AppError(500, error instanceof Error ? error.message : 'The document could not be stored');
    }
    return { kind: 'created', detail: `Stored "${filename}" in this conversation.`,
      link: { kind: 'document', label: filename, href: `/api/uploads/${encodeURIComponent(uploadId)}` } };
  }
  throw new AppError(409, 'This workspace has no document store to create a document in');
}

export async function createMeetingStep(req: Request, session: Session, tenant: AgentTenant, channel: string, step: PlanStep): Promise<CreatedStep> {
  if (session.tenant !== tenant) throw new AppError(403, 'Forbidden');
  await assertMayPost(req, session, tenant, channel);
  if (tenant === 'social') {
    // The "New room" route's own gate and name rule.
    if (!await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'ManageChannels')) throw new AppError(403, 'Forbidden');
    const name = requiredName(step.title.slice(0, 80), 'room');
    const room = await createRoom(session, { name, ...(step.instruction ? { description: step.instruction.slice(0, 280) } : {}), visibility: 'org' });
    return { kind: 'created', detail: `Created the room "${room.name}". The rooms API cannot invite people, so they join from the link.`,
      link: { kind: 'room', label: room.name, href: `/social/rooms?room=${encodeURIComponent(room.slug)}`, lobbyName: room.lobbyName } };
  }
  if (huddleCallId(channel)) throw new AppError(409, 'This conversation already is a huddle');
  // The page lobby's read: a lobby of this tenant (409), the family's read (403), the page existing now (404).
  const verdict = await admitLobbyReadFor(session, channel, { tenant });
  if (verdict === 'not-a-lobby') throw new AppError(409, 'This conversation has no huddle lobby');
  if (verdict === 'denied') throw new AppError(403, 'Forbidden');
  if (verdict === 'gone') throw new AppError(404, 'This page is not available');
  return { kind: 'created', detail: `The huddle lobby is ready: ${channel}. Start it from the Huddle button in the footer.`,
    link: { kind: 'huddle', label: step.title, lobbyName: channel } };
}
