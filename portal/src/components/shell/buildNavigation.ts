/** Job details belong to Runs, while the other Automate paths keep their own selection. */
export function isBuildNavActive(href: string, pathname: string, search = ''): boolean {
  pathname = pathname.replace(/\/+$/, '') || '/';
  const [path, query] = href.split('?');
  if (path === '/iq/work/queue' && /^\/iq\/work\/[^/]+\/?$/.test(pathname)
    && !['/iq/work/findings', '/iq/work/changes', '/iq/work/queue'].includes(pathname.replace(/\/$/, ''))) return true;
  if (query) {
    if (path !== pathname) return false;
    const current = new URLSearchParams(search);
    return [...new URLSearchParams(query)].every(([key, value]) => (current.get(key) ?? (key === 'view' ? 'machines' : key === 'entities' ? 'all' : null)) === value);
  }
  return path === pathname || (path !== '/iq/work' && pathname.startsWith(`${path}/`));
}
