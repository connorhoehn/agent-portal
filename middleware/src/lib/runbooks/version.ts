// Build a RunbookVersion from a doc: the stored markdown and its sha are
// always derived here, so no writer can store bytes that disagree with the doc.
import type { RunbookDoc, RunbookProvenance, RunbookVersion } from './types.js';
import { renderRunbook } from './render.js';
import { sha256Hex } from './tokens.js';

export function versionOf(input: {
  runbook_id: string;
  version: number;
  doc: RunbookDoc;
  author: RunbookVersion['author'];
  proposal_id?: string | null;
  accepted_by?: string | null;
  accepted_at?: string | null;
  provenance?: Partial<RunbookProvenance>;
}): RunbookVersion {
  const markdown = renderRunbook(input.doc);
  return {
    runbook_id: input.runbook_id,
    version: input.version,
    doc: input.doc,
    markdown,
    sha256: sha256Hex(markdown),
    author: input.author,
    proposal_id: input.proposal_id ?? null,
    accepted_by: input.accepted_by ?? null,
    accepted_at: input.accepted_at ?? null,
    provenance: {
      run_refs: input.provenance?.run_refs ?? [],
      session_ids: input.provenance?.session_ids ?? [],
      lab_experience_ids: input.provenance?.lab_experience_ids ?? [],
      source_artifact_ids: input.provenance?.source_artifact_ids ?? [],
    },
  };
}
