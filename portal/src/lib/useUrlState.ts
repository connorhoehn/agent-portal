// A URL-state audit found that about half the portal's list/filter/tab state
// was plain `useState` — lost on refresh, not restored by Back, unshareable.
// Two pages had already proven the pattern by hand:
// `pages/work/FindingsPage.tsx` (`?sweep=/?q=/?finding=`, replace) and
// `pages/observability/InvocationsPage.tsx` (`?agentId=/?status=`, replace,
// composed via `applyFiltersToParams`), but nothing shared it. This is that
// shared hook — one param, parsed from and serialized back into the URL,
// with every OTHER param on the URL left untouched.
//
// `nextSearch` is the pure core, exported and unit-tested on its own: given
// the current params, a key, and a value (or null to delete it), it returns
// a NEW `URLSearchParams` with exactly that key changed. Everything else on
// `current` survives verbatim — this is what lets several `useUrlState`
// calls on the same page (or a page mixing this hook with a hand-rolled
// `setSearchParams` for a facet group) coexist without one call clobbering
// another's param mid-flight.

import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';

/** Pure: returns a NEW `URLSearchParams` with `key` set to `value` (a
 *  string) or removed (`value === null`). Every other param on `current` is
 *  copied through unchanged — this never touches a key it wasn't given. */
export function nextSearch(current: URLSearchParams, key: string, value: string | null): URLSearchParams {
  const next = new URLSearchParams(current);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

export interface UseUrlStateOptions {
  /**
   * Whether a write replaces the current history entry (default) or pushes
   * a new one. Filters must not push a history entry per keystroke/click —
   * that would make Back step through every intermediate filter value
   * instead of leaving the page — so `true` is the default here, matching
   * every hand-rolled instance of this pattern already in the portal.
   */
  replace?: boolean;
}

/**
 * One URL search param as React state: `[value, setValue]`, built on
 * `useSearchParams`. `parse` turns the raw string (or `null` when the param
 * is absent) into `T`; `serialize` turns a `T` back into a string to write,
 * or `null` to delete the param entirely (so "the default value" and "no
 * param on the URL" can be the same thing — a filter reset doesn't leave a
 * stale `?status=all` sitting on the address bar).
 *
 * `parse`/`serialize` are read from a ref on every call rather than being
 * hook dependencies, so an inline arrow passed at the call site (the normal
 * way to use this) doesn't recreate the setter — and doesn't need to be
 * wrapped in `useCallback` by every caller — on every render.
 */
export function useUrlState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
  opts: UseUrlStateOptions = {},
): [T, (value: T) => void] {
  const replace = opts.replace ?? true;
  const [searchParams, setSearchParams] = useSearchParams();

  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  const value = parse(searchParams.get(key));

  const setValue = useCallback(
    (next: T) => {
      setSearchParams((prev) => nextSearch(prev, key, serializeRef.current(next)), { replace });
    },
    [setSearchParams, key, replace],
  );

  return [value, setValue];
}
