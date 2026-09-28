/** Only list state survives moving up the initiative hierarchy. */
export function initiativeListHref(search: URLSearchParams, scope: 'all' | 'mine', sprints = false): string {
  const params = new URLSearchParams();
  if (sprints) {
    params.set('lens', 'sprints');
    for (const key of ['sprintScope', 'sprintWindow']) {
      const value = search.get(key);
      if (value) params.set(key, value);
    }
  } else {
    params.set('scope', scope);
    for (const key of ['q', 'status', 'sort']) {
      const value = search.get(key);
      if (value) params.set(key, value);
    }
  }
  return `/iq/projects?${params}`;
}

export function initiativeHref(id: string, search: URLSearchParams, scope: 'all' | 'mine', tab = 'overview'): string {
  const params = new URLSearchParams(initiativeListHref(search, scope).split('?')[1]);
  if (tab !== 'overview') params.set('tab', tab);
  return `/iq/projects/${encodeURIComponent(id)}?${params}`;
}

export interface InitiativeCrumb { label: string; href?: string }

export function initiativeBreadcrumbs({ search, scope, sprints = false, project, tab = 'overview', item, sprint }: {
  search: URLSearchParams;
  scope: 'all' | 'mine';
  sprints?: boolean;
  project?: { id: string; name: string };
  tab?: string;
  item?: string;
  sprint?: string;
}): InitiativeCrumb[] {
  const base: InitiativeCrumb[] = [{ label: 'Plan' }, { label: 'Initiatives', href: '/iq/projects?nav=section' }];
  const label = sprints ? 'Sprints' : scope === 'all' ? 'All initiatives' : 'My initiatives';
  base.push({ label, ...(project || sprint ? { href: initiativeListHref(search, scope, sprints) } : {}) });
  if (sprint) base.push({ label: sprint });
  if (project) {
    base.push({ label: project.name, ...(tab !== 'overview' ? { href: initiativeHref(project.id, search, scope) } : {}) });
    if (tab !== 'overview') base.push({
      label: tab.charAt(0).toUpperCase() + tab.slice(1),
      ...(item ? { href: initiativeHref(project.id, search, scope, tab) } : {}),
    });
    if (item) base.push({ label: item });
  }
  return base;
}
