// Debounced POST /decks/:id/preview for PresentationEditor's `onRequestPreview`.
// The editor calls it on every spec change, so this is the only caller of the
// render route: one request per pause, stale answers dropped, identical specs
// served from memory, a failed render retried when asked again.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PresentationPreview } from '@connorhoehn/ui-components/doc-editor';
import type { DeckPreviewResult, DeckSpec } from './deckApi';
import { DECK_PREVIEW_DEBOUNCE_MS, deckRenderKey } from './decksModel';

/** `render` is the tenant's preview call (every tenant's takes the same arguments and returns the same shape). */
export function useDeckPreview(
  deckId: string, onWarnings: ((warnings: string[]) => void) | undefined,
  render: (deckId: string, spec: DeckSpec, signal?: AbortSignal) => Promise<DeckPreviewResult>,
) {
  // Keep the result and its render identity together. The canvas may keep
  // its last image while refreshing, but Present must use the current spec.
  const [state, setState] = useState<{ preview: PresentationPreview; renderedKey: string | null }>({ preview: 'loading', renderedKey: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastKey = useRef<string | null>(null);
  const failed = useRef(false);
  const cache = useRef(new Map<string, { slides: PresentationPreview; warnings: string[] }>());
  const warn = useRef(onWarnings);
  warn.current = onWarnings;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
    // StrictMode replays effects after cleanup. A cancelled request is not a
    // cached result; let the reader request the same spec again.
    lastKey.current = null;
  }, []);

  const request = useCallback((spec: DeckSpec) => {
    const key = deckRenderKey(spec);
    const requestKey = `${deckId}\0${key}`;
    if (requestKey === lastKey.current && !failed.current) return;
    lastKey.current = requestKey;
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
    const hit = cache.current.get(requestKey);
    if (hit) {
      failed.current = false;
      setState({ preview: hit.slides, renderedKey: key });
      warn.current?.(hit.warnings);
      return;
    }
    setState(current => typeof current.preview === 'object' && 'slides' in current.preview
      ? current : { preview: 'loading', renderedKey: null });
    timer.current = setTimeout(() => {
      const ctl = new AbortController();
      controller.current = ctl;
      const timeout = setTimeout(() => {
        if (ctl.signal.aborted) return;
        failed.current = true;
        setState({ preview: { error: 'The slide preview took too long. Retry preview to try again.' }, renderedKey: null });
        ctl.abort();
      }, 45_000);
      render(deckId, spec, ctl.signal).then((result) => {
        if (ctl.signal.aborted) return;
        const slides: PresentationPreview = { slides: result.slides };
        cache.current.set(requestKey, { slides, warnings: result.warnings });
        failed.current = false;
        setState({ preview: slides, renderedKey: key });
        warn.current?.(result.warnings);
      }).catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        failed.current = true;
        setState({ preview: { error: err instanceof Error ? err.message : 'The preview could not be drawn.' }, renderedKey: null });
      }).finally(() => clearTimeout(timeout));
    }, DECK_PREVIEW_DEBOUNCE_MS);
  }, [deckId, render]);

  return { ...state, request };
}
