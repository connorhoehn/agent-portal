// Stable hierarchy: Initiative views → initiative/sprint list → content.
// Project tabs retain their parents; Work adds its own list inside the pane.
// The section parent closes descendants; URL-backed breadcrumbs reopen them.

import { useCallback, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  ExplorerLayout,
  ScopeHeader,
  ViewportFillRegion,
  type WorkspaceRailBack,
} from '@connorhoehnslalom/ui-components';
import { Breadcrumbs, EmptyState, RailNavList, Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName } from '@connorhoehnslalom/ui-components/shared';
import { initiativeBreadcrumbs, initiativeListHref, type InitiativeCrumb } from './initiativeNavigation';

/**
 * Slots for the initiative/sprint list, shared by list and detail routes.
 */
export interface ExplorerRailSlots {
  scope?: 'all' | 'mine';
  lens?: 'initiatives' | 'sprints';
  /** "All initiatives", "My initiatives", or "Sprints". */
  railTitle: string;
  /** The count chip after the title. Omit when it is unknown or capped. */
  railCount?: number;
  /** Optional parent link above the title. */
  railBack?: WorkspaceRailBack | null;
  /** Controls in the title row, such as the sort/filter menu. */
  railActions?: ReactNode;
  /** Search under the list title. Views belong to the parent navigation. */
  railHeader?: ReactNode;
  /** The scrolling body. */
  rail: ReactNode;
  /** The fixed footer: "14 initiatives", "Personal view". */
  railFooter?: ReactNode;
  /** Offer the « fold. */
  collapsible?: boolean;
  /** What the rail holds, for the fold controls' names. */
  railLabel?: string;
}

export interface InitiativesExplorerProps extends ExplorerRailSlots {
  /** Keep views and initiative rows together, as in the initiative detail mockup. */
  combinedNavigation?: boolean;
  breadcrumbs?: InitiativeCrumb[];
  /** The band over the pane: `ScopeHeader` (title, pill, tabs). */
  paneHeader?: ReactNode;
  /** The pane body. It scrolls; the header and composer do not. */
  children: ReactNode;
  /** Docked under the pane — normally `<InitiativeComposer>`. */
  composer?: ReactNode;
  'data-testid'?: string;
}

const RAIL_FOLD_KEY = 'initiatives.rail-collapsed';

function readFolded(): boolean {
  try { return localStorage.getItem(RAIL_FOLD_KEY) === '1'; } catch { return false; }
}

export function InitiativesExplorer({
  railTitle, railCount, railBack, railActions, railHeader, rail, railFooter,
  collapsible = false, railLabel = 'initiatives',
  paneHeader, children, composer, scope = 'all', lens = 'initiatives', breadcrumbs, combinedNavigation = false, 'data-testid': testId,
}: InitiativesExplorerProps) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const atSection = search.get('nav') === 'section';
  const views = [
    { path: initiativeListHref(search, 'all'), label: 'All initiatives', active: lens === 'initiatives' && scope === 'all' },
    { path: initiativeListHref(search, 'mine'), label: 'My initiatives', active: lens === 'initiatives' && scope === 'mine' },
    { path: initiativeListHref(search, scope, true), label: 'Sprints', active: lens === 'sprints' },
  ];
  const trail = (breadcrumbs ?? initiativeBreadcrumbs({ search, scope, sprints: lens === 'sprints' })).map((crumb) => ({
    ...crumb,
    ...(crumb.href ? { onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(crumb.href!);
    } } : {}),
  }));
  const [folded, setFolded] = useState(readFolded);
  const toggle = useCallback(() => {
    setFolded((was) => {
      const next = !was;
      try { localStorage.setItem(RAIL_FOLD_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  return (
    <ViewportFillRegion bottomGap={0} data-testid={testId ?? 'initiatives-explorer'}>
      <Stack gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush data-initiative-stack={combinedNavigation ? undefined : true}>
        {combinedNavigation ? (
          <ExplorerLayout
            className="min-h-0 min-w-0 flex-1"
            railWidth="ms"
            railHeading="caption"
            railCountStyle="plain"
            railTitle="Initiatives"
            railCount={railCount}
            railActions={railActions}
            railLabel="initiatives"
            railHeader={<Stack gap="md">
              <RailNavList aria-label="Initiative views" currentStyle="tint" items={views.map((view) => ({
                id: view.path, href: view.path, label: view.label, current: view.active,
                onNavigate: (event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                  event.preventDefault(); navigate(view.path);
                },
              }))} />
              {railHeader}
            </Stack>}
            rail={rail}
            railFooter={railFooter}
            panePadding="none"
            paneHeader={<><Breadcrumbs items={trail} separator="›" className="px-6 pt-3 pb-1" data-testid="initiative-breadcrumbs" />{paneHeader}</>}
            paneFooter={composer}
          >{children}</ExplorerLayout>
        ) : (
        <SubNavLayout title="Initiatives" items={views} railLabel="Initiative views" contentAs="section" contentLabel="Initiatives workspace"
          renderNavItem={(item, body) => {
            const active = !atSection && views.find((view) => view.path === item.path)?.active;
            return <Link to={item.path} aria-current={active ? 'page' : undefined} className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
          }}>
        {atSection ? <Stack gap="none" className="h-full min-h-0">
          <ScopeHeader breadcrumbs={[{ label: 'Plan' }, { label: 'Initiatives' }]} title="Initiatives" />
          <EmptyState size="sm" title="Browse initiatives" description="Choose All initiatives, My initiatives, or Sprints to open its list." />
        </Stack> : (
        <ExplorerLayout
          className="min-h-0 flex-1"
          railWidth="ms"
          railHeading="caption"
          railCountStyle="chip"
          railTitle={railTitle}
          {...(railCount != null ? { railCount } : {})}
          railBack={railBack ?? null}
          railActions={railActions}
          railHeader={railHeader}
          railFooter={railFooter}
          railLabel={railLabel}
          {...(collapsible ? { railCollapsed: folded, onToggleRail: toggle } : {})}
          rail={rail}
          panePadding="none"
          asidePlacement="beside"
          paneHeader={<><Breadcrumbs items={trail} separator="›" className="px-6 pt-2 pb-1" data-testid="initiative-breadcrumbs" />{paneHeader}</>}
          paneFooter={composer}
        >
          {children}
        </ExplorerLayout>
        )}
        </SubNavLayout>
        )}
      </Stack>
    </ViewportFillRegion>
  );
}
