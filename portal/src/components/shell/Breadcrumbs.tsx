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
import { Breadcrumbs as UIBreadcrumbs } from '@connorhoehnslalom/ui-components/shared';

import { resolveBreadcrumbs } from './breadcrumbResolve';
export type { Crumb } from './breadcrumbResolve';


export function Breadcrumbs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const crumbs = useMemo(() => resolveBreadcrumbs(pathname), [pathname]);

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
      className="shrink-0 mb-4 pb-1.5 border-b border-border text-[11.5px] overflow-x-auto whitespace-nowrap"
    />
  );
}
