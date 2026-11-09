// In-app links the router does not see (G35, docs/voice-navigator-gaps.md):
// the library's job toast renders its link as a plain `<a href>` from a
// ToastProvider mounted outside the router, so following it reloads the whole
// page, which drops a live voice session (vs_95e5a6c7 closed `dropped` three
// seconds after its document job was queued). The voice pane catches a plain
// left click on such a link in the capture phase and hands the path to the
// router instead. A modified click (new tab, download), another origin or a
// target attribute is left to the browser.

/** The selector of the links routed this way: the library's job toast link. */
export const ROUTED_LINKS = 'a[data-testid="job-toast-link"]';

export interface ClickLike { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }
export interface AnchorLike { href: string; target: string; hasAttribute(name: string): boolean }

/** The in-app path a plain click on `a` should route to, else null (the browser handles it). */
export function routedPath(e: ClickLike, a: AnchorLike, origin: string): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  let url: URL;
  try { url = new URL(a.href, origin); } catch { return null; }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Install the capture-phase listener on `doc`; returns its removal. */
export function routeInAppLinks(doc: Document, navigate: (path: string) => void): () => void {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.(ROUTED_LINKS) as HTMLAnchorElement | null;
    if (!a) return;
    const path = routedPath(e, a, doc.location.origin);
    if (!path) return;
    e.preventDefault();
    navigate(path);
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
