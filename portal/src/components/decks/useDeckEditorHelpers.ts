// The two small callbacks every deck page repeats: the "Slide 3 · Title" label
// presence shows for a slide, and the attachment download of the open revision.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeckSpec } from '@connorhoehn/ui-components/doc-editor';
import { downloadDeckFile } from './downloadDeckFile';

/** "Slide <n> · <title>" for a slide id, undefined when the slide is gone. */
export function useDeckSlideTitle(spec: DeckSpec | null): (slideId: string) => string | undefined {
  return useCallback((slideId: string) => {
    const index = spec?.slides.findIndex((s) => s.id === slideId) ?? -1;
    return index < 0 || !spec ? undefined : `Slide ${index + 1} · ${spec.slides[index]!.title}`;
  }, [spec]);
}

/** Downloads the open revision's .pptx through the tenant's authorized file route. */
export function useDeckDownload(fileUrl: (deckId: string, revisionId: string) => string, deckId: string, revisionId: string | null, fileName: string) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setError(null); setDownloading(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [deckId, revisionId]);
  const download = useCallback(() => {
    if (!revisionId || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setDownloading(true); setError(null);
    void downloadDeckFile(fileUrl(deckId, revisionId), fileName, controller.signal)
      .catch(reason => {
        if (pending.current === controller && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'The presentation could not be downloaded. Try again.');
        }
      }).finally(() => {
        if (pending.current === controller) { pending.current = null; setDownloading(false); }
      });
  }, [fileUrl, deckId, revisionId, fileName]);
  return { download, downloading, error };
}
