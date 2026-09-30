// Agent edits from a document's composer dock (parity goal, decision 8) — the
// stateful half. An instruction sent in Agent mode goes to the assessment
// drafter through the existing invoke route (AG-UI over `POST
// /api/agents/:id/invoke`, the portal's `useAgentStream`), with the page as
// context: its id, title, text, and the current selection with its range. The
// finished reply becomes a PROPOSAL, drawn by the library `ProposedEditStrip`
// in `EditorShell`'s `proposal` slot; Apply writes it into the canvas editor at
// its anchor, Discard drops it. The pure rules live in documentAgentEditModel.
//
// The editor. The canvas's TipTap editor is created inside CanvasDocumentPane,
// below the frame this hook runs in, so the pane hands it over:
// `publishDocumentEditor(docId, editor)` from its `onEditorReady`, and
// `publishDocumentEditor(docId, null)` when it unmounts. Until a pane publishes
// one, the hook falls back to the editor TipTap itself hangs on its own
// ProseMirror element (`dom.editor`, @tiptap/core) inside the page's canvas
// slot — a read of the library's own back-reference, never a second editor.

import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import { ProposedEditStrip } from '@connorhoehnslalom/ui-components/doc-editor';
import type { ComposerTaskReport } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { describeTurnError } from '../../../components/chat/turnError';
import {
  DOCUMENT_EDIT_AGENT_ID,
  buildDocumentEditRequest,
  documentEditInvokeUrl,
  insertContentFor,
  parseDocumentEditReply,
  pendingProposal,
  readyProposal,
  resolveApplyTarget,
  type DocumentAgentProposal,
  type DocumentEditContext,
  type DocumentEditRequest,
} from './documentAgentEditModel';

/** The slice of a TipTap editor this hook uses — typed structurally so any editor build fits. */
export interface DocumentEditorHandle {
  isDestroyed: boolean;
  isEditable: boolean;
  state: {
    doc: { content: { size: number }; textBetween: (from: number, to: number, blockSeparator?: string) => string };
    selection: { from: number; to: number; head: number; empty: boolean };
  };
  chain: () => { focus: () => { insertContentAt: (range: { from: number; to: number }, content: unknown) => { run: () => boolean } } };
}

// ── The editor hand-off ─────────────────────────────────────────────────────

const editors = new Map<string, DocumentEditorHandle>();
const listeners = new Set<() => void>();

/**
 * CanvasDocumentPane's side of the hand-off: call from `onEditorReady` with the
 * page's source id (`node.id`) and the editor, and with `null` on unmount.
 */
export function publishDocumentEditor(docId: string, editor: unknown): void {
  const handle = editor as DocumentEditorHandle | null;
  if (handle && !handle.isDestroyed) editors.set(docId, handle);
  else editors.delete(docId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The editor TipTap hangs on its own element, inside this page's canvas slot. */
function canvasEditorFromDom(): DocumentEditorHandle | null {
  if (typeof document === 'undefined') return null;
  const dom = document.querySelector('[data-testid="document-canvas-slot"] .ProseMirror') as (Element & { editor?: DocumentEditorHandle }) | null;
  const editor = dom?.editor;
  return editor && !editor.isDestroyed ? editor : null;
}

function useDocumentEditor(docId: string): () => DocumentEditorHandle | null {
  const published = useSyncExternalStore(subscribe, () => editors.get(docId) ?? null, () => null);
  return useCallback(() => (published && !published.isDestroyed ? published : canvasEditorFromDom()), [published]);
}

/** What the page says now: its text, the selection and the caret. */
function editContext(editor: DocumentEditorHandle, docId: string, title: string): DocumentEditContext {
  const { doc, selection } = editor.state;
  const text = doc.textBetween(0, doc.content.size, '\n');
  return {
    docId,
    title,
    text,
    selection: selection.empty ? null : { from: selection.from, to: selection.to, text: doc.textBetween(selection.from, selection.to, '\n') },
    cursor: selection.head,
  };
}

async function invokeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await fetch(input, { ...init, credentials: 'include' }); } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
    throw new Error(describeTurnError(0));
  }
  if (res.ok) return res;
  let body: string | undefined;
  try { body = await res.clone().text(); } catch { /* describeTurnError handles undefined */ }
  throw new Error(describeTurnError(res.status, body));
}

const APPLIED_VISIBLE_MS = 2500;

export interface DocumentAgentEdit {
  /** Send one Agent-mode instruction. `false` keeps the draft (nothing was sent). */
  send: (instruction: string) => boolean;
  /** The drafter is mid-turn. */
  working: boolean;
  /** The composer's TaskStrip while the drafter works. */
  task: ComposerTaskReport | null;
  /** The library strip for `EditorShell`'s `proposal` slot, or null with nothing pending. */
  strip: ReactNode;
  error: string | null;
  clearError: () => void;
  proposals: DocumentAgentProposal[];
}

