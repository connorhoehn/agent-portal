// A cancellable debouncer — the pure timer logic behind useDebouncedSearch.ts,
// split out the same way pollSchedule.ts is split from useFetch.ts: this repo's
// test setup is plain node:test with no React renderer or jsdom, so the part
// worth pinning is the scheduling, not the hook that wraps it in React state.

export interface Debouncer<T> {
  /** Schedule `fn(value)` for `ms` from now, cancelling any run still pending
   *  from an earlier `trigger`. */
  trigger(value: T): void;
  /** Cancel a pending run, if one is scheduled. A no-op otherwise. */
  cancel(): void;
}

/**
 * `createDebouncer(fn, ms)` — calls `fn(value)` `ms` milliseconds after the
 * MOST RECENT `trigger`, unless another `trigger` or a `cancel` arrives
 * first. This is TiersPage.tsx's original inline pattern —
 *
 *   if (searchTimer.current) clearTimeout(searchTimer.current);
 *   searchTimer.current = setTimeout(() => setFilter('q', value), MS);
 *
 * — with nothing React-specific in it, so it is the piece a node:test can
 * exercise directly.
 */
export function createDebouncer<T>(fn: (value: T) => void, ms: number): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger(value: T) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(value);
      }, ms);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
