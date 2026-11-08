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
import { useAgentStream } from '@connorhoehn/realtime-modules/agent-streaming/client';
import { ProposedEditStrip } from '@connorhoehn/ui-components/doc-editor';
import { Button, InlineAlert, MarkdownView, Stack } from '@connorhoehn/ui-components/shared';
import { useSession } from '../../../lib/auth';
import { HttpError } from '../../../lib/writeJson';
import type { AssessmentSSEEvent } from './types';
import { applyStoredDocumentProposal, decideDocumentProposal, getDocumentProposal, listDocumentProposals, reviseDocumentProposal, storeDocumentProposal, DocumentProposalReadError, DOCUMENT_DRAFTER_LABEL, ProposalNotInsertedError, type StoredDocumentProposal } from './documentProposalClient';
import type { ComposerTaskReport } from '@connorhoehn/ui-components/social/rich-composer';
import { describeTurnError } from '../../../components/chat/turnError';
import {
  DOCUMENT_EDIT_AGENT_ID,
  buildDocumentEditRequest,
  buildDocumentRevisionRequest,
  documentEditInvokeUrl,
  insertContentFor,
  parseDocumentEditReply,
  pendingProposal,
  readyProposal,
  mergeRefreshedProposals,
  resolveApplyTarget,
  type DocumentAgentProposal,
  type DocumentEditContext,
  type DocumentEditRequest,
} from './documentAgentEditModel';
import { DocumentSuggestionReview, hasSuggestionBlocks } from './DocumentSuggestionReview';
import { allMarks, planResolution, type SuggestionMark, type SuggestionMarks } from './documentSuggestionsModel';

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

const persistence = new Map<string, (retry?: boolean) => Promise<void>>();
export interface DocumentProposalCanvasBridge {
  apply: (proposal: StoredDocumentProposal, insert: () => void) => void;
  hasReceipt: (proposal: StoredDocumentProposal) => boolean;
  confirmReceipt: (proposal: StoredDocumentProposal, retry?: boolean) => Promise<void>;
}
const proposalCanvases = new Map<string, DocumentProposalCanvasBridge>();
export function publishDocumentProposalCanvas(docId: string, bridge: DocumentProposalCanvasBridge | null): void {
  if (bridge) proposalCanvases.set(docId, bridge); else proposalCanvases.delete(docId);
  for (const listener of listeners) listener();
}

