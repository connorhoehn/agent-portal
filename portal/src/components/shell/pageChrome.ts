// The page chrome fold (contract U5; docs/interviews-tenant-plan.md decision 21): while a mounted page asks for it,
// the shell (Layout.tsx) draws no trail row, keeps the primary rail folded and drops the content gutter, so a live
// call takes the window. The shell header and the footer stay. Only the interview room asks today, from the moment
// its call is drawn until it is left or ended; every other page leaves it alone and the shell renders as before.
// Only Layout.tsx reads `usePageChromeFolded`.
import { useEffect, useSyncExternalStore } from 'react';

const folds = new Set<symbol>();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** True while at least one mounted page holds a fold. */
export const pageChromeFolded = (): boolean => folds.size > 0;

/** Hold a fold until the returned release is called (the hook's effect; exported for the unit test). */
export function holdPageChromeFold(): () => void {
  const token = Symbol('page-chrome-fold');
  folds.add(token);
  emit();
  return () => { if (folds.delete(token)) emit(); };
}

/** A page asks the shell to fold its chrome while `active`; it comes back when the page passes false or unmounts. */
export function usePageChromeFold(active: boolean): void {
  useEffect(() => (active ? holdPageChromeFold() : undefined), [active]);
}

/** The shell's read: false unless a page holds a fold. */
export function usePageChromeFolded(): boolean {
  return useSyncExternalStore(subscribe, pageChromeFolded, () => false);
}
