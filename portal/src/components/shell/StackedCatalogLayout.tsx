import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ExplorerLayout, ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import { EmptyState, GroupedList, Stack, SubNavLayout, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

/** The Design catalogs share the same hierarchy as Distillation:
 * section navigation, record list, then the selected record. */
export function StackedCatalogLayout({
  title, group = 'Design', basePath, items, rows, selectedId, selectedTitle, listTitle,
  onSelect, railHeader, railNotice, children, catalogOverview = false, overviewDescription, overviewActions,
}: {
  catalogOverview?: boolean;
  /** The overview's header blurb and actions (2026-09-29): drawn in the layout's
   *  `ScopeHeader` so the title is the one every stacked page uses — a page that
   *  drew its own `PageHeader size="lg"` under the crumbs sat at 28px/700 beside
   *  siblings at 22px/600. */
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
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const atSection = !catalogOverview && params.get('nav') === 'section';
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
    ...(atSection ? [{ label: title }] : [crumb(title, sectionHref),
      ...(selectedId ? [crumb(listTitle, listHref), { label: selectedTitle ?? 'Record' }] : [{ label: listTitle }])]),
  ];
  const content = catalogOverview && !selectedId ? <Stack gap="none" className="h-full min-h-0">
    <ScopeHeader breadcrumbs={[{ label: group }, { label: title }]} title={title}
      {...(overviewDescription ? { description: overviewDescription } : {})}
      {...(overviewActions ? { controls: overviewActions } : {})} />
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-6" data-testid="catalog-overview">{children}</div>
  </Stack> : atSection ? <Stack gap="none" className="h-full min-h-0">
            <ScopeHeader title={title} breadcrumbs={breadcrumbs} />
            <EmptyState size="sm" title={`Browse ${title.toLowerCase()}`} description="Choose a view from the menu to open its records." />
          </Stack> : <ExplorerLayout
            railTitle={listTitle}
            railHeading="caption"
            railWidth="ms"
            railLabel={`${title.toLowerCase()} records`}
            railHeader={railHeader}
            rail={railNotice ?? <GroupedList
              size="md" currentStyle="bar" groupHeading="label"
              groups={[{ id: 'records', title: listTitle, count: rows.length }]}
              rows={rows.map((row) => ({ ...row, groupId: 'records' }))}
              currentId={selectedId}
              onOpenRow={(row) => onSelect(row.id)}
            />}
            paneHeader={<ScopeHeader variant="crumbs" breadcrumbs={breadcrumbs} />}
            panePadding="none"
            className="min-h-0 min-w-0 flex-1"
            data-testid="catalog-explorer"
          >
            <Stack gap="md" className="min-w-0 w-full overflow-x-auto p-5">{children}</Stack>
          </ExplorerLayout>;
  return (
    <ViewportFillRegion bottomGap={0} data-testid="stacked-catalog">
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        <SubNavLayout title={title} items={items} railLabel={`${title} navigation`} storageKey={`catalog-${title}`} contentAs="section" contentLabel={`${title} workspace`}
          renderNavItem={(item, body) => {
            const active = !atSection && items.find((entry) => entry.path === item.path)?.active;
            return <Link to={item.path} aria-current={active ? 'page' : undefined} className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
          }}>
          {content}
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}
