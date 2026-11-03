// "Save as document" for a `/doc` page draft, through the tenant's EXISTING
// document-creation route — never a new store (docs/agentic-flows-migration.md
// slice 12):
//
//   assessment  POST /api/assessment/knowledge/doc/create — the route the
//               knowledge explorer's "New page" and Upload use; gated
//               ManageKnowledge there. A draft in the `workspace_drafts` section.
//   social      the conversation's attachment upload (the surface does it; it
//               is how a document already arrives in a Social thread)
//   orgiq       POST /api/graph/projects/:id/workspace-documents (2026-11-03) —
//               the Docs tab's own page store (New › Document); an initiative
//               discussion (`orgiq:initiative:<id>`) saves into its initiative.
//   pipelines   no document-creation path exists, so Save is not offered
//
// The page body is the stored run result; the server never sees it again.

import { sendJson } from '../../lib/writeJson';
import { createWorkspaceDocument } from '../../lib/workDocuments';
import type { ArtifactResult } from './conversationArtifact';

/** The page the tenant's own route makes for this conversation, by the channel the run belongs to. */
export async function createPageForSave(channel: string, result: Pick<ArtifactResult, 'title' | 'content'>): Promise<string> {
  const initiative = /^orgiq:initiative:([^\s/?#]{1,128})$/.exec(channel)?.[1];
  if (initiative) return (await createWorkspaceDocument(initiative, { title: result.title.slice(0, 200), markdown: result.content })).id;
  if (channel.startsWith('assessment:')) return createAssessmentDraft(result);
  throw new Error('This conversation has no document store to save a page into.');
}

/** Creates the assessment draft and returns its id. A refusal throws with the route's own message. */
export async function createAssessmentDraft(result: Pick<ArtifactResult, 'title' | 'content'>): Promise<string> {
  const created = await sendJson<{ ok: boolean; id: string }>('/api/assessment/knowledge/doc/create', 'POST',
    { title: result.title.slice(0, 240), sectionKey: 'workspace_drafts', markdown: result.content });
  if (!created.ok || !created.id) throw new Error('The server did not confirm the new page.');
  return created.id;
}