/** Bound to the canvas provider that acknowledges the canonical document save. */
export function publishDocumentPersistence(docId: string, saved: ((retry?: boolean) => Promise<void>) | null): void {
  if (saved) persistence.set(docId, saved); else persistence.delete(docId);
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

const NO_EVENTS: readonly AssessmentSSEEvent[] = [];
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'The proposed edit is unavailable.';
type LinkedProposal = { key: string; proposal?: StoredDocumentProposal; error?: string; loading?: boolean };

export function useDocumentAgentEdit(docId: string, title: string, events: readonly AssessmentSSEEvent[] = NO_EVENTS, gapped = false,
  linkOptions: { proposalId?: string | null; navigationKey?: string; focus?: boolean; documentText?: string } = {}): DocumentAgentEdit {
  const editorFor = useDocumentEditor(docId);
  const canvas = useSyncExternalStore(subscribe, () => proposalCanvases.get(docId) ?? null, () => null);
  const { session } = useSession();
  const scopeKey = `${docId}|${session?.sub ?? ''}|${session?.tenant ?? ''}|${session?.role ?? ''}`;
  const requestedId = linkOptions.proposalId || null;
  const targetKey = `${scopeKey}|${requestedId ?? ''}`;
  const target = useRef({ key: targetKey, id: requestedId });
  if (target.current.key !== targetKey) target.current = { key: targetKey, id: requestedId };
  const previousTarget = useRef(targetKey);
  const focusedTarget = useRef<string | null>(null);
  const [linked, setLinked] = useState<LinkedProposal | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const [stateScope, setStateScope] = useState(scopeKey);
  const [proposals, setProposals] = useState<DocumentAgentProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  // Reviewer intent per suggestion block, valid only for the version it was made against.
  const [marksState, setMarksState] = useState<Record<string, { version: number; marks: SuggestionMarks }>>({});
  const stored = useRef(new Map<string, StoredDocumentProposal>());
  const unsaved = useRef(new Map<string, DocumentAgentProposal>());
  const unsavedRevisions = useRef(new Map<string, { original: StoredDocumentProposal; proposal: DocumentAgentProposal }>());
  const confirming = useRef(new Map<string, { proposal: StoredDocumentProposal; saved: boolean; wait: (retry?: boolean) => Promise<void> }>());
  const busy = useRef(new Set<string>());
  const savingIds = useRef(new Set<string>());
  const refreshSequence = useRef(0);
  const requestRef = useRef<DocumentEditRequest | null>(null);
  const pending = useRef<{ proposal: DocumentAgentProposal; scope: object; revision?: StoredDocumentProposal } | null>(null);
  const stream = useAgentStream({
    url: documentEditInvokeUrl(DOCUMENT_EDIT_AGENT_ID), fetch: invokeFetch,
    buildBody: (message) => ({ message, ...(requestRef.current ? { payload: requestRef.current } : {}) }),
  });
  const streamRef = useRef(stream);
  streamRef.current = stream;

  const updateLinked = (proposal: StoredDocumentProposal) => setLinked(previous => previous?.key === target.current.key && proposal.id === target.current.id
    ? { key: previous.key, proposal } : previous);
  const replace = (proposal: DocumentAgentProposal) => {
    setProposals(all => [proposal, ...all.filter(row => row.id !== proposal.id)]);
    if ('documentId' in proposal) updateLinked(proposal as StoredDocumentProposal);
  };
  const refresh = useCallback(async () => {
    const current = scope.current;
    const requested = target.current;
    const beforeRead = new Map(stored.current);
    const sequence = ++refreshSequence.current;
    refreshController.current?.abort();
    const controller = new AbortController(); refreshController.current = controller;
    if (requested.id) setLinked(previous => previous?.key === requested.key ? previous : { key: requested.key, loading: true });
    else setLinked(null);
    const [list, exact] = await Promise.allSettled([
      listDocumentProposals(docId, controller.signal),
      requested.id ? getDocumentProposal(docId, requested.id, controller.signal) : Promise.resolve(null),
    ]);
    if (scope.current !== current || target.current !== requested || sequence !== refreshSequence.current || controller.signal.aborted) return;
    let selected = exact.status === 'fulfilled' ? exact.value?.proposal : undefined;
    // A persisted decision may finish while either GET is still in flight.
    // Keep its newer version instead of reviving stale actions from that read.
    const knownSelected = requested.id ? stored.current.get(requested.id) : undefined;
    if (selected && knownSelected && knownSelected.version > selected.version) selected = knownSelected;
    if (list.status === 'fulfilled') {
      const records = new Map(list.value.proposals.map(proposal => [proposal.id, proposal]));
      for (const [id, known] of stored.current) {
        const returned = records.get(id);
        if (returned ? known.version > returned.version : known.version > (beforeRead.get(id)?.version ?? 0)) records.set(id, known);
      }
      if (selected) {
        const listed = records.get(selected.id);
        if (listed && listed.version > selected.version) selected = listed;
        records.set(selected.id, selected);
      }
      stored.current = records;
      for (const [id, revision] of unsavedRevisions.current) {
        const row = records.get(id);
        if (row && (row.version > revision.original.version || row.status !== 'ready')) unsavedRevisions.current.delete(id);
      }
      const missingTarget = exact.status === 'rejected' && exact.reason instanceof DocumentProposalReadError && exact.reason.status === 404;
      setCanEdit(list.value.canEdit && (!requested.id || missingTarget || (exact.status === 'fulfilled' && !!exact.value?.canEdit)));
      const rows = [...records.values()].filter(proposal => proposal.status === 'ready' || proposal.status === 'applying');
      setProposals(all => mergeRefreshedProposals(all, rows, { requestedId: requested.id, unsaved: id => unsaved.current.has(id) }));
    } else {
      setCanEdit(false); setError(errorMessage(list.reason));
    }
    if (requested.id) {
      if (selected) {
        stored.current.set(selected.id, selected);
        setLinked({ key: requested.key, proposal: selected });
      } else if (exact.status === 'rejected') {
        const missing = exact.reason instanceof DocumentProposalReadError && exact.reason.status === 404;
        setLinked({ key: requested.key, error: missing ? 'The linked proposed edit is no longer available for this document.' : errorMessage(exact.reason) });
      }
    }
  }, [docId, scopeKey]);

  useEffect(() => {
    setStateScope(scopeKey); setMarksState({}); setProposals([]); setError(null); setCanEdit(false); setSaving(false);
    setLinked(null); previousTarget.current = target.current.key; focusedTarget.current = null;
    stored.current.clear(); unsaved.current.clear(); unsavedRevisions.current.clear(); confirming.current.clear(); busy.current.clear(); savingIds.current.clear();
    pending.current = null; requestRef.current = null; streamRef.current.reset();
    void refresh();
    const focus = () => { void refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, 30_000);
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); window.clearInterval(timer); refreshController.current?.abort(); };
  }, [scopeKey, refresh]);
  useEffect(() => {
    if (previousTarget.current === targetKey) return;
    previousTarget.current = targetKey;
    void refresh();
  }, [targetKey, refresh]);
  useEffect(() => {
    if (!requestedId || !linkOptions.focus || linked?.key !== targetKey || !linked.proposal) return;
    const key = `${targetKey}|${linkOptions.navigationKey ?? ''}`;
    if (focusedTarget.current === key) return;
    const focus = () => {
      const row = document.querySelector<HTMLElement>(`[data-testid="document-shell-proposal"] [data-proposal-id="${CSS.escape(requestedId)}"]`);
      if (!row) return false;
      row.tabIndex = -1;
      row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true });
      focusedTarget.current = key;
      return true;
    };
    if (focus()) return;
    // The proposal request may resolve before the document shell itself.
    const observer = new MutationObserver(() => { if (focus()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [targetKey, requestedId, linkOptions.navigationKey, linkOptions.focus, linked, proposals, canEdit]);
  const lastChange = [...events].reverse().find(event => event.type === 'knowledge.proposal.changed' && event.doc_id === docId);
  useEffect(() => { if (lastChange || gapped) void refresh(); }, [lastChange, gapped, refresh]);

  const persist = async (proposal: DocumentAgentProposal, current: object) => {
    savingIds.current.add(proposal.id); setSaving(true); unsaved.current.set(proposal.id, proposal);
    try {
      const result = await storeDocumentProposal(docId, proposal);
      if (scope.current !== current) return;
      unsaved.current.delete(proposal.id); stored.current.set(result.id, result);
      replace(result); setError(null);
    } catch (cause) { if (scope.current === current) { replace(proposal); setError(`The proposed edit could not be saved: ${errorMessage(cause)}`); } }
    finally { if (scope.current === current) { savingIds.current.delete(proposal.id); setSaving(savingIds.current.size > 0); } }
  };

  const restoreRevision = (original: StoredDocumentProposal) => replace(stored.current.get(original.id) ?? original);
  const persistRevision = async (original: StoredDocumentProposal, proposal: DocumentAgentProposal, current: object) => {
    if (savingIds.current.has(original.id)) return;
    busy.current.add(original.id); savingIds.current.add(original.id); setSaving(true);
    unsavedRevisions.current.set(original.id, { original, proposal });
    replace({ ...proposal, status: 'streaming' });
    try {
      const result = await reviseDocumentProposal(docId, original, proposal);
      if (scope.current !== current) return;
      const known = stored.current.get(result.id);
      const latest = known && known.version > result.version ? known : result;
      unsavedRevisions.current.delete(original.id); stored.current.set(result.id, latest);
      replace(latest); setError(null);
    } catch (cause) {
      if (scope.current !== current) return;
      const known = stored.current.get(original.id);
      const recorded = known?.status === 'ready' && known.version === original.version + 1 && known.decidedBy === session?.sub
        && known.instruction === proposal.instruction && known.content.text === proposal.content.text && known.summary === proposal.summary;
      if (recorded) { unsavedRevisions.current.delete(original.id); restoreRevision(original); setError(null); }
      else if (cause instanceof HttpError && cause.status >= 400 && cause.status < 500) {
        unsavedRevisions.current.delete(original.id); restoreRevision(original);
        setError(`${errorMessage(cause)} The current proposed edit is being refreshed.`); void refresh();
      } else {
        if (known && (known.version > original.version || known.status !== 'ready')) unsavedRevisions.current.delete(original.id);
        restoreRevision(original); setError(`The revision could not be saved: ${errorMessage(cause)}`);
      }
    } finally {
      if (scope.current === current) { busy.current.delete(original.id); savingIds.current.delete(original.id); setSaving(savingIds.current.size > 0); }
    }
  };

  const wasStreaming = useRef(false);
  useEffect(() => {
    const finished = wasStreaming.current && !stream.isStreaming;
    wasStreaming.current = stream.isStreaming;
    if (!finished || !pending.current) return;
    const turn = pending.current; pending.current = null;
    if (scope.current !== turn.scope) return;
    const failed = (message: string) => {
      setError(message);
      if (turn.revision) { busy.current.delete(turn.proposal.id); restoreRevision(turn.revision); }
      else replace({ ...turn.proposal, status: 'discarded' });
    };
    if (stream.error) { failed(stream.error); return; }
    const reply = [...stream.messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
    const parsed = parseDocumentEditReply(reply);
    if (!parsed.ok) { failed(parsed.error); return; }
    const ready = readyProposal(turn.proposal, parsed);
    if (turn.revision) void persistRevision(turn.revision, ready, turn.scope);
    else void persist(ready, turn.scope);
  }, [stream.isStreaming, stream.error, stream.messages]);

  const send = (instruction: string): boolean => {
    if (stream.isStreaming || pending.current || savingIds.current.size) { setError('The drafter is still working on the last instruction.'); return false; }
    if (!canEdit) { setError('Proposed edits are unavailable for this document or your current role.'); return false; }
    const editor = editorFor();
    if (!editor || !editor.isEditable) { setError('Open an editable page before asking the drafter for an edit.'); return false; }
    const context = editContext(editor, docId, title);
    const request = buildDocumentEditRequest(instruction, context);
    if (!request) return false;
    const proposal = pendingProposal(`edit-${crypto.randomUUID()}`, instruction, context);
    requestRef.current = request; pending.current = { proposal, scope: scope.current };
    setError(null); replace(proposal); stream.reset(); void stream.sendMessage(instruction.trim());
    return true;
  };

  const revise = (id: string, instruction: string) => {
    if (stream.isStreaming || pending.current || savingIds.current.size) { setError('The drafter is still working on the last instruction.'); return; }
    const original = stored.current.get(id);
    if (!original && unsaved.current.has(id)) { setError('Save this proposed edit before revising it. Use Retry saving proposed edit.'); return; }
    if (!canEdit || !original || original.status !== 'ready' || busy.current.has(id)) return;
    const editor = editorFor();
    if (!editor && linkOptions.documentText === undefined) { setError('Open the document before revising its proposed edit.'); return; }
    const context = editor ? editContext(editor, docId, title) : {
      docId, title, text: linkOptions.documentText!, selection: null, cursor: original.cursor,
    };
    let request: DocumentEditRequest | null;
    try { request = buildDocumentRevisionRequest(instruction, context, original); }
    catch (cause) { setError(errorMessage(cause)); return; }
    if (!request) return;
    const proposal: DocumentAgentProposal = { ...original, instruction: instruction.trim(), status: 'streaming' };
    unsavedRevisions.current.delete(id); busy.current.add(id);
    requestRef.current = request; pending.current = { proposal, scope: scope.current, revision: original };
    setError(null); replace(proposal); stream.reset(); void stream.sendMessage(instruction.trim());
  };

  const discard = async (id: string) => {
    if (savingIds.current.has(id)) { setError('The proposed edit is being saved. Wait for the save before discarding it.'); return; }
    if (pending.current?.proposal.id === id) {
      const turn = pending.current; pending.current = null; stream.reset();
      if (turn.revision) { busy.current.delete(id); restoreRevision(turn.revision); }
      else setProposals(all => all.filter(row => row.id !== id));
      return;
    }
    if (unsaved.current.has(id)) { unsaved.current.delete(id); setProposals(all => all.filter(row => row.id !== id)); return; }
    const proposal = stored.current.get(id); const current = scope.current;
    if (!canEdit || !proposal || proposal.status !== 'ready' || busy.current.has(id)) return;
    busy.current.add(id);
    try {
      const result = await decideDocumentProposal(docId, proposal, 'discard');
      if (scope.current === current) { unsavedRevisions.current.delete(id); stored.current.set(id, result); updateLinked(result); setProposals(all => all.filter(row => row.id !== id)); setError(null); }
    } catch (cause) { if (scope.current === current) { setError(errorMessage(cause)); void refresh(); } }
    finally { if (scope.current === current) busy.current.delete(id); }
  };

  const applied = (proposal: StoredDocumentProposal) => {
    stored.current.set(proposal.id, proposal); confirming.current.delete(proposal.id); replace(proposal); setError(null);
    const current = scope.current;
    window.setTimeout(() => { if (scope.current === current) setProposals(all => all.filter(row => row.id !== proposal.id)); }, APPLIED_VISIBLE_MS);
  };
  const retryConfirmation = async (id: string) => {
    const receipt = confirming.current.get(id); const current = scope.current;
    if (!receipt || busy.current.has(id)) return;
    busy.current.add(id);
    try {
      if (!receipt.saved) { await receipt.wait(true); receipt.saved = true; }
      const result = await decideDocumentProposal(docId, receipt.proposal, 'complete');
      if (scope.current === current) applied(result);
    } catch (cause) { if (scope.current === current) { setError(errorMessage(cause)); void refresh(); } }
    finally { if (scope.current === current) busy.current.delete(id); }
  };
  const apply = async (id: string) => {
    const proposal = stored.current.get(id); const current = scope.current;
    if (!canEdit || !proposal || proposal.status !== 'ready' || busy.current.has(id)) return;
    busy.current.add(id);
    let wait: ((retry?: boolean) => Promise<void>) | undefined;
    try {
      const result = await applyStoredDocumentProposal(proposal, {
        decide: (row, action) => decideDocumentProposal(docId, row, action),
        claimed: row => { if (scope.current === current) { unsavedRevisions.current.delete(id); stored.current.set(id, row); replace(row); } },
        insert: row => {
          if (scope.current !== current) throw new ProposalNotInsertedError('The document changed before the edit could be applied.');
          const editor = editorFor();
          const rawWait = persistence.get(docId);
          if (!editor || !editor.isEditable || !rawWait || !canvas) throw new ProposalNotInsertedError('Open the connected, editable document before applying this edit.');
          const page = editor.state.doc;
          const target = resolveApplyTarget(row, { size: page.content.size, textBetween: (from, to) => page.textBetween(from, to, '\n') });
          if (!target.ok) throw new ProposalNotInsertedError(target.reason);
          wait = retry => canvas.confirmReceipt(row, retry);
          canvas.apply(row, () => {
            if (!editor.chain().focus().insertContentAt({ from: target.from, to: target.to }, insertContentFor(row.content.text, target.from > 1 ? page.textBetween(target.from - 1, target.from) : '')).run()) throw new Error('The editor could not confirm the insertion. Check the document before making another edit.');
          });
        },
        saved: () => wait!(),
      });
      if (scope.current !== current) return;
      stored.current.set(id, result.proposal);
      if (result.state === 'applied') applied(result.proposal);
      else {
        replace(result.proposal); setError(result.error);
        if (result.state === 'pending' && wait) confirming.current.set(id, { proposal: result.proposal, saved: result.saved, wait });
      }
    } catch (cause) { if (scope.current === current) { setError(errorMessage(cause)); void refresh(); } }
    finally { if (scope.current === current) busy.current.delete(id); }
  };

  // ── Per-suggestion review (slice 9) ───────────────────────────────────────
  // A mark is local intent. When every block has a verdict the whole decision is
  // committed through the existing machinery: nothing accepted discards the
  // draft; all accepted applies it; a subset first narrows the SAME draft with
  // the revision CAS (so a lost response replays instead of duplicating), then
  // applies it through claim → receipt → save acknowledgement → complete.
  const marksFor = (row: StoredDocumentProposal): SuggestionMarks => {
    const known = marksState[row.id];
    return known && known.version === row.version ? known.marks : {};
  };
  const narrowThenApply = async (row: StoredDocumentProposal, content: string) => {
    const current = scope.current;
    busy.current.add(row.id); savingIds.current.add(row.id); setSaving(true);
    let narrowed: StoredDocumentProposal | null = null;
    try {
      const result = await reviseDocumentProposal(docId, row, { ...row, content: { text: content } });
      if (scope.current !== current) return;
      const known = stored.current.get(result.id);
      narrowed = known && known.version > result.version ? known : result;
      stored.current.set(result.id, narrowed); replace(narrowed); setError(null);
    } catch (cause) {
      if (scope.current === current) { setError(`The accepted suggestions could not be saved: ${errorMessage(cause)} Choose them again to retry.`); void refresh(); }
    } finally {
      if (scope.current === current) { busy.current.delete(row.id); savingIds.current.delete(row.id); setSaving(savingIds.current.size > 0); }
    }
    if (narrowed && narrowed.status === 'ready' && scope.current === current) await apply(row.id);
  };
  const commitResolution = (row: StoredDocumentProposal, marks: SuggestionMarks) => {
    const plan = planResolution(row.content.text, marks);
    if (plan.action === 'wait') return;
    if (plan.action === 'discard') { void discard(row.id); return; }
    if (!plan.narrowed) { void apply(row.id); return; }
    void narrowThenApply(row, plan.content);
  };
  const markSuggestion = (id: string, index: number, mark: SuggestionMark) => {
    const row = stored.current.get(id);
    if (!canEdit || !row || row.status !== 'ready' || busy.current.has(id) || savingIds.current.has(id) || unsaved.current.has(id)) return;
    const next = { ...marksFor(row), [index]: mark };
    setMarksState(all => ({ ...all, [id]: { version: row.version, marks: next } }));
    commitResolution(row, next);
  };
  const resolveAll = (id: string, mark: SuggestionMark) => {
    const row = stored.current.get(id);
    if (!canEdit || !row || row.status !== 'ready' || busy.current.has(id) || savingIds.current.has(id) || unsaved.current.has(id)) return;
    const marks = allMarks(row.content.text, mark);
    setMarksState(all => ({ ...all, [id]: { version: row.version, marks } }));
    commitResolution(row, marks);
  };

  useEffect(() => {
    if (!canvas || !canEdit) return;
    // A receipt travels with the canonical Yjs snapshot. Recover a lost
    // completion response after reload without ever inserting the edit twice.
    for (const proposal of proposals) {
      const row = stored.current.get(proposal.id);
      if (row?.status !== 'applying' || row.decidedBy !== session?.sub || busy.current.has(row.id)
        || confirming.current.has(row.id) || !canvas.hasReceipt(row)) continue;
      confirming.current.set(row.id, { proposal: row, saved: false, wait: retry => canvas.confirmReceipt(row, retry) });
      void retryConfirmation(row.id);
    }
  }, [canvas, canEdit, proposals, session?.sub]);

  const working = stream.isStreaming || saving;
  const linkedResult = linked?.key === targetKey ? linked : null;
  const selected = linkedResult?.proposal;
  const terminal = selected?.status === 'applied' || selected?.status === 'discarded';
  const visible = stateScope === scopeKey ? proposals.filter(proposal => proposal.status !== 'discarded'
    && !(proposal.id === requestedId && terminal)) : [];
  const linkNotice = !requestedId ? null : <Stack gap="sm" data-testid="document-proposal-link-notice">
    <InlineAlert tone={linkedResult?.error ? 'warning' : 'info'}>{linkedResult?.error
      ?? (terminal ? `This proposed edit was ${selected!.status}.` : selected ? 'Opened the linked proposed edit.' : 'Opening the linked proposed edit…')}</InlineAlert>
    {linkedResult?.error && <Button size="sm" variant="secondary" onClick={() => { void refresh(); }}>Retry opening proposed edit</Button>}
  </Stack>;
  const reviewedAsSuggestions = selected?.status === 'ready' && hasSuggestionBlocks(selected);
  const linkedPreview = selected && (terminal || (!canEdit && !reviewedAsSuggestions)) ? <Stack gap="sm" tabIndex={-1}
    className="min-w-0" data-testid="document-linked-proposal" data-proposal-id={selected.id} data-status={selected.status}>
    {selected.summary ? createElement(InlineAlert, { tone: 'info', children: selected.summary }) : null}
    <MarkdownView markdown={selected.content.text} className="doc-markdown" />
  </Stack> : null;
  const ordinaryStrip = visible.length === 0 ? null : !canEdit
    ? createElement(InlineAlert, { tone: 'info', children: `${visible.length} proposed ${visible.length === 1 ? 'edit awaits' : 'edits await'} an editor. Your current access is read-only.` })
    : createElement(Stack, { gap: 'sm' },
      createElement(ProposedEditStrip, { proposals: visible, onApply: (id: string) => { void apply(id); }, onDiscard: (id: string) => { void discard(id); },
        onRevise: working || unsaved.current.size > 0 ? undefined : revise, 'data-testid': 'document-agent-edit' }),
      ...visible.filter(proposal => unsaved.current.has(proposal.id) || confirming.current.has(proposal.id)).map(proposal => createElement(Button, {
        key: proposal.id, size: 'sm', variant: 'secondary', disabled: working,
        onClick: () => { const draft = unsaved.current.get(proposal.id); if (draft) void persist(draft, scope.current); else void retryConfirmation(proposal.id); },
        children: unsaved.current.has(proposal.id) ? 'Retry saving proposed edit' : 'Retry save confirmation',
      })),
      visible.some(proposal => proposal.status === 'applying') ? createElement(InlineAlert, {
        tone: 'info', children: 'A proposed edit is awaiting confirmation. Keep the document connected; a confirmed saved edit will recover without being applied again.',
      }) : null);
  const revisionPreviews = stateScope !== scopeKey ? [] : [...unsavedRevisions.current.values()]
    .filter(revision => !savingIds.current.has(revision.original.id)).map(revision => <Stack key={revision.original.id} gap="sm"
      data-testid="document-unsaved-revision" data-proposal-id={revision.original.id}>
      <InlineAlert tone="warning">This revision has not been saved. The original proposed edit remains available.</InlineAlert>
      <MarkdownView markdown={revision.proposal.content.text} className="doc-markdown" />
      {canEdit && <Button size="sm" variant="secondary" disabled={working} onClick={() => {
        if (!busy.current.has(revision.original.id)) void persistRevision(revision.original, revision.proposal, scope.current);
      }}>Retry saving revision</Button>}
    </Stack>);
  // Ready, saved drafts with more than one block get per-suggestion review. Readers see the
  // same cards with no controls (a card without handlers renders none).
  const reviews = stateScope !== scopeKey ? [] : visible
    .filter(proposal => proposal.status === 'ready' && 'documentId' in proposal && stored.current.has(proposal.id) && !unsaved.current.has(proposal.id)
      && !unsavedRevisions.current.has(proposal.id) && hasSuggestionBlocks(proposal))
    .map(proposal => stored.current.get(proposal.id)!)
    .map(row => createElement(DocumentSuggestionReview, {
      key: row.id, proposal: row, marks: marksFor(row), canResolve: canEdit, busy: working || busy.current.has(row.id),
      onMark: (index: number, mark: SuggestionMark) => markSuggestion(row.id, index, mark),
      onAcceptAll: () => resolveAll(row.id, 'accept'), onRejectAll: () => resolveAll(row.id, 'reject'),
    }));
  const strip = !linkNotice && !linkedPreview && !ordinaryStrip && reviews.length === 0 && revisionPreviews.length === 0 ? null : createElement(Stack, {
    gap: 'sm', className: 'min-w-0 max-h-72 overflow-y-auto',
  }, linkNotice, linkedPreview, ordinaryStrip, ...reviews, ...revisionPreviews);
  const task: ComposerTaskReport | null = working
    ? { label: saving ? ([...savingIds.current].some(id => unsavedRevisions.current.has(id)) ? 'Saving revised edit' : 'Saving proposed edit')
      : pending.current?.revision ? 'Revising proposed edit' : 'Drafting an edit', status: 'running', phase: DOCUMENT_DRAFTER_LABEL,
      onStop: saving ? undefined : () => { if (pending.current) void discard(pending.current.proposal.id); } }
    : null;
  return { send, working, task, strip, error: stateScope === scopeKey ? error : null, clearError: () => setError(null), proposals: stateScope === scopeKey ? proposals : [] };
}
