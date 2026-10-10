// The load / spec fetch / save / 409-conflict / reload-latest state both deck
// pages (assessment DeckPage, pipelines PipelineDeckPage) share. The tenant's
// API functions come in as arguments; the page keeps its own chrome and any
// extras (assessment's agent runs, presence).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeckSpec } from '@connorhoehnslalom/ui-components/doc-editor';
import type { DeckRevisionInfo } from './deckApi';
import { openRevisionId, toEditorRevisions } from './decksModel';
import { CONFLICT_MESSAGE, deckRefreshAction, headRevisionId, keptLockedIds } from './deckDocumentModel';

export interface DeckDocumentShape {
  revisions: DeckRevisionInfo[];
  activeRevisionId: string | null;
  lockedSlideIds?: string[];
}

export interface DeckDocumentApi<D extends DeckDocumentShape> {
  getDeck: (deckId: string) => Promise<D>;
  getSpec: (deckId: string, revisionId: string, signal?: AbortSignal) => Promise<DeckSpec>;
  saveRevision: (deckId: string, spec: DeckSpec, baseRevisionId: string | null, opts: { lockedSlideIds: string[] }) => Promise<{ id: string }>;
  isConflict: (err: unknown) => boolean;
}

export interface DeckDocumentOptions<D> {
  /** Hold the first-open revision selection back (assessment: while a run is pending). */
  canAutoOpen?: (deck: D) => boolean;
  followLatest?: boolean;
}

export function useDeckDocument<D extends DeckDocumentShape>(deckId: string, api: DeckDocumentApi<D>, options: DeckDocumentOptions<D> = {}) {
  const [deck, setDeck] = useState<D | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [spec, setSpec] = useState<DeckSpec | null>(null);
  const [savedSpec, setSavedSpec] = useState<DeckSpec | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const loadedSpecFor = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const canAutoOpenRef = useRef(options.canAutoOpen);
  canAutoOpenRef.current = options.canAutoOpen;

  const dirty = !!spec && savedSpec !== spec;
  dirtyRef.current = dirty;

  const reload = useCallback(async (): Promise<D | null> => {
    try {
      const next = await apiRef.current.getDeck(deckId);
      setDeck(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The deck could not be loaded.');
      return null;
    }
  }, [deckId]);

  useEffect(() => {
    setDeck(null); setSpec(null); setSavedSpec(null); setRevisionId(null); loadedSpecFor.current = null;
    void reload();
  }, [deckId, reload]);

  // First open: land on the server's active revision.
  useEffect(() => {
    if (deck && revisionId === null && (canAutoOpenRef.current?.(deck) ?? true)) setRevisionId(openRevisionId(deck));
  }, [deck, revisionId]);

  useEffect(() => {
    if (!revisionId || loadedSpecFor.current === revisionId) return undefined;
    const ctl = new AbortController();
    apiRef.current.getSpec(deckId, revisionId, ctl.signal).then((loaded) => {
      if (ctl.signal.aborted) return;
      loadedSpecFor.current = revisionId;
      setSpec(loaded); setSavedSpec(loaded); setSpecError(null);
    }).catch((err: unknown) => {
      if (ctl.signal.aborted) return;
      setSpecError(err instanceof Error ? err.message : 'The revision could not be read.');
    });
    return () => ctl.abort();
  }, [deckId, revisionId]);

  const head = headRevisionId(deck);
  const currentRef = useRef({ head, revisionId });
  currentRef.current = { head, revisionId };

  // The server's revision remains the merge boundary. A clean editor follows
  // a teammate's save; a dirty editor keeps its draft and its original base.
  useEffect(() => {
    if (!options.followLatest) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (!live || pending || savingRef.current || document.visibilityState !== 'visible') return;
      pending = true;
      const before = currentRef.current;
      try {
        const next = await apiRef.current.getDeck(deckId);
        if (!live || savingRef.current || currentRef.current.revisionId !== before.revisionId || currentRef.current.head !== before.head) return;
        const nextHead = headRevisionId(next);
        const action = deckRefreshAction(before.revisionId, before.head, nextHead, dirtyRef.current);
        if (action === 'advance' && nextHead) {
          // Load before swapping the revision: unmounting the editor during
          // refresh loses its selected slide and interrupts the conversation.
          const loaded = await apiRef.current.getSpec(deckId, nextHead);
          if (!live || savingRef.current || currentRef.current.revisionId !== before.revisionId || currentRef.current.head !== before.head) return;
          // Someone may have started typing while the revision was loading.
          // Their draft still owns the editor; expose the newer version instead.
          if (dirtyRef.current) {
            setDeck(next); setConflict(true);
            return;
          }
          loadedSpecFor.current = nextHead;
          setSpec(loaded); setSavedSpec(loaded); setSpecError(null);
          setRevisionId(nextHead); setDeck(next);
          return;
        }
        setDeck(next);
        if (action === 'conflict') setConflict(true);
      } catch {
        // Background refresh must not replace the editor with a transient error.
      } finally { pending = false; }
    };
    const visible = () => { void refresh(); };
    const timer = window.setInterval(visible, 5_000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [deckId, options.followLatest]);
  const editorRevisions = useMemo(() => toEditorRevisions(deck?.revisions ?? []), [deck?.revisions]);
  const active = deck?.revisions.find((r) => r.id === revisionId);

  const save = useCallback(async (next: DeckSpec) => {
    savingRef.current = true;
    try {
      const saved = await apiRef.current.saveRevision(deckId, next, revisionId, { lockedSlideIds: keptLockedIds(deck?.lockedSlideIds, next.slides) });
      loadedSpecFor.current = saved.id;
      setSavedSpec(next); setRevisionId(saved.id); setConflict(false);
      void reload();
      return saved;
    } catch (err) {
      if (apiRef.current.isConflict(err)) {
        setConflict(true);
        void reload();
        throw new Error(CONFLICT_MESSAGE);
      }
      throw err;
    } finally {
      savingRef.current = false;
    }
  }, [deckId, revisionId, reload, deck?.lockedSlideIds]);

  const loadLatest = useCallback(() => {
    loadedSpecFor.current = null;
    setConflict(false); setSpec(null); setSavedSpec(null);
    void reload().then((next) => { if (next) setRevisionId(openRevisionId(next)); });
  }, [reload]);

  const selectRevision = useCallback((id: string) => {
    if (deck?.revisions.find(r => r.id === id)?.specAvailable === false) return;
    setRevisionId(id); setSpecError(null);
  }, [deck?.revisions]);

  return {
    deck, loadError, reload, revisionId, setRevisionId, spec, setSpec, specError, conflict, setConflict,
    specRevisionId: loadedSpecFor.current,
    dirty, dirtyRef, head, active, editorRevisions, save, loadLatest, selectRevision,
  };
}
