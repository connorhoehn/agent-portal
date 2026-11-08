import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '@connorhoehn/ui-components/shared';

interface NavigationGuard {
  navigate: (action: () => void) => void;
  setPending: (documentId: string, count: number) => void;
}
const Context = createContext<NavigationGuard | null>(null);

/** Guard document/library/tree selection while this workspace has unacknowledged edits. */
export function DocumentNavigationProvider({ children }: { children: ReactNode }) {
  const routerNavigate = useNavigate();
  const pending = useRef(new Map<string, number>());
  const [queued, setQueued] = useState<{ action: () => void } | null>(null);
  const setPending = useCallback((id: string, count: number) => {
    if (count > 0) pending.current.set(id, count); else pending.current.delete(id);
  }, []);
  const navigate = useCallback((action: () => void) => {
    if (pending.current.size) setQueued({ action }); else action();
  }, []);
  // App navigation lives outside the explorer's context. Capture its ordinary
  // links before the router unmounts the in-memory persistence retry queue.
  useEffect(() => {
    const onLink = (event: MouseEvent) => {
      if (!pending.current.size || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      navigate(() => routerNavigate(`${destination.pathname}${destination.search}${destination.hash}`));
    };
    document.addEventListener('click', onLink, true);
    return () => document.removeEventListener('click', onLink, true);
  }, [navigate, routerNavigate]);
  const value = useMemo(() => ({ navigate, setPending }), [navigate, setPending]);
  return <Context.Provider value={value}>
    {children}
    <ConfirmDialog open={!!queued} tone="caution" title="Leave before changes are saved?"
      body="Some changes have not reached durable storage. Stay here to finish saving. If you leave, any browser recovery copy must be restored explicitly."
      confirmLabel="Leave without saving" cancelLabel="Keep editing"
      onCancel={() => setQueued(null)} onConfirm={() => { const action = queued?.action; setQueued(null); action?.(); }} />
  </Context.Provider>;
}
export function useDocumentNavigation() { return useContext(Context); }
export function usePendingDocumentChanges(documentId: string, count: number) {
  const context = useContext(Context);
  const setPending = context?.setPending;
  useEffect(() => {
    setPending?.(documentId, count);
    return () => setPending?.(documentId, 0);
  }, [setPending, documentId, count]);
}
