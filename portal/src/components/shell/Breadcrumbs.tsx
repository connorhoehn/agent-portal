// Breadcrumb trail for deep pages. Two stacked rails tell you what you CAN
// open, not where you ARE — three levels in (/admin/ingest/history) nothing on
// screen said "this is Knowledge → Pipeline → Runs". The trail is derived from
// the route in one place, so every page gets it without per-page wiring, and it
// only renders at 3+ levels — on shallow pages the rail already is the answer.
//
// Group crumbs (Build/Org/Operate/System) are context, not destinations —
// they render unlinked. Everything else links except the current page.

import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ScopeHeader } from '@connorhoehnslalom/ui-components';
import { Breadcrumbs as UIBreadcrumbs, type BreadcrumbItem } from '@connorhoehnslalom/ui-components/shared';

import { resolveBreadcrumbs } from './breadcrumbResolve';
import { useCrumbLabels } from '../../lib/crumbLabels';
export type { Crumb } from './breadcrumbResolve';


/** The trail's items for the current route. A flush page (`data-shell-flush`,
 *  see app.css) hides the shell's own row and hands these to its header, so
 *  the trail reads the same either way. */
export function useShellBreadcrumbItems() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // A detail page that fetched its entity registers the title under the id
  // the resolver put on the crumb; until it does (or if it never does) the
  // shortened id stands.
  const titles = useCrumbLabels();
  const crumbs = useMemo(
    () => resolveBreadcrumbs(pathname).map((c) => {
      const title = c.id ? titles.get(c.id) : undefined;
      return title ? { ...c, label: title } : c;
    }),
    [pathname, titles],
  );

  // Group crumbs (Build/Org/Operate/System) are context, not destinations, so
  // they carry no href and the library renders them as plain text. The last
  // crumb is the current page and is never a link either.
  //
  // Both href AND onClick: the href keeps it a real link — middle-click,
  // open-in-new-tab, and what a screen reader announces — while the handler
  // does the SPA navigation. href alone would full-page reload this app.
  const items = useMemo(
    () => crumbs.map((crumb, i) => {
      const last = i === crumbs.length - 1;
      if (!crumb.path || last) return { label: crumb.label };
      const path = crumb.path;
      return {
        label: crumb.label,
        href: path,
        onClick: (e: React.MouseEvent) => {
          // Leave the modified clicks to the browser — they mean "somewhere else".
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as React.MouseEvent).button !== 0) return;
          e.preventDefault();
          void navigate(path);
        },
      };
    }),
    [crumbs, navigate],
  );
  return items;
}

export function Breadcrumbs() {
  const items = useShellBreadcrumbItems();
  return (
    <UIBreadcrumbs
      items={items}
      separator="›"
      // Two levels is what the rail already shows; the trail earns its row at
      // three — but every route with a section and a page gets it, because the
      // trail is part of the header rhythm. With it on every page a title
      // always sits the same distance under the same rule, so a list page and
      // a detail page line up instead of the detail title landing lower.
      minItems={2}
      className="shell-breadcrumbs shrink-0 mb-4 pb-1.5 border-b border-border text-xs overflow-x-auto whitespace-nowrap"
    />
  );
}

/**
 * The shell's trail as a flush page's first row (docs/layout-cascade.md): the
 * route's own crumbs (`useShellBreadcrumbItems`), extended by the page's
 * `tail` — a scope, a query, a selection, a session — never a trail the page
 * spells itself. With a tail, the route's last crumb links back to the route.
 * Drawn as the library trail band (`ScopeHeader variant="crumbs"`, the same
 * band `SectionHeader` draws) at the 24px gutter.
 */
export function ShellTrail({ tail = [], 'data-testid': testId = 'shell-trail' }: { tail?: BreadcrumbItem[]; 'data-testid'?: string }) {
  const base = useShellBreadcrumbItems();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const items = useMemo(() => {
    if (!tail.length || !base.length) return [...base, ...tail];
    const last = base[base.length - 1]!;
    const linked = last.href ? last : {
      ...last, href: pathname,
      onClick: (e: React.MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        void navigate(pathname);
      },
    };
    return [...base.slice(0, -1), linked, ...tail];
  }, [base, tail, pathname, navigate]);
  return <ScopeHeader variant="crumbs" breadcrumbs={items} data-testid={testId} />;
}
