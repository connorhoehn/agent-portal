// One vocabulary for naming a tool call.
//
// Extracted from RunTimeline.tsx so it can be shared with the local-compute
// run console (`pages/local-compute/runLogLines.ts`) without that module
// importing a React component — and so both can be tested without a DOM. The
// point of sharing it is that a Bash call should read the same wherever a run
// is watched; two copies drift into two vocabularies for one thing.

/** A tool_use block's name + input → what a reader should see. */
export function toolSummary(
  name: string,
  input: Record<string, unknown>,
): { summary: string; detail?: string } {
  if (name === 'Bash') {
    return {
      summary: String(input['command'] ?? ''),
      detail: input['description'] ? String(input['description']) : undefined,
    };
  }
  if (name === 'Write' || name === 'Edit' || name === 'Read' || name === 'NotebookEdit') {
    return { summary: String(input['file_path'] ?? input['notebook_path'] ?? '') };
  }
  const json = JSON.stringify(input);
  return { summary: json.length > 120 ? json.slice(0, 120) + '…' : json };
}
