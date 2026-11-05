import { DockedColumn, ListRailLayout, ScopeHeader, ViewportFillRegion, useSidePaneHost } from '@connorhoehnslalom/ui-components';
import { GroupedList, PageHeader, PageSection, RailNavList, SectionLayout, Select, Stack, useRailFold, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { UNDER_CRUMBS_BAND } from './headerRhythm';
import { useDialogueRailFold } from './useDialogueRailFold';

function groupsOf(rows: Array<{ subline?: string }>, fallback: string) {
  const ids = [...new Set(rows.map((row) => row.subline ?? fallback))];
  return ids.map((id) => ({ id, title: id, count: rows.filter((row) => (row.subline ?? fallback) === id).length }));
}

/** The Design catalogs share the same hierarchy as Distillation:
 * section navigation, record list, then the selected record. */
export function StackedCatalogLayout({
  title, group = 'Design', basePath, items, rows, selectedId, selectedTitle, listTitle,
  onSelect, railHeader, railNotice, children, footer, catalogOverview = false, overviewDescription, overviewActions, navigation = 'stacked', recordHeading = false,
}: {
  catalogOverview?: boolean;
  /** Keep status views and record navigation in one rail, as in Initiatives. */
  navigation?: 'stacked' | 'combined';
  recordHeading?: boolean;
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
  rows: Array<{ id: string; title: string; subline?: string; description?: string }>;
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
  const railFold = useRailFold({ storageKey: `catalog-${title}.rail` });
  const dialogue = useSidePaneHost();
  const fold = useDialogueRailFold(dialogue.shown, railFold, location.pathname);
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
  const distinctView = listTitle.toLowerCase().replace(/^all /, '') !== title.toLowerCase();
  const breadcrumbs = [
    ...(group.toLowerCase() === title.toLowerCase().replace(/s$/, '') ? [] : [{ label: group }]),
    selectedId || distinctView ? crumb(title, sectionHref) : { label: title },
    ...(distinctView ? [selectedId ? crumb(listTitle, listHref) : { label: listTitle }] : []),
    ...(selectedId ? [{ label: selectedTitle ?? 'Record' }] : []),
  ];
  if (navigation === 'combined') {
    const active = items.find(item => item.active) ?? items[0];
    const header = <Stack gap="none">
      <ScopeHeader variant="crumbs" breadcrumbs={breadcrumbs} />
      <PageHeader title={selectedId && recordHeading ? selectedTitle ?? title : title}
        description={selectedId ? undefined : overviewDescription} actions={selectedId ? undefined : overviewActions}
        className={`border-b border-border px-6 pb-3 ${UNDER_CRUMBS_BAND}`} data-testid="catalog-pane-header" />
    </Stack>;
    return <ViewportFillRegion bottomGap={0} data-testid="stacked-catalog">
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush data-catalog-navigation="combined">
        <ListRailLayout railWidth="ml" fold={{ folded: fold.folded, onToggle: fold.toggle }} header={header} footer={footer}
          list={{ title, count: rows.length, label: `${title.toLowerCase()} records`,
            header: <Stack gap="md">
              {selectedId ? <Select aria-label={`${title} view`} value={active?.path ?? ''}
                options={items.map(item => ({ value: item.path, label: item.label }))} onChange={event => navigate(event.target.value)} />
                : <RailNavList aria-label={`${title} views`} currentStyle="tint" items={items.map(item => ({ id: item.path, href: item.path, label: item.label, current: item.active,
                    onNavigate: event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); navigate(item.path); } }))} />}
              {railHeader}
            </Stack>,
            body: selectedId ? railNotice ?? <GroupedList size="md" rowStyle="ruled" currentStyle="bar" groupHeading="label" groupCountAlign="end"
              groups={groupsOf(rows, listTitle)} rows={rows.map(row => ({ id: row.id, title: row.title, groupId: row.subline ?? listTitle, subline: row.description }))}
              currentId={selectedId} onOpenRow={row => onSelect(row.id)} /> : null,
          }} data-testid="catalog-explorer">
          {selectedId ? <Stack gap="md" className="min-w-0 px-6 py-5">{children}</Stack>
            : <DockedColumn bodyClassName="flex flex-col px-6 py-5" bodyProps={{ 'data-testid': 'catalog-overview' }}>{children}</DockedColumn>}
        </ListRailLayout>
      </Stack>
    </ViewportFillRegion>;
  }
  // Stacked: the library SectionLayout — the section rail, then either the
  // catalog overview (trail row over a PageSection) or the record list as a
  // flush list rail with the trail and title heading the content column. Rows
  // group by their category line (a design's status, an asset's kind).
  const overview = catalogOverview && !selectedId;
  return (
    <SectionLayout
      title={title} items={items} storageKey={`catalog-${title}`}
      renderNavItem={(item, body) => {
        const active = items.find((entry) => entry.path === item.path)?.active;
        return <Link to={item.path} aria-current={active ? 'page' : undefined} className={active ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
      }}
      {...(overview ? { header: { breadcrumbs: [{ label: group }, { label: title }] } } : {
        header: { breadcrumbs, title },
        list: {
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
        },
        ...(footer != null ? { footer } : {}),
      })}
      bodyClassName={overview ? undefined : 'overflow-x-auto'}
      data-testid="stacked-catalog"
    >
      {overview ? <PageSection title={title} data-testid="catalog-overview"
        {...(overviewDescription ? { description: overviewDescription } : {})}
        {...(overviewActions ? { actions: overviewActions } : {})}>
        {children}
      </PageSection> : children}
    </SectionLayout>
  );
}
