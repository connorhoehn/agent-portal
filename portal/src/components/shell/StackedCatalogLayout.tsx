import { DockedColumn, ListRailLayout, ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import { GroupedList, PageSection, Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { UNDER_CRUMBS_BAND } from './headerRhythm';
import { SectionHeader } from './SectionContent';

function groupsOf(rows: Array<{ subline?: string }>, fallback: string) {
  const ids = [...new Set(rows.map((row) => row.subline ?? fallback))];
  return ids.map((id) => ({ id, title: id, count: rows.filter((row) => (row.subline ?? fallback) === id).length }));
}

/** The Design catalogs share the same hierarchy as Distillation:
 * section navigation, record list, then the selected record. */
export function StackedCatalogLayout({
  title, group = 'Design', basePath, items, rows, selectedId, selectedTitle, listTitle,
  onSelect, railHeader, railNotice, children, footer, catalogOverview = false, overviewDescription, overviewActions,
}: {
  catalogOverview?: boolean;
  /** The overview's header blurb and actions: drawn by the layout's own
   *  `PageSection` under the crumbs band, so the overview's title is the 20px/600
   *  heading every Org page uses, 16px under the trail (headerRhythm.ts). A page
   *  that drew its own header here sat at a size and offset of its own. */
  overviewDescription?: string;
  overviewActions?: ReactNode;
  title: string;
  group?: string;
  basePath: string;
  items: Array<SubNavItem & { active?: boolean }>;
  rows: Array<{ id: string; title: string; subline?: string }>;
  selectedId?: string | null;
  selectedTitle?: string;
  listTitle: string;
  onSelect: (id: string) => void;
  railHeader?: ReactNode;
  railNotice?: ReactNode;
  children: ReactNode;
  /** Docked flush under the record in the list-rail (record) view — the
   *  content column's composer, passed to `ListRailLayout`'s `footer`. Not
   *  drawn on the catalog overview, whose command host docks at that column's bottom. */
  footer?: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  params.delete('nav');
  params.delete('item');
  const listHref = `${basePath}${params.size ? `?${params}` : ''}`;
  const sectionHref = catalogOverview ? basePath : `${basePath}?nav=section`;
  const crumb = (label: string, href: string) => ({
    label, href,
    onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href);
    },
  });
  const breadcrumbs = [
    { label: group },
    ...([crumb(title, sectionHref),
      ...(selectedId ? [crumb(listTitle, listHref), { label: selectedTitle ?? 'Record' }] : [{ label: listTitle }])]),
  ];
  const content = catalogOverview && !selectedId ? <Stack gap="none" className="h-full min-h-0">
    <ScopeHeader variant="crumbs" breadcrumbs={[{ label: group }, { label: title }]} />
    {/* The overview's command host docks at the column's bottom (ColumnDock). */}
    <DockedColumn bodyClassName={`flex flex-col px-[var(--ui-page-gutter,1.5rem)] pb-[var(--ui-page-gutter,1.5rem)] ${UNDER_CRUMBS_BAND}`} bodyProps={{ 'data-testid': 'catalog-overview' }}>
      <PageSection title={title}
        {...(overviewDescription ? { description: overviewDescription } : {})}
        {...(overviewActions ? { actions: overviewActions } : {})}>
        {children}
      </PageSection>
    </DockedColumn>
  </Stack> : <ListRailLayout
    header={<SectionHeader breadcrumbs={breadcrumbs} title={title} />}
    // The record list is a flush list rail beside the section rail, the
    // Initiatives rail's structure (docs/layout-cascade.md); the content
    // column after it opens with the trail and the title. Rows group by their
    // category line (a design's status, an asset's kind).
    list={{
      title: listTitle,
      count: rows.length,
      label: `${title.toLowerCase()} records`,
      header: railHeader,
      body: railNotice ?? <GroupedList
        size="md" currentStyle="bar" groupHeading="label" groupCountAlign="end"
        groups={groupsOf(rows, listTitle)}
        rows={rows.map((row) => ({ id: row.id, title: row.title, groupId: row.subline ?? listTitle }))}
        currentId={selectedId}
        onOpenRow={(row) => onSelect(row.id)}
      />,
    }}
    {...(footer != null ? { footer } : {})}
    data-testid="catalog-explorer"
  >
    <Stack gap="md" className="min-w-0 w-full overflow-x-auto px-[var(--ui-page-gutter,1.5rem)] pb-[var(--ui-page-gutter,1.5rem)]">{children}</Stack>
  </ListRailLayout>;
  return (
    <ViewportFillRegion bottomGap={0} data-testid="stacked-catalog">
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        <SubNavLayout title={title} items={items} railLabel={`${title} navigation`} storageKey={`catalog-${title}`} contentAs="section" contentLabel={`${title} workspace`}
          renderNavItem={(item, body) => {
            const active = items.find((entry) => entry.path === item.path)?.active;
            return <Link to={item.path} aria-current={active ? 'page' : undefined} className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
          }}>
          {content}
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
