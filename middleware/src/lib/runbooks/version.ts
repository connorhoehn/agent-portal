// Build a RunbookVersion from a doc: the stored markdown and its sha are
// always derived here, so no writer can store bytes that disagree with the doc.
// R8: so are the bundle sha and the file order.
import type { RunbookDoc, RunbookFile, RunbookProvenance, RunbookVersion } from './types.js';
import { bundleSha, sortFiles } from './files.js';
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
  /** R8: the files the version carries (already validated by files.ts filesOf). */
  files?: readonly RunbookFile[];
}): RunbookVersion {
  const markdown = renderRunbook(input.doc);
  const sha256 = sha256Hex(markdown);
  const files = input.files?.length ? sortFiles(input.files) : null;
  return {
    runbook_id: input.runbook_id,
    version: input.version,
    doc: input.doc,
    markdown,
    sha256,
    // Files hash into the version; a procedure-only version keeps its pre-R8 shape exactly.
    ...(files ? { files: structuredClone(files), bundle_sha256: bundleSha(sha256, files) } : {}),
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
