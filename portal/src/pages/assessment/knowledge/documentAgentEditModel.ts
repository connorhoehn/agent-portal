// Agent edits from a document's composer dock (parity goal, decision 8) —
// the pure half: what is sent to the drafter, how its reply is read, and where
// the resulting proposal may land when someone presses Apply.
//
// The request is the assessment drafter's own document-command payload
// (`agents/assessment-drafter/document_commands.py`): `mode`, an `instruction`,
// and `document.text` — the text the drafter quotes its `source_spans` from.
// `suggest-confluence-content` is the mode whose contract is "proposed edits"
// to the given page; its reply is `{summary, content, format: "markdown",
// source_spans, draft: true, published: false}` (`validate_document_output`).
// The payload travels as the invoke body's `payload`, which the route hands
// the runtime as structured input — spread at the top of the drafter's
// payload, where it reads `mode` and `document` — while `message` stays the
// instruction text. `dev:mock` reads the same structured input.
//
// Nothing here touches an editor. `resolveApplyTarget` decides from plain
// values whether the proposal still fits the page; the hook does the write.

export const DOCUMENT_EDIT_AGENT_ID = 'orgiq-assessment-drafter';
export const DOCUMENT_EDIT_MODE = 'suggest-confluence-content';
/** The drafter reads the whole page; past this the page is cut, and says so. */
export const DOCUMENT_TEXT_LIMIT = 24_000;

export interface DocumentSelection {
  /** Editor positions, `from < to`. */
  from: number;
  to: number;
  text: string;
}

export interface DocumentEditContext {
  docId: string;
  title: string;
  /** The page's visible text (or its markdown export). */
  text: string;
  /** A non-empty selection, or null for "at the cursor". */
  selection: DocumentSelection | null;
  /** The caret when nothing is selected. */
  cursor: number;
}

export interface DocumentEditRequest {
  mode: typeof DOCUMENT_EDIT_MODE;
  instruction: string;
  document: {
    id: string;
    title: string;
    text: string;
    truncated: boolean;
    selection: DocumentSelection | null;
  };
}

/** `/api/agents/:id/invoke` for the drafter. */
export function documentEditInvokeUrl(agentId: string = DOCUMENT_EDIT_AGENT_ID): string {
  return `/api/agents/${encodeURIComponent(agentId)}/invoke`;
}

/** The drafter payload for one instruction, or null when there is nothing to ask. */
export function buildDocumentEditRequest(instruction: string, context: DocumentEditContext): DocumentEditRequest | null {
  const ask = instruction.trim();
  if (!ask) return null;
  const truncated = context.text.length > DOCUMENT_TEXT_LIMIT;
  const selection = context.selection && context.selection.to > context.selection.from && context.selection.text.trim()
    ? { from: context.selection.from, to: context.selection.to, text: context.selection.text }
    : null;
  return {
    mode: DOCUMENT_EDIT_MODE,
    instruction: selection
      ? `${ask}\n\nRewrite only the selected passage (document.selection.text). Return the replacement as content.`
      : `${ask}\n\nReturn only the text to insert at the cursor as content.`,
    document: {
      id: context.docId,
      title: context.title,
      text: truncated ? context.text.slice(0, DOCUMENT_TEXT_LIMIT) : context.text,
      truncated,
      selection,
    },
  };
}

/** The payload as JSON (a log line, a test fixture). */
export function documentEditMessage(request: DocumentEditRequest): string {
  return JSON.stringify(request);
}

export type DocumentEditReply =
  | { ok: true; content: string; summary?: string }
  | { ok: false; error: string };

/**
 * Read the drafter's finished reply. The contract is one JSON object with a
 * non-empty `content`; a ```json fence around it is tolerated. A reply that
 * is plain prose (a model that ignored the format) is still an edit — its
 * text is the content — but an empty one, or JSON without `content`, is not.
 */
export function parseDocumentEditReply(text: string): DocumentEditReply {
  const raw = text.trim();
  if (!raw) return { ok: false, error: 'The drafter returned nothing to insert.' };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  const body = fenced ? fenced[1]!.trim() : raw;
  if (body.startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(body); } catch { return { ok: true, content: body }; }
    const record = value as { content?: unknown; summary?: unknown; error?: unknown };
    if (typeof record.error === 'string' && record.error) return { ok: false, error: record.error };
    if (typeof record.content !== 'string' || !record.content.trim()) return { ok: false, error: 'The drafter’s reply had no content to insert.' };
    return {
      ok: true,
      content: record.content.trim(),
      ...(typeof record.summary === 'string' && record.summary.trim() ? { summary: record.summary.trim() } : {}),
    };
  }
  return { ok: true, content: body };
}