export function useDocumentAgentEdit(docId: string, title: string): DocumentAgentEdit {
  const editorFor = useDocumentEditor(docId);
  const [proposals, setProposals] = useState<DocumentAgentProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<DocumentEditRequest | null>(null);
  const pendingId = useRef<string | null>(null);
  const stream = useAgentStream({
    url: documentEditInvokeUrl(DOCUMENT_EDIT_AGENT_ID),
    fetch: invokeFetch,
    // `message` is the instruction; the drafter's document command rides as
    // `payload`, which the route hands the runtime as structured input (top
    // level: mode, instruction, document) — dev:mock reads the same. No
    // sessionId: each instruction is its own turn against the page as it is now.
    buildBody: (message) => ({ message, ...(requestRef.current ? { payload: requestRef.current } : {}) }),
  });

  const update = (id: string, change: (p: DocumentAgentProposal) => DocumentAgentProposal) =>
    setProposals((all) => all.map((p) => (p.id === id ? change(p) : p)));

  // A turn finished: its last assistant message is the reply.
  const wasStreaming = useRef(false);
  useEffect(() => {
    const finished = wasStreaming.current && !stream.isStreaming;
    wasStreaming.current = stream.isStreaming;
    if (!finished || !pendingId.current) return;
    const id = pendingId.current;
    pendingId.current = null;
    if (stream.error) {
      setError(stream.error);
      update(id, (p) => ({ ...p, status: 'discarded' }));
      return;
    }
    const reply = [...stream.messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const parsed = parseDocumentEditReply(reply);
    if (!parsed.ok) {
      setError(parsed.error);
      update(id, (p) => ({ ...p, status: 'discarded' }));
      return;
    }
    update(id, (p) => readyProposal(p, parsed));
  }, [stream.isStreaming, stream.error, stream.messages]);

  const send = (instruction: string): boolean => {
    if (stream.isStreaming) { setError('The drafter is still working on the last instruction.'); return false; }
    const editor = editorFor();
    if (!editor) { setError('The page is still opening. Send the instruction again once the editor has loaded.'); return false; }
    const context = editContext(editor, docId, title);
    const request = buildDocumentEditRequest(instruction, context);
    if (!request) return false;
    const id = `edit-${Date.now().toString(36)}`;
    requestRef.current = request;
    pendingId.current = id;
    setError(null);
    // One proposal at a time: a new instruction replaces what was pending.
    setProposals([pendingProposal(id, instruction, context)]);
    stream.reset();
    void stream.sendMessage(instruction.trim());
    return true;
  };

  const discard = (id: string) => {
    if (pendingId.current === id) { pendingId.current = null; stream.reset(); }
    update(id, (p) => ({ ...p, status: 'discarded' }));
  };

  const apply = (id: string) => {
    const proposal = proposals.find((p) => p.id === id);
    const editor = editorFor();
    if (!proposal || proposal.status !== 'ready') return;
    if (!editor) { setError('The editor is not open, so the edit cannot be applied.'); return; }
    if (!editor.isEditable) { setError('This page is not editable right now, so the edit cannot be applied.'); return; }
    const page = editor.state.doc;
    const target = resolveApplyTarget(proposal, { size: page.content.size, textBetween: (from, to) => page.textBetween(from, to, '\n') });
    if (!target.ok) { setError(target.reason); return; }
    update(id, (p) => ({ ...p, status: 'applying' }));
    const done = editor.chain().focus().insertContentAt({ from: target.from, to: target.to }, insertContentFor(proposal.content.text)).run();
    if (!done) {
      setError('The editor refused the edit. Nothing was changed.');
      update(id, (p) => ({ ...p, status: 'ready' }));
      return;
    }
    setError(null);
    update(id, (p) => ({ ...p, status: 'applied' }));
    window.setTimeout(() => update(id, (p) => ({ ...p, status: 'discarded' })), APPLIED_VISIBLE_MS);
  };

  const working = stream.isStreaming;
  const visible = proposals.filter((p) => p.status !== 'discarded');
  const strip = visible.length === 0 ? null : createElement(ProposedEditStrip, {
    proposals: visible,
    onApply: apply,
    onDiscard: discard,
    'data-testid': 'document-agent-edit',
  });
  const task: ComposerTaskReport | null = working
    ? { label: 'Drafting an edit', status: 'running', phase: 'Assessment drafter', onStop: () => { if (pendingId.current) discard(pendingId.current); } }
    : null;
  return { send, working, task, strip, error, clearError: () => setError(null), proposals };
}
