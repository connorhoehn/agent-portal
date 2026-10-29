import { DockedColumn, ListRailLayout, ScopeHeader, ViewportFillRegion, type ListRail } from '@connorhoehnslalom/ui-components';
import { Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import type { ComponentProps, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useShellBreadcrumbItems } from './Breadcrumbs';
import { SectionTrailContext } from './sectionTrail';
import { isBuildNavActive } from './buildNavigation';
import { UNDER_CRUMBS_BAND } from './headerRhythm';
import { SectionHeader } from './SectionContent';

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
  /** Given, the content column becomes the library `ListRailLayout`: the page's
   *  list as a flush rail beside the section rail, then the trail and the title
   *  (`SectionHeader`) as the content column's first rows. */
  list?: SectionListRail;
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
        {list ? (
          <ListRailLayout
            header={<SectionHeader breadcrumbs={suppliedBreadcrumbs ?? breadcrumbs} title={list.title} {...(list.description ? { description: list.description } : {})} />}
            list={list.rail}
            {...(list.footer != null ? { footer: list.footer } : {})}
            data-testid="build-section-list"
          >
            <Stack gap="md" className="w-full min-w-0 px-[var(--ui-page-gutter,1.5rem)] pb-[var(--ui-page-gutter,1.5rem)]" data-testid="build-section-content">
              <SectionTrailContext.Provider value={true}>{children}</SectionTrailContext.Provider>
            </Stack>
          </ListRailLayout>
        ) : <Stack gap="none" className="h-full min-h-0 min-w-0">
          <ScopeHeader variant="crumbs" breadcrumbs={suppliedBreadcrumbs ?? breadcrumbs} />
          {/* The content column: a scrolling body over the column's dock, where a
              section's command composer docks (ColumnDock) at the bottom, spanning
              the column, with nothing below it (docs/layout-cascade.md). */}
          <DockedColumn body={contentPadding === 'none' ? 'fill' : 'scroll'}
            bodyClassName={contentPadding === 'none' ? 'flex flex-col' : `flex flex-col px-[var(--ui-page-gutter,1.5rem)] pb-[var(--ui-page-gutter,1.5rem)] ${UNDER_CRUMBS_BAND}`}
            bodyProps={{ 'data-testid': 'build-section-content' }}><SectionTrailContext.Provider value={true}>{children}</SectionTrailContext.Provider></DockedColumn>
        </Stack>}
      </SubNavLayout>
    </Stack>
  </ViewportFillRegion>;
}
