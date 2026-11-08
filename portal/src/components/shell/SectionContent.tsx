// The content column of a sectioned page (docs/layout-cascade.md): the
// breadcrumb trail is its first row — with the page's controls and link on
// the right — the page's one 20px title follows it, and the body sits under
// both at the standard 24px gutter.
//
// A page with a list (records, a queue, candidates, runs) draws the library
// `ListRailLayout` instead (the rail model's list rail): the list is a flush
// list rail stacked directly beside the section rail — the rail the
// Initiatives list draws (264px, caption title + count chip, search header,
// grouped rows, footer) — and `SectionHeader` as its `header`, so the content
// column (trail first, then the title, then the record) starts after it.
import { ScopeHeader } from '@connorhoehn/ui-components';
import { PageFrame, PageHeader, Stack, type BreadcrumbItem, type Density } from '@connorhoehn/ui-components/shared';
import type { ComponentProps, ReactNode } from 'react';
import { UNDER_CRUMBS_BAND, UNDER_CRUMBS_BAND_WITH_CONTROLS } from './headerRhythm';

type ScopeHeaderProps = ComponentProps<typeof ScopeHeader>;

export interface SectionHeaderProps {
  breadcrumbs: ScopeHeaderProps['breadcrumbs'];
  /** Right of the trail — a scope selector. */
  controls?: ReactNode;
  /** Right of the trail — "Agent library ↗". */
  link?: ScopeHeaderProps['link'];
  title: string;
  description?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  /** The library header density (`useHeaderDensity().headerProps`): compact
   *  draws the title as one 14/600 row; collapsed folds it into the trail. */
  density?: Density;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** A conversation owns its header/message gutters and full-width dock. */
  inset?: 'page' | 'conversation';
}

/**
 * The trail band and the title band under it, at the 24px gutter — the
 * content column's first rows, on a flush page and (as `ListRailLayout`'s
 * `header`) right of a page's list rail.
 */
export function SectionHeader({ breadcrumbs, controls, link, title, description, badge, actions, density, collapsed = false, onToggleCollapsed }: SectionHeaderProps) {
  const hangs = !!(controls || link);
  const compact = density === 'compact';
  return (
    <>
      <ScopeHeader
        variant="crumbs"
        breadcrumbs={breadcrumbs}
        title={title}
        collapsed={collapsed}
        {...(onToggleCollapsed ? { onToggleCollapsed } : {})}
        {...(controls ? { controls } : {})}
        {...(link ? { link } : {})}
        data-testid="section-crumbs"
      />
      {!collapsed && <Stack gap="none" className={`shrink-0 px-[var(--ui-page-gutter,1.5rem)] ${compact ? 'pb-2 pt-1' : `pb-4 ${hangs ? UNDER_CRUMBS_BAND_WITH_CONTROLS : UNDER_CRUMBS_BAND}`}`} data-section-title>
        <PageHeader
          title={title}
          {...(density ? { density } : {})}
          {...(onToggleCollapsed ? { onToggleCollapsed } : {})}
          {...(description ? { description } : {})}
          {...(badge ? { badge } : {})}
          {...(actions ? { actions } : {})}
        />
      </Stack>}
    </>
  );
}

/** The content column of a sectioned page: the library `PageFrame` in its
 *  trail form — the trail row (with `controls`/`link` on its right), the title
 *  band under it (folded into the trail when `collapsed`), and a docked body a
 *  section's command composer (`ColumnDock`) docks under. A conversation
 *  (`inset="conversation"`) owns its own gutters. */
export function SectionContent({
  body = 'scroll', children, 'data-testid': testId,
  breadcrumbs, controls, link, title, description, badge, actions, density, collapsed = false, onToggleCollapsed, inset = 'page',
}: SectionHeaderProps & {
  /** `scroll`: the body scrolls (an overview, a form). `fill`: the body is a
   *  fixed-height frame whose panes scroll on their own (a canvas + inspector). */
  body?: 'scroll' | 'fill';
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <PageFrame
      title={title}
      {...(breadcrumbs ? { breadcrumbs: breadcrumbs as BreadcrumbItem[] } : {})}
      {...(description ? { description } : {})}
      {...(badge ? { badge } : {})}
      {...(actions ? { actions } : {})}
      {...(density ? { density } : {})}
      {...(controls ? { trailControls: controls } : {})}
      {...(link ? { trailLink: link } : {})}
      collapsed={collapsed}
      {...(onToggleCollapsed ? { onToggleCollapsed } : {})}
      body="docked"
      dockedBody={body}
      bodyGutter={inset === 'conversation' ? 'none' : 'page'}
      className="flex-1"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </PageFrame>
  );
}

/** A canvas (the tier graph) framed inside the content gutter. A figure, not
 *  a list — a list is a `ListRailLayout` rail. */
export const SECTION_CANVAS_FRAME = 'min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border';
