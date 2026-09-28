import type { ComponentProps, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import { Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useShellBreadcrumbItems } from './Breadcrumbs';
import { isBuildNavActive } from './buildNavigation';

/** Keep the module menu beside its list and detail pages at every depth. */
export function BuildSectionLayout({ title, items, storageKey, children, contentPadding = 'md', breadcrumbs: suppliedBreadcrumbs }: {
  title: string;
  items: SubNavItem[];
  storageKey: string;
  children: ReactNode;
  /** Graph/canvas pages own their toolbar and surface gutters. */
  contentPadding?: 'md' | 'none';
  breadcrumbs?: ComponentProps<typeof ScopeHeader>['breadcrumbs'];
}) {
  const { pathname, search } = useLocation();
  const breadcrumbs = useShellBreadcrumbItems();
  return <ViewportFillRegion bottomGap={0} data-testid="build-section">
    <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
      <SubNavLayout title={title} items={items} storageKey={storageKey}
        railLabel={`${title} navigation`} contentAs="section" contentLabel={`${title} workspace`}
        renderNavItem={(item, body) => {
          const active = isBuildNavActive(item.path, pathname, search);
          return <Link to={item.path} aria-current={active ? 'page' : undefined}
            className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
        }}>
        <Stack gap="none" className="h-full min-h-0 min-w-0">
          <ScopeHeader variant="crumbs" breadcrumbs={suppliedBreadcrumbs ?? breadcrumbs} />
          <div className={contentPadding === 'none' ? 'min-h-0 min-w-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto px-6 pb-6'} data-testid="build-section-content">{children}</div>
        </Stack>
      </SubNavLayout>
    </Stack>
  </ViewportFillRegion>;
}
