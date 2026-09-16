// The debounced free-text search box pattern, extracted once instead of
// re-inlined per page.
//
// TiersPage.tsx originated this: the search box updates on every keystroke
// (so typing never feels laggy) while the thing that actually drives a
// fetch or a filter — a URL `?q=` param, a piece of local state — only
// updates `debounceMs` after typing stops. LibraryPage.tsx and
// LineagePage.tsx used to skip the debounce half entirely and put `query`
// straight into the fetch URL, firing a network request on every keystroke;
// ArtifactsPage.tsx did the same into a client-side filter. All three now
// share this hook rather than three slightly-different hand-rolled timers.

import { useEffect, useRef, useState } from 'react';
import { createDebouncer } from './debounce';

export interface UseDebouncedSearchResult {
  /** What the search box should show — updates immediately on every call to
   *  `onSearchChange`, never waits for the debounce. */
  searchText: string;
  /** Wire this straight to the search input's `onChange`. */
  onSearchChange: (value: string) => void;
  /** Cancel a pending debounced update — call before resetting `value`
   *  yourself (a "Clear filters" action) so a stale keystroke can't land
   *  after the reset and undo it. */
  cancelPending: () => void;
}

export function useDebouncedSearch(
  /** The current "real" value (a URL param, a piece of state) — the hook
   *  re-syncs the box to this whenever it changes from OUTSIDE a keystroke
   *  (back/forward navigation, a "Clear filters" action), without fighting
   *  its own debounce timer. */
  value: string,
  /** Called `debounceMs` after typing stops, with the latest text. */
  onChange: (value: string) => void,
  debounceMs = 250,
): UseDebouncedSearchResult {
  const [searchText, setSearchText] = useState(value);

  // Always call the LATEST onChange, without that identity churn resetting
  // the debouncer itself (a caller that doesn't memoize onChange would
  // otherwise get a fresh debouncer — and a dropped pending call — on every
  // render).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const debouncerRef = useRef<ReturnType<typeof createDebouncer<string>> | null>(null);
  if (!debouncerRef.current) {
    debouncerRef.current = createDebouncer((next: string) => onChangeRef.current(next), debounceMs);
  }

  // Keep the box in sync when `value` changes from outside typing.
  useEffect(() => { setSearchText(value); }, [value]);
  useEffect(() => () => debouncerRef.current?.cancel(), []);

  return {
    searchText,
    onSearchChange: (next: string) => {
      setSearchText(next);
      debouncerRef.current?.trigger(next);
    },
    cancelPending: () => debouncerRef.current?.cancel(),
  };
}
