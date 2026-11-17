// The pad log, reported from either side (row I4.3; contract U3). `base` is the side's path (as useInterviewRuns).
// The pad's own edits, pastes, language changes and inserted questions are batched (lib/interviewsPad.ts
// `PadLogBatcher`) and posted every few seconds, when the pad goes and when the page is hidden; a snapshot of the
// text goes every 30 seconds while it has changed, and one at each Run. Best effort: a refused or failed post is
// dropped and never blocks typing or shows anything.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CodePadEdit, CodePadPaste } from '@connorhoehn/ui-components/code-pad';
import { PadLogBatcher, editEvent, insertEvent, languageEvent, pasteEvent, postPadEvents } from '../../../lib/interviewsPad';

const TICK_MS = 1_000;

export interface PadLogReporter {
  onLocalEdit(e: CodePadEdit): void;
  onPaste(p: CodePadPaste): void;
  onLanguageChange(language: string): void;
  onInsert(q: { id: string }): void;
  /** A snapshot now (Run sends one). */
  snapshot(text: string, language: string): void;
}

export function usePadLogReporter(base: string | null, read: () => { text: string; language: string } | null): PadLogReporter {
  const readRef = useRef(read);
  readRef.current = read;
  const batcher = useRef<PadLogBatcher | null>(null);
  useEffect(() => {
    if (!base) return;
    const b = new PadLogBatcher({
      now: () => Date.now(),
      post: (events, { final }) => postPadEvents(base, events, final),
      read: () => readRef.current(),
    });
    batcher.current = b;
    const tick = setInterval(() => b.tick(), TICK_MS);
    const hidden = () => b.flush(true);
    window.addEventListener('pagehide', hidden);
    return () => {
      clearInterval(tick);
      window.removeEventListener('pagehide', hidden);
      b.stop();
      if (batcher.current === b) batcher.current = null;
    };
  }, [base]);

  const onLocalEdit = useCallback((e: CodePadEdit) => batcher.current?.push(editEvent(e)), []);
  const onPaste = useCallback((p: CodePadPaste) => batcher.current?.push(pasteEvent(p)), []);
  const onLanguageChange = useCallback((language: string) => batcher.current?.push(languageEvent(language, Date.now())), []);
  const onInsert = useCallback((q: { id: string }) => batcher.current?.push(insertEvent(q.id, Date.now())), []);
  const snapshot = useCallback((text: string, language: string) => batcher.current?.snapshot(text, language), []);
  return useMemo(() => ({ onLocalEdit, onPaste, onLanguageChange, onInsert, snapshot }), [onLocalEdit, onPaste, onLanguageChange, onInsert, snapshot]);
}
