// /access/reviews — access review campaigns (docs/access-tenant-design.md A10,
// lane A2): each certifies the standing grants of one workspace. Read from
// GET /api/access/reviews by every access role; the progress is counted by the
// server over the items the viewer may see. An access admin
// (ManageAccessPolicy) opens a campaign with "New campaign": the server builds
// one item per (user, role) the directory holds in that workspace now. A row
// opens the campaign's record, where its owner or an access admin decides
// each item. The command composer only searches, filters, refreshes and opens.

import {
  Button,
  Chip,
  CollectionToolbar,
  DataTable,
  Drawer,
  FormField,
  Inline,
  Input,
  PlusIcon,
  ProgressBar,
  Select,
  Stack,
  T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import {
  ACCESS_API,
  TENANT_LABELS,
  campaignProblem,
  filterReviews,
  reviewHref,
  reviewProgressLabel,
  type AccessReview,
  type AccessTenant,
  type ItemsResponse,
  type ReviewRecord,
} from '../../lib/accessRequests';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';

const STATUS_OPTIONS = [
  { value: '', label: 'Every status' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
];
const TENANT_OPTIONS = (Object.entries(TENANT_LABELS) as Array<[AccessTenant, string]>).map(([value, label]) => ({ value, label }));

const COLUMNS: DataTableColumn<AccessReview>[] = [
  { key: 'id', header: 'Campaign', width: '112px', render: (c) => <T size="sm" tabular>{c.id}</T> },
  {
    key: 'title', header: 'Title', sortable: true, compare: (a, b) => a.title.localeCompare(b.title),
    render: (c) => <T size="sm" title={c.title} className="block max-w-[24rem] truncate">{c.title}</T>,
  },
  { key: 'tenant', header: 'Workspace', width: '120px', render: (c) => TENANT_LABELS[c.tenant] ?? c.tenant },
  { key: 'owner', header: 'Owner', render: (c) => c.owner?.displayName ?? <T size="xs" tone="tertiary">—</T> },
  { key: 'status', header: 'Status', width: '96px', render: (c) => <Chip tone={c.status === 'open' ? 'info' : 'neutral'} size="xs">{c.status}</Chip> },
  {
    key: 'progress', header: 'Decided', width: '176px',
    render: (c) => <ProgressBar size="sm" value={c.progress.decided} max={Math.max(c.progress.total, 1)} completeTone="success"
      valueLabel={reviewProgressLabel(c.progress)} aria-label={`${c.title}: ${reviewProgressLabel(c.progress)}`} />,
  },
  {
    key: 'openedAt', header: 'Opened', numeric: true, sortable: true,
    compare: (a, b) => a.openedAt.localeCompare(b.openedAt), render: (c) => relativeTime(c.openedAt),
  },
];

export default function ReviewsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { can, ready } = useCapabilities();
  const mayOpen = ready && can('ManageAccessPolicy');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(() => (params.get('status') === 'open' || params.get('status') === 'closed' ? params.get('status')! : ''));
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState({ tenant: '', title: '' });
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<AccessReview>>(`${ACCESS_API}/reviews`, 120_000);
  const all = data?.items ?? [];
  const rows = filterReviews(all, query, status);
  const problem = campaignProblem(draft.tenant, draft.title);

  const adapter = accessCollectionAdapter('reviews', {
    setQuery, setFilter: setStatus, refresh,
    open(target) {
      if (!data || error) throw new Error('Wait for the campaigns to load before opening one.');
      const c = resolveAccessTarget(target, rows);
      navigate(reviewHref(c.id));
      return `Opened ${c.id}. Nothing was decided.`;
    },
  });

  async function create() {
    setBusy(true);
    const res = await writeJson<ReviewRecord>(`${ACCESS_API}/reviews`, 'POST', { tenant: draft.tenant, title: draft.title.trim() });
    setBusy(false);
    if (res.ok && res.data) {
      toastSuccess(null, 'Campaign opened', `${res.data.items.length} standing grants in ${TENANT_LABELS[res.data.review.tenant]} to review.`);
      setDrawer(false); setDraft({ tenant: '', title: '' });
      navigate(reviewHref(res.data.review.id));
      return;
    }
    toastError(null, 'Could not open the campaign', res.error ?? undefined);
  }

  const page = ACCESS_SURFACES.reviews;
  return (
    <CollectionCommandPage data-testid="access-reviews" title={page.title} description={page.description}
      headerActions={mayOpen ? (
        <Button size="sm" variant="primary" onClick={() => setDrawer(true)} data-testid="access-new-review"><PlusIcon />New campaign</Button>
      ) : undefined}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Review filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search reviews', 'aria-label': 'Search reviews' },
            filters: [{ id: 'status', label: 'Status', value: status, onChange: setStatus, options: STATUS_OPTIONS }],
            summary: data ? `${rows.length} of ${all.length} campaigns` : undefined,
            notices: ['A campaign’s owner or an access admin keeps or revokes each standing grant; a revoke becomes a pre-approved revocation request. You see the items you may decide, or your own.'],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="access reviews" source="Review campaigns are read from access_reviews and their items" onRetry={refresh} />
          ) : (
            <DataTable
              data-testid="access-reviews-table"
              data={rows}
              columns={COLUMNS}
              keyField={(c) => c.id}
              loading={isLoading && !data}
              pageSize={25}
              onRowClick={(c) => navigate(reviewHref(c.id))}
              emptyMessage={query.trim() || status ? 'No campaign matches this search and status.' : `${page.emptyTitle}. ${page.emptyBody}`}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} disabled={busy} />
      </Stack>
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="New review campaign"
        subtitle="One item per standing grant the workspace holds now"
        width={480}
        data-testid="access-review-drawer"
        footer={(
          <Inline gap="sm" justify="end">
            <Button size="sm" variant="ghost" onClick={() => setDrawer(false)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={busy || !!problem} onClick={() => void create()} data-testid="access-review-create">Open campaign</Button>
          </Inline>
        )}
      >
        <Stack gap="md">
          <FormField label="Workspace" hint="Every (person, role) grant held there now becomes an item. Cross-tenant admin grants are not reviewed here.">
            {({ id }) => <Select id={id} size="sm" className="w-full max-w-56" value={draft.tenant} placeholder="Choose a workspace"
              onChange={(e) => setDraft({ ...draft, tenant: e.target.value })} options={TENANT_OPTIONS} data-testid="access-review-tenant" />}
          </FormField>
          <FormField label="Title" hint="Shown to reviewers and in every revocation it creates.">
            {(wiring) => <Input {...wiring} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="access-review-title" />}
          </FormField>
          {problem && (draft.tenant || draft.title) && <T size="xs" tone="secondary">{problem}</T>}
        </Stack>
      </Drawer>
    </CollectionCommandPage>
  );
}
