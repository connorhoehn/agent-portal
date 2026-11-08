// The page's side of its comments: threads as cards in the margin beside the
// sentence they point at, the pinned ranges painted in the prose, and
// "Comment" on a selection — the same three things realtime-examples' canvas
// pane does (canvas/useCanvasGutterItems.tsx, CanvasCommentComposer.tsx),
// over the same library and realtime-modules pieces: `CommentThreadNode` in
// `GutterItem`s for CanvasDocumentView's gutter, the `CommentHighlight`
// extension for the marks, `createAnchor` / `plainRangeFromPm` /
// `resolveAnchor` / `pmRangesFromPlain` for the Y.js relative positions.
//
// Placement follows the reference's rules, reduced to the two kinds this
// accelerator has (no sections): ANCHORED — the anchor resolved, the card sits
// beside its text; UNPLACED — a document-wide thread (every imported one), or
// an anchor whose text was deleted (ORPHANED, which says so in its quote
// header), stacked below everything that has a position. Nothing is ever put
// at 0 to mean "unknown".

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommentThreadNode, type GutterItem } from '@connorhoehn/ui-components/doc-editor';
import { Button, InlineAlert, Modal, Stack, Textarea, Inline, T } from '@connorhoehn/ui-components/shared';
import { CommentHighlight, createAnchor, plainRangeFromPm, pmRangesFromPlain, resolveAnchor, isCanvasAnchor, type CanvasAnchor, type CommentHighlightRef } from '@connorhoehn/realtime-modules/adapters/tiptap';
import { CANVAS_BODY_KEY } from '@connorhoehn/realtime-modules/client';
import type { Editor } from '@tiptap/react';
import type * as Y from 'yjs';
import type { CommentThreadView } from './documentCommentsModel';
import type { DocumentCommentsState } from './useDocumentComments';

type ThreadComment = Parameters<typeof CommentThreadNode>[0]['comment'];
const STACK_TOP = 24;

/** The per-document highlight extension; its click handler is read through a ref (the plugin list is built once). */
export function useCommentHighlightExtension(onClick: (id: string) => void) {
  const click = useRef(onClick);
  click.current = onClick;
  return useMemo(() => CommentHighlight.configure({
    ydoc: null, fragmentKey: CANVAS_BODY_KEY, comments: [], hideResolved: false, classPrefix: 'canvas-comment',
    onCommentClick: (id: string) => click.current(id),
  }), []);
}

/** A mounted editor. Tiptap 3's `view` getter throws until the view exists, so ask carefully. */
export function live(editor: Editor | null): editor is Editor {
  if (!editor || editor.isDestroyed) return false;
  try { return !!editor.view?.dom?.isConnected; } catch { return false; }
}

function pageOf(editor: Editor | null): HTMLElement | null {
  if (!live(editor)) return null;
  return (editor.view.dom as HTMLElement).closest('.doc-page') as HTMLElement | null;
}

interface Measurement { anchored: Map<string, number>; orphaned: Set<string>; quotes: Map<string, string>; lowestHeading: number }
const EMPTY: Measurement = { anchored: new Map(), orphaned: new Set(), quotes: new Map(), lowestHeading: 0 };

function same(a: Measurement, b: Measurement): boolean {
  if (a.lowestHeading !== b.lowestHeading || a.anchored.size !== b.anchored.size || a.orphaned.size !== b.orphaned.size || a.quotes.size !== b.quotes.size) return false;
  for (const [k, v] of a.anchored) if (b.anchored.get(k) !== v) return false;
  for (const k of a.orphaned) if (!b.orphaned.has(k)) return false;
  for (const [k, v] of a.quotes) if (b.quotes.get(k) !== v) return false;
  return true;
}

