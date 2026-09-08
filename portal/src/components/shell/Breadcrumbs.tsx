// Breadcrumb trail for deep pages. Two stacked rails tell you what you CAN
// open, not where you ARE — three levels in (/admin/ingest/history) nothing on
// screen said "this is Knowledge → Pipeline → Runs". The trail is derived from
// the route in one place, so every page gets it without per-page wiring, and it
// only renders at 3+ levels — on shallow pages the rail already is the answer.
//
// Group crumbs (Build/Org/Operate/System) are context, not destinations —
// they render unlinked. Everything else links except the current page.

import { useMemo } from 'react';
import { Link, useLocation } from 'react-router';

import { resolveBreadcrumbs } from './breadcrumbResolve';
export type { Crumb } from './breadcrumbResolve';


export function Breadcrumbs() {
  const { pathname } = useLocation();
  const crumbs = useMemo(() => resolveBreadcrumbs(pathname), [pathname]);
  // Two levels is what the rail already shows; the trail earns its row at three.
  // Every route with a section and a page gets the trail — not only 3+ levels.
  // The trail is part of the header rhythm: with it on every page, a title
  // always sits the same 16px under the same rule, so a list page and a
  // detail page line up instead of the detail title landing 16px lower.
  if (crumbs.length < 2) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      // Aligned with the page title, not indented past it. This was styled as
      // a full-width bar — px-4, bg-surface, its own bottom border — but it is
      // mounted INSIDE the content column, so the bar spanned only that column
      // while pushing the trail 16px right of the <h1> directly beneath it,
      // and the title sat flush against the hairline with zero gap. Dropping
      // the horizontal padding and the fill puts the trail where a label
      // belongs (same left edge as the thing it names); mb-4 gives the title
      // room to breathe under the rule.
      className="shrink-0 mb-4 flex items-center gap-1.5 pb-1.5 border-b border-border text-[11.5px] overflow-x-auto whitespace-nowrap"
    >
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span aria-hidden="true" className="text-text-tertiary">›</span>}
            {crumb.path && !last ? (
              <Link to={crumb.path} className="text-text-secondary no-underline hover:text-primary hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span className={last ? 'text-text-primary font-semibold' : 'text-text-tertiary'}>
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
