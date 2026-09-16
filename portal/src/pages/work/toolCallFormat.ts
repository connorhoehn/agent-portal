// Pure derivation for the per-job tool-call list — `result.toolCallList` on
// the wire (middleware providers/agent-jobs.ts::deriveToolCallList) shaped
// for `<ToolCallStrip>`'s `toolCalls` prop.
//
// Kept in its own plain .ts file (not workShared.tsx) so it can run under
// `node --test`, same convention as botsFormat.ts/queueMath.ts/
// localComputeFormat.ts — a .tsx file's JSX syntax is not something the
// runner's TS-stripping loader can parse.

/** One entry of `result.toolCallList` — see providers/agent-jobs.ts::deriveToolCallList. */
export interface JobToolCall { name: string; done: boolean }

/** Structurally identical to ui-components' `ToolCall` (id/name/done), typed
 *  locally rather than imported so this file stays free of any package that
 *  a plain Node runtime would need to resolve. */
export interface ToolCallStripItem { id: string; name: string; done: boolean }

/**
 * `result.toolCallList` (wire) → `<ToolCallStrip>`'s `ToolCall[]` prop.
 *
 * The wire shape carries no id — nothing downstream needs to address one
 * call — so this mints a stable one from position + name. Good enough for a
 * React key: a finished job's list never reorders under the reader.
 */
export function toToolCallStripItems(list: JobToolCall[] | undefined): ToolCallStripItem[] {
  return (list ?? []).map((tc, i) => ({ id: `${i}-${tc.name}`, name: tc.name, done: tc.done }));
}
