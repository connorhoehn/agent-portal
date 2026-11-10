import { ViewportFillRegion, useSidePaneHost } from '@connorhoehn/ui-components';
import { GroupedList, MasterDetailPage, PageSection, RailNavList, SectionLayout, Select, Stack, useRailFold, activeNavItemClassName, inactiveNavItemClassName, type BreadcrumbItem, type SubNavItem } from '@connorhoehn/ui-components/shared';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useDialogueRailFold } from './useDialogueRailFold';

function groupsOf(rows: Array<{ subline?: string }>, fallback: string) {
  const ids = [...new Set(rows.map((row) => row.subline ?? fallback))];
  return ids.map((id) => ({ id, title: id, count: rows.filter((row) => (row.subline ?? fallback) === id).length }));
}

/** The Design catalogs' hierarchy:
 * section navigation, record list, then the selected record. */
export function StackedCatalogLayout({
  title, group = 'Design', basePath, items, rows, selectedId, selectedTitle, listTitle,
  onSelect, railHeader, railNotice, children, footer, catalogOverview = false, overviewDescription, overviewActions, navigation = 'stacked', recordHeading = false,
  narrow = false,
}: {
  /**
   * The narrow form. `stacked`: library `SectionLayout narrow` (the section
   * rail as one row; with a record open, the record under "All <title>").
   * `combined`: library `MasterDetailPage narrow`, since
   * 2.515.1: under 40rem of the frame's own width the rail and the record stop
   * sitting side by side. With no record open the title band and then the rail
   * fill the width, and the rail carries the records as the page's list (on a
   * wide frame the overview's table is that list, so the rail shows only the
   * views); with one open, the record fills the width under a back control
   * ("All <title>") that returns to the list with its view kept.
   */
  narrow?: boolean;
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
  /** `subline` groups the rows (a status, a kind); `description` is a row's
   *  second line, and `detail` (combined only) a further line under it. */
  rows: Array<{ id: string; title: string; subline?: string; description?: string; detail?: string }>;
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
    // A row's second line is its `description`; a `detail` (a decision's outcome) goes under it,
    // so the line every row shares (the initiative) stays in one place.
    const records = <GroupedList size="md" rowStyle="ruled" currentStyle="bar" groupHeading="label" groupCountAlign="end"
      groups={groupsOf(rows, listTitle)} rows={rows.map(row => ({ id: row.id, title: row.title, groupId: row.subline ?? listTitle,
        ...(row.detail ? { meta: row.description, subline: row.detail } : { subline: row.description }) }))}
      currentId={selectedId ?? null} onOpenRow={row => onSelect(row.id)} />;
    // The library MasterDetailPage with a docked record column: the trail and
    // title head the column; the rail holds the views (RailNavList on the
    // overview, a view Select beside a record) over the grouped records; the
    // overview is the empty detail, and its command composer (ColumnDock)
    // docks at the column's bottom, as a record's footer does.
    return <ViewportFillRegion bottomGap={0} data-testid="stacked-catalog">
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush data-catalog-navigation="combined">
        <MasterDetailPage body="docked" railWidth="ml" fold={{ folded: fold.folded, onToggle: fold.toggle }}
          title={selectedId && recordHeading ? selectedTitle ?? title : title}
          breadcrumbs={breadcrumbs as BreadcrumbItem[]}
          {...(!selectedId && overviewDescription ? { description: overviewDescription } : {})}
          {...(!selectedId && overviewActions ? { actions: overviewActions } : {})}
          {...(footer != null ? { footer } : {})}
          list={{ title, count: rows.length, label: `${title.toLowerCase()} records`,
            header: <Stack gap="md">
              {selectedId ? <Select aria-label={`${title} view`} value={active?.path ?? ''}
                options={items.map(item => ({ value: item.path, label: item.label }))} onChange={event => navigate(event.target.value)} />
                : <RailNavList aria-label={`${title} views`} currentStyle="tint" items={items.map(item => ({ id: item.path, href: item.path, label: item.label, current: item.active,
                    onNavigate: event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); navigate(item.path); } }))} />}
              {railHeader}
            </Stack>,
            body: selectedId ? railNotice ?? records
              // Narrow overview: the list is the rail (the container query hides it beside the wide overview's table).
              : narrow ? <Stack gap="none" className="min-w-0 @min-[40rem]:hidden" data-testid="catalog-narrow-list">{railNotice ?? records}</Stack> : null,
          }}
          {...(narrow ? { narrow: { onBack: () => navigate(listHref), backLabel: `All ${title.toLowerCase()}` } } : {})}
          emptyDetail={<Stack gap="md" className="min-w-0" data-testid="catalog-overview">{children}</Stack>}
          data-testid="catalog-explorer">
          {selectedId ? children : null}
        </MasterDetailPage>
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
      // Narrow (stacked): under 40rem the section rail folds to one row of links and, with a
      // record open, the list rail gives way to the record under a back control, so the trail
      // and the record's one h1 fill the width (UX leftovers, 10 November: the agent-library
      // record at 390 showed two rails and no heading).
      {...(narrow ? { narrow: overview ? {} : { list: { showing: selectedId ? 'record' as const : 'list' as const, onBack: () => navigate(listHref), backLabel: listTitle } } } : {})}
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
