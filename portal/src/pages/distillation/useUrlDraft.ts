// A field whose value lives in the URL but whose typing must not wait for the
// router. See urlDraftModel.ts for why a box bound straight to the URL loses
// keystrokes, and for the rule that decides when the URL may overwrite it.
//
// The field updates on every key; the URL is written `debounceMs` after the
// value settles (0 for a select, where each change is one deliberate act).
// `resetKey` names a scope change — a different view, say — across which the
// URL always wins, whatever the box held.

import { useEffect, useRef, useState } from 'react';
import { adoptUrlValue, draftValue, needsCommit, type DraftState } from './urlDraftModel';

export function useUrlDraft(
  urlValue: string,
  commit: (value: string) => void,
  { debounceMs = 250, resetKey }: { debounceMs?: number; resetKey?: string } = {},
): [string, (text: string) => void] {
  const [text, setTextState] = useState(urlValue);
  const state = useRef<DraftState>({ text: urlValue, pending: [] });
  const setText = (next: string) => { state.current.text = next; setTextState(next); };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const scope = useRef(resetKey);

  useEffect(() => {
    const scopeChanged = scope.current !== resetKey;
    scope.current = resetKey;
    const next = scopeChanged ? { text: urlValue, pending: [] } : adoptUrlValue(state.current, urlValue);
    state.current = next;
    setTextState(next.text);
  }, [urlValue, resetKey]);

  useEffect(() => {
    // Read through the ref: when the URL just moved (Back), the effect above
    // has already adopted it there, while `text` is still the pre-Back render's
    // and would be written straight back over the navigation.
    const current = state.current.text;
    if (!needsCommit(current, urlValue)) return undefined;
    const value = draftValue(current);
    const write = () => {
      state.current.pending = [...state.current.pending, value];
      commitRef.current(value);
    };
    if (debounceMs <= 0) { write(); return undefined; }
    const t = setTimeout(write, debounceMs);
    return () => clearTimeout(t);
  }, [text, urlValue, debounceMs]);

  return [text, setText];
}