export type ProposalStatus = 'streaming' | 'ready' | 'applying' | 'applied' | 'discarded';

/** One proposed edit — the library `ProposedEdit` contract plus what Apply needs. */
export interface DocumentAgentProposal {
  id: string;
  kind: 'insert' | 'replace';
  anchor: { from: number; to: number } | 'cursor';
  content: { text: string };
  summary?: string;
  status: ProposalStatus;
  /** The selection's text when it was sent — Apply refuses if the page no longer has it there. */
  originalText: string;
  /** The caret when it was sent (insert). */
  cursor: number;
  instruction: string;
}

/** The proposal a send opens, before any reply (status `streaming`). */
export function pendingProposal(id: string, instruction: string, context: DocumentEditContext): DocumentAgentProposal {
  const selection = context.selection && context.selection.to > context.selection.from ? context.selection : null;
  return {
    id,
    kind: selection ? 'replace' : 'insert',
    anchor: selection ? { from: selection.from, to: selection.to } : 'cursor',
    content: { text: '' },
    status: 'streaming',
    originalText: selection?.text ?? '',
    cursor: context.cursor,
    instruction: instruction.trim(),
  };
}

/** The pending proposal with the finished reply in it (status `ready`). */
export function readyProposal(pending: DocumentAgentProposal, reply: Extract<DocumentEditReply, { ok: true }>): DocumentAgentProposal {
  return { ...pending, content: { text: reply.content }, ...(reply.summary ? { summary: reply.summary } : {}), status: 'ready' };
}

export type ApplyTarget =
  | { ok: true; from: number; to: number }
  | { ok: false; reason: string };

/**
 * Where Apply writes, checked against the page as it is NOW. A replacement
 * lands only if the same text still sits at the same range — a collaborator
 * (or the person) may have changed it while the drafter worked, and replacing
 * the wrong words silently is worse than asking again. An insertion lands at
 * the caret it was asked at, clamped into the page.
 */
export function resolveApplyTarget(
  proposal: Pick<DocumentAgentProposal, 'kind' | 'anchor' | 'originalText' | 'cursor'>,
  page: { size: number; textBetween: (from: number, to: number) => string },
): ApplyTarget {
  if (proposal.kind === 'replace' && proposal.anchor !== 'cursor') {
    const { from, to } = proposal.anchor;
    if (to > page.size || from < 0 || from >= to) return { ok: false, reason: 'The selected text is no longer in the page. Select it again and resend.' };
    if (page.textBetween(from, to) !== proposal.originalText) return { ok: false, reason: 'The selected text changed while the drafter worked. Select it again and resend.' };
    return { ok: true, from, to };
  }
  const at = Math.max(1, Math.min(proposal.cursor, Math.max(1, page.size - 1)));
  return { ok: true, from: at, to: at };
}

export type InsertNode =
  | { type: 'paragraph'; content?: Array<{ type: 'text'; text: string }> }
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 }; content: Array<{ type: 'text'; text: string }> };

/**
 * The proposal's markdown as editor content: one paragraph per block, `#`–`###`
 * as headings, soft line breaks joined. A single paragraph inserts as its text
 * (so it flows into the paragraph at the caret); several insert as blocks.
 */
export function insertContentFor(markdown: string): string | InsertNode[] {
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  if (blocks.length === 0) return '';
  const nodes: InsertNode[] = blocks.map((block) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(block);
    if (heading && !block.includes('\n')) {
      return { type: 'heading', attrs: { level: heading[1]!.length as 1 | 2 | 3 }, content: [{ type: 'text', text: heading[2]!.trim() }] };
    }
    const text = block.split('\n').map(l => l.trim()).join(' ');
    return { type: 'paragraph', content: [{ type: 'text', text }] };
  });
  if (nodes.length === 1 && nodes[0]!.type === 'paragraph') return nodes[0]!.content![0]!.text;
  return nodes;
}
