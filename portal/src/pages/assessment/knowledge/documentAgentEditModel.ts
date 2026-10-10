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
export const DOCUMENT_REVISION_FEEDBACK_LIMIT = 2_000;
/** Matches the invoke route's JSON.stringify(payload).length limit. */
export const DOCUMENT_EDIT_INPUT_LIMIT = 64 * 1024;

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
    /** The original insertion caret, when revising an existing proposal. */
    cursor?: number;
  };
  revision?: {
    id: string;
    version: number;
    instruction: string;
    content: { text: string };
  };
}

export interface DocumentRevisionRequest extends DocumentEditRequest {
  document: DocumentEditRequest['document'] & { cursor: number };
  revision: NonNullable<DocumentEditRequest['revision']>;
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

/** Revise a pending draft without moving its target to the editor's current selection. */
export function buildDocumentRevisionRequest(
  feedback: string,
  context: DocumentEditContext,
  proposal: DocumentAgentProposal & { version: number },
): DocumentRevisionRequest | null {
  const ask = feedback.trim();
  if (!ask) return null;
  if (ask.length > DOCUMENT_REVISION_FEEDBACK_LIMIT) {
    throw new Error('Revision feedback must be 2,000 characters or fewer.');
  }
  const selection = proposal.kind === 'replace' && proposal.anchor !== 'cursor'
    ? { from: proposal.anchor.from, to: proposal.anchor.to, text: proposal.originalText }
    : null;
  const pageText = textPrefix(context.text, DOCUMENT_TEXT_LIMIT);
  if (!pageText.trim()) {
    throw new Error('This revision needs document text as source context. Add document text before revising.');
  }
  const request: DocumentRevisionRequest = {
    mode: DOCUMENT_EDIT_MODE,
    instruction: selection
      ? `${ask}\n\nRevise the pending replacement in revision.content.text for the original document.selection. Return only the unapplied replacement as content.`
      : `${ask}\n\nRevise the pending insertion in revision.content.text at the original document.cursor. Return only the unapplied insertion as content.`,
    document: {
      id: context.docId,
      title: context.title,
      text: pageText,
      truncated: pageText.length < context.text.length,
      selection,
      cursor: proposal.cursor,
    },
    revision: {
      id: proposal.id,
      version: proposal.version,
      instruction: proposal.instruction,
      content: { text: proposal.content.text },
    },
  };
  if (JSON.stringify(request).length <= DOCUMENT_EDIT_INPUT_LIMIT) return request;

  // Only canonical page context is expendable. Silently dropping the prior
  // draft or original target would turn a revision into a different request.
  request.document.truncated = true;
  request.document.text = '';
  if (JSON.stringify(request).length > DOCUMENT_EDIT_INPUT_LIMIT) {
    throw new Error('This draft and its original target are too large to revise. Shorten the draft or request a smaller edit.');
  }
  let lower = 0;
  let upper = pageText.length;
  while (lower < upper) {
    const length = Math.ceil((lower + upper) / 2);
    request.document.text = textPrefix(pageText, length);
    if (JSON.stringify(request).length <= DOCUMENT_EDIT_INPUT_LIMIT) lower = length;
    else upper = length - 1;
  }
  request.document.text = textPrefix(pageText, lower);
  if (!request.document.text.trim()) {
    throw new Error('This draft leaves no document text as source context. Shorten the draft or request a smaller edit.');
  }
  return request;
}

/** Do not leave half of a Unicode surrogate pair at the context boundary. */
function textPrefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length
    && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
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

/**
 * The list a refresh leaves on screen: local rows that must survive it
 * (streaming, unsaved, and a just-applied row still inside its "Applied"
 * window — the server list is only ready/applying, so without this a refresh
 * triggered by the apply itself wipes the chip within milliseconds), then the
 * server's rows, the linked target first.
 */
export function mergeRefreshedProposals<T extends { id: string; status: string }>(
  current: readonly T[], remote: readonly T[], opts: { requestedId: string | null | undefined; unsaved: (id: string) => boolean },
): T[] {
  const local = current.filter(p => p.status === 'streaming' || p.status === 'applied' || opts.unsaved(p.id));
  const localIds = new Set(local.map(p => p.id));
  const rest = remote.filter(p => !localIds.has(p.id));
  return [...rest.filter(p => p.id === opts.requestedId), ...local, ...rest.filter(p => p.id !== opts.requestedId)];
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
 * (so it flows into the paragraph at the caret, after a space when `charBefore`
 * is non-whitespace text); several insert as blocks.
 */
export function insertContentFor(markdown: string, charBefore = ''): string | InsertNode[] {
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
  if (nodes.length === 1 && nodes[0]!.type === 'paragraph') {
    // Flowing into the caret's paragraph: keep a word boundary after text.
    const text = nodes[0]!.content![0]!.text;
    return charBefore !== '' && !/\s/.test(charBefore) ? ` ${text}` : text;
  }
  return nodes;
}
