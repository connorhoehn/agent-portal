import { ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import { Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import type { ComponentProps, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useShellBreadcrumbItems } from './Breadcrumbs';
import { SectionTrailContext } from './sectionTrail';
import { isBuildNavActive } from './buildNavigation';
import { UNDER_CRUMBS_BAND } from './headerRhythm';

type SubNavProps = ComponentProps<typeof SubNavLayout>;

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
  contentLabel,
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
}) {
  const { pathname, search } = useLocation();
  const breadcrumbs = useShellBreadcrumbItems();
  return <ViewportFillRegion bottomGap={0} data-testid="build-section">
    <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
      <SubNavLayout title={title} items={items} storageKey={storageKey}
        {...(titleAction ? { titleAction } : {})}
        {...(railWidth ? { railWidth } : {})}
        {...(secondaryItems?.length ? { secondaryTitle, secondaryItems, secondaryStorageKey, secondaryRailWidth } : {})}
        railLabel={`${title} navigation`} contentAs="section" contentLabel={contentLabel ?? `${title} workspace`}
        renderNavItem={renderNavItem ?? ((item, body) => {
          const active = isBuildNavActive(item.path, pathname, search);
          return <Link to={item.path} aria-current={active ? 'page' : undefined}
            className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
        })}>
        <Stack gap="none" className="h-full min-h-0 min-w-0">
          <ScopeHeader variant="crumbs" breadcrumbs={suppliedBreadcrumbs ?? breadcrumbs} />
          <Stack gap="none" className={contentPadding === 'none' ? 'min-h-0 min-w-0 flex-1 overflow-hidden' : `min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter,1.5rem)] pb-[var(--ui-page-gutter,1.5rem)] ${UNDER_CRUMBS_BAND}`} data-testid="build-section-content"><SectionTrailContext.Provider value={true}>{children}</SectionTrailContext.Provider></Stack>
        </Stack>
      </SubNavLayout>
    </Stack>
  </ViewportFillRegion>;
}
