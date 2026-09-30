// The canned edit `dev:mock` streams back for an instruction sent from an
// assessment document's composer dock in Agent mode (parity goal, decision 8).
//
// The portal sends the drafter's own document-command payload as the invoke
// body's `payload` — `{mode, instruction, document: {id, title, text,
// selection}}` (portal `documentAgentEditModel.ts`) — which reaches the
// provider as `structuredInput`. The reply is the envelope the real
// drafter returns for that mode: `validate_document_output` in
// `agents/assessment-drafter/document_commands.py` emits
// `{summary, content, format: "markdown", source_spans, draft: true,
// published: false}`, and `source_spans` must be verbatim quotations of
// `document.text` — so the mock quotes the text it was given rather than
// inventing one. No timestamps, so the clock has nothing to supply.
//
// One row per placement: a selection is replaced, a caret gets an insertion.
// `empty` has no rows, and the reply is the drafter's error envelope
// (`{agent, error}`) — what the portal sees when the drafter declines.

import { defineFixture } from './core/index.js';

export interface DocumentAgentEdit {
  placement: 'replace' | 'insert';
  summary: string;
  content: string;
}

function seedEdits(): DocumentAgentEdit[] {
  return [
    {
      placement: 'replace',
      summary: 'Tightens the selected passage',
      content: 'The assessment scores each SDLC practice against the published rubric and cites the evidence behind every score.',
    },
    {
      placement: 'insert',
      summary: 'Adds a next step at the cursor',
      content: 'Next step: confirm an owner for each practice before the scoring window opens.',
    },
  ];
}

export const documentAgentEdits = defineFixture<DocumentAgentEdit>({
  key: 'document-agent-edits',
  scenarios: {
    default: seedEdits,
    empty: () => [],
  },
});

/** The drafter modes whose reply is a markdown page edit (document_commands.py). */
const EDIT_MODES = new Set(['suggest-confluence-content', 'draft-confluence-page']);

interface DocumentCommand {
  mode: string;
  document: { text: string; selection?: { text?: string } | null };
}

function readDocumentCommand(input: unknown): DocumentCommand | null {
  let value: unknown = input;
  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw.startsWith('{')) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const command = value as Partial<DocumentCommand>;
  if (typeof command.mode !== 'string' || !EDIT_MODES.has(command.mode)) return null;
  if (!command.document || typeof command.document.text !== 'string') return null;
  return command as DocumentCommand;
}

/** A verbatim span of the page: the selection, else its first non-empty line. */
function sourceSpan(command: DocumentCommand): string | null {
  const selected = command.document.selection?.text?.trim();
  if (selected && command.document.text.includes(selected)) return selected;
  const line = command.document.text.split('\n').map((l) => l.trim()).find(Boolean);
  return line ?? null;
}

/**
 * The drafter's reply text for a document command, or null when the input is
 * not one (every other question keeps the keyword table). The command is the
 * invoke body's `payload` — the runtime's structured input, which the route
 * spreads at the top of the drafter's payload — or, from an older caller, the
 * same JSON as the `message` string.
 */
export function documentEditReply(input: unknown): string | null {
  const command = readDocumentCommand(input);
  if (!command) return null;
  const placement = command.document.selection?.text?.trim() ? 'replace' : 'insert';
  const edit = documentAgentEdits.rows().find((row) => row.placement === placement);
  if (!edit) return JSON.stringify({ agent: 'assessment-drafter', error: 'No edit was drafted for this instruction.' });
  const span = sourceSpan(command);
  return JSON.stringify({
    summary: edit.summary,
    content: edit.content,
    format: 'markdown',
    source_spans: span ? [span] : [],
    draft: true,
    published: false,
  });
}