export function useCanvasComments({ editor, ydoc, comments, canComment }: {
  editor: Editor | null; ydoc: Y.Doc | null; comments: DocumentCommentsState; canComment: boolean;
}) {
  const threads = comments.threads;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const [measurement, setMeasurement] = useState<Measurement>(EMPTY);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const measure = useCallback(() => {
    const page = pageOf(editor);
    const next: Measurement = { anchored: new Map(), orphaned: new Set(), quotes: new Map(), lowestHeading: 0 };
    if (live(editor) && ydoc && page) {
      const pageTop = page.getBoundingClientRect().top;
      // Unplaced threads stack below every heading, so a lone document-wide
      // comment never sits beside the title as if it were about it.
      for (const heading of Array.from((editor.view.dom as HTMLElement).querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
        next.lowestHeading = Math.max(next.lowestHeading, Math.round(heading.getBoundingClientRect().top - pageTop));
      }
      for (const thread of threadsRef.current) {
        const anchor = isCanvasAnchor(thread.anchor) ? thread.anchor : null;
        if (!anchor) continue;
        if (anchor.key !== CANVAS_BODY_KEY) { next.orphaned.add(thread.id); continue; }
        let range: ReturnType<typeof resolveAnchor> = null;
        try { range = resolveAnchor(ydoc, anchor); } catch { range = null; }
        if (!range) { next.orphaned.add(thread.id); continue; }
        const ranges = pmRangesFromPlain(editor.state.doc, range.from, range.to);
        const first = ranges[0];
        if (!first) continue; // out of step for a frame; measured on the next pass
        try {
          const top = Math.max(0, Math.round(editor.view.coordsAtPos(first.from).top - pageTop));
          next.anchored.set(thread.id, top);
          const text = ranges.map(r => editor.state.doc.textBetween(r.from, r.to)).filter(Boolean).join(' · ');
          if (text) next.quotes.set(thread.id, text);
        } catch { /* measured on the next pass */ }
      }
    }
    setMeasurement(prev => (same(prev, next) ? prev : next));
  }, [editor, ydoc]);

  useEffect(() => {
    if (!live(editor)) return;
    measure();
    editor.on('update', measure);
    window.addEventListener('resize', measure);
    const page = pageOf(editor);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (observer && page) observer.observe(page);
    const frame = requestAnimationFrame(measure);
    return () => { editor.off('update', measure); window.removeEventListener('resize', measure); observer?.disconnect(); cancelAnimationFrame(frame); };
  }, [editor, measure, threads]);

  // The marks: this document's Y.Doc, then the anchored threads that resolved.
  const highlights = useMemo<CommentHighlightRef[]>(() => threads
    .filter(t => isCanvasAnchor(t.anchor) && measurement.anchored.has(t.id))
    .map(t => ({ id: t.id, anchor: t.anchor as CanvasAnchor, state: focusedId === t.id || hoveredId === t.id ? 'active' : t.resolved ? 'resolved' : 'open' })),
  [threads, measurement, focusedId, hoveredId]);
  useEffect(() => { if (live(editor)) editor.commands.setCommentHighlightDocument(ydoc); }, [editor, ydoc]);
  useEffect(() => { if (live(editor)) editor.commands.setCommentHighlights([...highlights]); }, [editor, highlights]);

  const gutterItems = useMemo<GutterItem[]>(() => {
    // Below everything that HAS a position; +1 so a tie never puts an
    // unplaced card above the anchored one it would collide with.
    let stackTop = Math.max(STACK_TOP, measurement.lowestHeading);
    for (const top of measurement.anchored.values()) stackTop = Math.max(stackTop, top);
    stackTop += 1;
    const placedFirst = [...threads].sort((a, b) => Number(!measurement.anchored.has(a.id)) - Number(!measurement.anchored.has(b.id))
      || (measurement.anchored.get(a.id) ?? 0) - (measurement.anchored.get(b.id) ?? 0));
    return placedFirst.map((thread: CommentThreadView): GutterItem => {
      const top = measurement.anchored.get(thread.id);
      const context = thread.anchor
        ? measurement.orphaned.has(thread.id)
          ? { kind: 'removed' as const, text: thread.anchor.quote || 'No quoted text was recorded.' }
          : { kind: 'quote' as const, text: measurement.quotes.get(thread.id) ?? thread.anchor.quote }
        : { kind: 'document' as const };
      return {
        id: thread.id, kind: 'comment', top: top ?? stackTop, active: focusedId === thread.id,
        content: <CommentThreadNode comment={thread as ThreadComment} context={context} depth={0} mentionUsers={[]}
          onReply={(parentId, text) => { void comments.reply(parentId, text).catch(() => undefined); }}
          onResolveThread={id => { void comments.resolve(id, true).catch(() => undefined); }}
          onUnresolveThread={id => { void comments.resolve(id, false).catch(() => undefined); }} />,
      };
    });
  }, [threads, measurement, focusedId, comments]);

  // ── Comment on a selection ──────────────────────────────────────────────
  const [selectable, setSelectable] = useState(false);
  useEffect(() => {
    if (!live(editor)) { setSelectable(false); return; }
    const sync = () => {
      if (!live(editor)) return;
      const { from, to } = editor.state.selection;
      setSelectable(plainRangeFromPm(editor.state.doc, from, to) !== null);
    };
    sync();
    editor.on('selectionUpdate', sync);
    editor.on('transaction', sync);
    return () => { editor.off('selectionUpdate', sync); editor.off('transaction', sync); };
  }, [editor]);
  const [draftAnchor, setDraftAnchor] = useState<CanvasAnchor | null>(null);
  const [draft, setDraft] = useState('');
  const [anchorError, setAnchorError] = useState<string | null>(null);
  // Taken at CLICK time: opening the dialog moves focus and the selection with it.
  // The button lives in the document head, not the canvas toolbar: a reader
  // (no toolbar) comments too — commenting is not editing.
  const startComment = () => {
    if (!live(editor) || !ydoc) return;
    const { from, to } = editor.state.selection;
    const range = plainRangeFromPm(editor.state.doc, from, to);
    if (!range) return;
    try { setDraftAnchor(createAnchor(ydoc, CANVAS_BODY_KEY, range.from, range.to)); setDraft(''); setAnchorError(null); }
    catch (cause) { setAnchorError(cause instanceof Error ? cause.message : 'That selection cannot hold a comment.'); }
  };
  const submit = async () => {
    const text = draft.trim();
    if (!draftAnchor || !text) return;
    try { await comments.addAnchoredComment(text, draftAnchor); setDraftAnchor(null); setDraft(''); }
    catch (cause) { setAnchorError(cause instanceof Error ? cause.message : 'The comment could not be saved.'); }
  };
  const commentButton: ReactNode = canComment
    ? <Button size="sm" variant="secondary" disabled={!selectable} onClick={startComment}
      title={selectable ? 'Comment on the selected text' : 'Select text on the page to comment on it'} data-testid="canvas-comment-button">Comment</Button>
    : null;
  const composer: ReactNode = <Modal open={!!draftAnchor} onClose={() => { if (!comments.pending) setDraftAnchor(null); }} title="Comment on selection">
    <Stack gap="sm" data-testid="canvas-comment-composer">
      {anchorError && <InlineAlert tone="error">{anchorError}</InlineAlert>}
      <T size="sm" className="text-text-secondary">{`“${draftAnchor?.quote ?? ''}”`}</T>
      <Textarea value={draft} onChange={event => setDraft(event.target.value)} rows={3} autoFocus aria-label="Comment" placeholder="Add a comment…"
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
      <Inline gap="sm" justify="end">
        <Button size="sm" variant="ghost" onClick={() => setDraftAnchor(null)}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!draft.trim() || comments.pending} onClick={() => void submit()}>{comments.pending ? 'Posting…' : 'Comment'}</Button>
      </Inline>
    </Stack>
  </Modal>;

  return {
    gutterItems, commentButton, composer,
    onFocusGutterItem: setFocusedId, onHoverGutterItem: setHoveredId,
    focus: setFocusedId,
  };
}
