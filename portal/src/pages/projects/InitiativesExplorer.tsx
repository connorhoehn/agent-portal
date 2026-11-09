// Stable hierarchy: Initiative views → initiative/sprint list → content.
// Project tabs retain their parents; focused Work uses the existing list rail.
// The section parent closes descendants; URL-backed breadcrumbs reopen them.

import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  ExplorerLayout,
  ListRailLayout,
  ViewportFillRegion,
  useSidePaneHost,
  type ListRail,
} from '@connorhoehn/ui-components';
import { Breadcrumbs, Divider, Modal, RailNavList, Stack, useRailFold, type BreadcrumbItem } from '@connorhoehn/ui-components/shared';
import { initiativeBreadcrumbs, initiativeListHref, type InitiativeCrumb } from './initiativeNavigation';
import { useDialogueRailFold } from '../../components/shell/useDialogueRailFold';

export interface InitiativesExplorerProps {
  /** The list rail (the library rail model's `ListRail`): the initiative/sprint list, or on a work item the work list. */
  rail: ListRail;
  scope?: 'all' | 'mine';
  lens?: 'initiatives' | 'sprints';
  /** Offer the « fold. */
  collapsible?: boolean;
  /** Keep views and initiative rows together, as in the initiative detail mockup. */
  combinedNavigation?: boolean;
  /** A selected item replaces initiative browsing with its existing work list. */
  focusedWork?: boolean;
  breadcrumbs?: InitiativeCrumb[];
  /**
   * The band over the pane (title, pill, tabs). A function receives the
   * clickable trail and draws it itself — the library `PageHeader`'s
   * `breadcrumbs`, so a collapsed header can fold its title into the trail.
   */
  paneHeader?: ReactNode | ((trail: BreadcrumbItem[]) => ReactNode);
  /** The pane body. It scrolls; the header and composer do not. */
  children: ReactNode;
  /** Docked under the pane — normally `<InitiativeComposer>`. */
  composer?: ReactNode;
  'data-testid'?: string;
}

// The « fold, remembered per depth band (the library rail model, `useRailFold`):
// `initiatives.rail-collapsed.shallow` on lists and records, `.deep` on a work
// item — a fold set on a list never leaves a deep page without its work list.
const RAIL_FOLD_KEY = 'initiatives.rail-collapsed';

export function InitiativesExplorer({
  rail, collapsible = false,
  paneHeader, children, composer, scope = 'all', lens = 'initiatives', breadcrumbs, combinedNavigation = false, focusedWork = false, 'data-testid': testId,
}: InitiativesExplorerProps) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { pathname } = useLocation();
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
  const railFold = useRailFold({ storageKey: RAIL_FOLD_KEY });
  const dialogue = useSidePaneHost();
  const { folded, toggle } = useDialogueRailFold(dialogue.shown, railFold, pathname);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches);
  const [mobileWorkOpen, setMobileWorkOpen] = useState(false);
  // The work list is the section rail: it stays open on a deep page. When
  // space is short the shell folds the PRIMARY rail first
  // (the shell's rail rule, Layout.tsx); this list folds only on a
  // phone-width window (the `narrow` modal) or by the reader's own «.
  const selectedItem = search.get('item');
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { setMobileWorkOpen(false); }, [selectedItem, focusedWork, narrow]);

  const viewsNav = (
    <RailNavList aria-label="Initiative views" currentStyle="tint" items={views.map((view) => ({
      id: view.path, href: view.path, label: view.label, current: view.active,
      onNavigate: (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault(); navigate(view.path);
      },
    }))} />
  );
  const navigationHeader = (
    <Stack gap="sm" className="pt-3">
      {rail.header && <>{rail.header}<Divider spacing="none" /></>}
      {viewsNav}
      <Divider spacing="none" />
    </Stack>
  );
  // The trail is the content column's first row at the 24px gutter: the
  // padding is on its row, so the trail's own box starts at the gutter.
  const crumbs = <Stack gap="none" className="px-6 pb-1 pt-3"><Breadcrumbs items={trail} separator="›" data-testid="initiative-breadcrumbs" /></Stack>;
  const band = typeof paneHeader === 'function' ? paneHeader(trail) : <>{crumbs}{paneHeader}</>;

  return (
    <ViewportFillRegion bottomGap={0} data-testid={testId ?? 'initiatives-explorer'}>
      <Stack gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush data-initiative-stack={combinedNavigation ? undefined : true}>
        {combinedNavigation ? (
          <ExplorerLayout
            className="min-h-0 min-w-0 flex-1"
            railWidth={focusedWork ? 'md' : 'ms'}
            railResize={focusedWork ? { minPx: 260, maxPx: 560, storageKey: 'work.item-rail.width' } : undefined}
            railHeading="caption"
            railCountStyle="plain"
            railTitle={focusedWork ? rail.title : 'Initiatives'}
            railCount={rail.count}
            railActions={rail.actions}
            railLabel={focusedWork ? rail.label : 'initiatives'}
            railCollapsed={folded || (focusedWork && narrow)}
            onToggleRail={collapsible ? focusedWork && narrow ? () => setMobileWorkOpen(true) : toggle : undefined}
            railHeader={focusedWork ? rail.header : navigationHeader}
            rail={rail.body}
            railFooter={rail.footer}
            panePadding="none"
            paneHeader={band}
            paneFooter={composer}
            // An initiative is a record of the list rail: under 40rem of the frame's width (a phone, the huddle
            // pane squeezing the column) it fills the width under "All initiatives", which reopens the list,
            // rather than sitting at ~60px beside the full-width rail (walk, 9 November: the Docs tab). A focused
            // work item keeps its split pane and its own narrow modal below.
            {...(!focusedWork ? { narrow: { showing: 'record' as const, backLabel: 'All initiatives',
              onBack: () => navigate(initiativeListHref(search, scope, lens === 'sprints')) } } : {})}
          >{children}</ExplorerLayout>
        ) : (
        // The list routes (All / My / Sprints) take the same single section
        // rail as an initiative: the views over the list, never a views rail
        // beside a list rail (docs/layout-cascade.md — at most two rails).
        <ListRailLayout
          list={{ ...rail, header: navigationHeader }}
          {...(collapsible ? { fold: { folded, onToggle: toggle } } : {})}
          header={band}
          footer={composer}
        >
          {children}
        </ListRailLayout>
        )}
        {focusedWork && narrow && <Modal open={mobileWorkOpen} onClose={() => setMobileWorkOpen(false)}
          title="Work items" maxWidth={480}>
          <Stack gap="md" className="h-[70dvh] min-h-0" data-testid="mobile-work-navigation">
            {rail.header}
            <Stack gap="none" className="min-h-0 flex-1 overflow-y-auto">{rail.body}</Stack>
            {rail.footer}
          </Stack>
        </Modal>}
      </Stack>
    </ViewportFillRegion>
  );
}
