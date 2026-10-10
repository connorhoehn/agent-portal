// "Save as document" for a `/doc` page draft, through the tenant's EXISTING
// document-creation route — never a new store (docs/agentic-flows-migration.md
// slice 12):
//
//   assessment  POST /api/assessment/knowledge/doc/create — the route the
//               knowledge explorer's "New page" and Upload use; gated
//               ManageKnowledge there. A draft in the `workspace_drafts` section.
//   social      the conversation's attachment upload (the surface does it; it
//               is how a document already arrives in a Social thread)
//   orgiq,      no document-creation path exists (orgiq's work/document
//   pipelines   association only links ingested records), so Save is not offered
//
// The page body is the stored run result; the server never sees it again.

import { sendJson } from '../../lib/writeJson';
import type { ArtifactResult } from './conversationArtifact';

/** Creates the assessment draft and returns its id. A refusal throws with the route's own message. */
export async function createAssessmentDraft(result: Pick<ArtifactResult, 'title' | 'content'>): Promise<string> {
  const created = await sendJson<{ ok: boolean; id: string }>('/api/assessment/knowledge/doc/create', 'POST',
    { title: result.title.slice(0, 240), sectionKey: 'workspace_drafts', markdown: result.content });
  if (!created.ok || !created.id) throw new Error('The server did not confirm the new page.');
  return created.id;
}
