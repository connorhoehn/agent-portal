import { ScopeHeader, type ListRail } from '@connorhoehnslalom/ui-components';
import { SectionLayout, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type BreadcrumbItem, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import type { ComponentProps, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useShellBreadcrumbItems } from './Breadcrumbs';
import { SectionTrailContext } from './sectionTrail';
import { isBuildNavActive } from './buildNavigation';

type SubNavProps = ComponentProps<typeof SubNavLayout>;

/** A section page whose content has its own list (docs/layout-cascade.md rule 5). */
export interface SectionListRail {
  /** The library list rail beside the section rail: caption, rows, footer. */
  rail: ListRail;
  /** The view's title under the trail (rule 3: the view's name, not the record's). */
  title: string;
  description?: string;
  /** Docked under the content — the page's command composer (`CollectionCommandHost inPlace`). */
  footer?: ReactNode;
}

/** Keep the module menu beside its list and detail pages at every depth.
 *
 *  The section frame of docs/layout-cascade.md: the page is flush
 *  (`data-shell-flush` — no shell ring, no shell trail above the rail), the
 *  section rail sits against the primary rail, and the trail is the content
 *  column's first row, at the 24px gutter, with the page's own title under it.
 *  Every sectioned layout (Observability, Knowledge, Identity, Scores, Prompt
 *  Management, Budgets…) composes this rather than a bare `SubNavLayout`, which
 *  left the shell's trail spanning above the rail and the title 220px right of
 *  it. */
export function BuildSectionLayout({
  title, items, storageKey, children, contentPadding = 'md', breadcrumbs: suppliedBreadcrumbs,
  titleAction, renderNavItem, railWidth, secondaryTitle, secondaryItems, secondaryStorageKey, secondaryRailWidth,
  contentLabel, list,
}: {
  title: string;
  items: SubNavItem[];
  storageKey: string;
  children: ReactNode;
  /** Graph/canvas pages own their toolbar and surface gutters. */
  contentPadding?: 'md' | 'none';
  breadcrumbs?: ComponentProps<typeof ScopeHeader>['breadcrumbs'];
  titleAction?: ReactNode;
  /** A router-relative rail (`path: 'summary'`) brings its own `NavLink`;
   *  the default matches absolute paths with `isBuildNavActive`. */
  renderNavItem?: SubNavProps['renderNavItem'];
  railWidth?: number;
  secondaryTitle?: string;
  secondaryItems?: SubNavItem[];
  secondaryStorageKey?: string;
  secondaryRailWidth?: number;
  contentLabel?: string;
  /** Given, the page's list is a flush rail beside the section rail, then the
   *  trail and the title as the content column's first rows. */
  list?: SectionListRail;
}) {
  const { pathname, search } = useLocation();
  const shellBreadcrumbs = useShellBreadcrumbItems();
  const breadcrumbs = (suppliedBreadcrumbs ?? shellBreadcrumbs) as BreadcrumbItem[];
  const fill = !list && contentPadding === 'none';
  // The library SectionLayout is the frame (section rail, optional list rail,
  // trail row, docked body); this binding supplies the shell's trail, the
  // default router-aware rail links and the "trail already drawn" context.
  return <SectionLayout
    title={title} items={items} storageKey={storageKey}
    {...(titleAction ? { titleAction } : {})}
    {...(railWidth ? { railWidth } : {})}
    {...(secondaryItems?.length ? { secondary: { items: secondaryItems, ...(secondaryTitle ? { title: secondaryTitle } : {}), ...(secondaryStorageKey ? { storageKey: secondaryStorageKey } : {}), ...(secondaryRailWidth ? { railWidth: secondaryRailWidth } : {}) } } : {})}
    contentLabel={contentLabel ?? `${title} workspace`}
    renderNavItem={renderNavItem ?? ((item, body) => {
      const active = isBuildNavActive(item.path, pathname, search);
      return <Link to={item.path} aria-current={active ? 'page' : undefined}
        className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
    })}
    {...(list ? {
      list: list.rail,
      header: { breadcrumbs, title: list.title, ...(list.description ? { description: list.description } : {}) },
      ...(list.footer != null ? { footer: list.footer } : {}),
    } : { header: { breadcrumbs } })}
    // A canvas page owns its gutters and scrolls its own panes; no band under the trail.
    {...(fill ? { body: 'fill' as const, gutter: 'none' as const, bodyClassName: 'pt-0' } : {})}
    data-testid="build-section"
  >
    <SectionTrailContext.Provider value={true}>{children}</SectionTrailContext.Provider>
  </SectionLayout>;
}
