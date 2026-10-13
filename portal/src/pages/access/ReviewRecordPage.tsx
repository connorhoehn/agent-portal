// /access/reviews/:id — one access review campaign (docs/access-tenant-design.md
// A10, lane A2): its standing grants as a table, each with its keep / revoke
// decision. GET /api/access/reviews/:id answers the campaign and the items the
// viewer may see (everything with DecideAccess, otherwise only their own). The
// campaign's owner or an access admin decides an item (`item.can.decide`,
// computed by the server: never their own grant, never twice, never on a
// closed campaign) through ConfirmDialog; a revoke states its reason and
// becomes a pre-approved revocation request revoked at once, which the row
// links to. The campaign closes when every item is decided.
//
// A collection record on the house frame: the shared command composer
// (collection commands over the items — search, filter, refresh, open) docks
// at the bottom like every other access collection; it never decides.

import {
  Button,
  CheckIcon,
  Chip,
  CloseIcon,
  CollectionToolbar,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  Inline,
  InlineAlert,
  LoadingState,
  PageHeader,
  ProgressBar,
  Stack,
  T,
  Textarea,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { isNotFoundError, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { relativeTime } from '../../lib/relativeTime';
import { writeJson } from '../../lib/writeJson';
import {
  ACCESS_API,
  TENANT_LABELS,
  filterReviewItems,
  requestHref,
  reviewDecisionProblem,
  reviewItemTitle,
  reviewProgressLabel,
  type AccessReview,
  type AccessReviewItem,
  type ReviewDecision,
  type ReviewRecord,
} from '../../lib/accessRequests';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';

const DECISION_OPTIONS = [
  { value: '', label: 'Every item' },
  { value: 'open', label: 'Undecided' },
  { value: 'keep', label: 'Kept' },
  { value: 'revoke', label: 'Revoked' },
];

export default function ReviewRecordPage() {
  const { id } = useParams();
  const { session } = useSession();
  // A new identity or campaign is a new page: no comment or dialog carries across.
  return <ReviewRecord key={`${session?.sub}:${session?.role}:${id}`} id={id ?? ''} />;
}

function ReviewRecord({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data, error, isLoading, refresh } = useFetch<ReviewRecord>(id ? `${ACCESS_API}/reviews/${encodeURIComponent(id)}` : null);
  const [query, setQuery] = useState('');
  const [decision, setDecision] = useState('');
  const [pending, setPending] = useState<{ item: AccessReviewItem; decision: ReviewDecision } | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useCrumbLabel(id, data ? `${data.review.id} · ${data.review.title}` : null);
  const back = { label: 'Reviews', to: '/access/reviews', onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate('/access/reviews'); } };

  const all = data?.items ?? [];
  const rows = filterReviewItems(all, query, decision);
  const adapter = accessCollectionAdapter('review', {
    setQuery, setFilter: setDecision, refresh,
    open(target) {
      if (!data || error) throw new Error('Wait for the campaign to load before opening an item.');
      const item = resolveAccessTarget(target, rows.map((row) => ({ ...row, title: reviewItemTitle(row) })));
      if (item.revocationRequestId) { navigate(requestHref(item.revocationRequestId)); return `Opened ${item.revocationRequestId}, the revocation ${item.id} created. Nothing was decided.`; }
      setQuery(item.user.displayName);
      return `Showing ${item.id} (${reviewItemTitle(item)}). Nothing was decided.`;
    },
  });

  if (error && !data) {
    return (
      <Stack gap="md" data-testid="access-review-missing">
        <PageHeader density="compact" title="Review" back={back} />
        {isNotFoundError(error) || /404|not found/i.test(error) ? (
          <EmptyState testId="access-review-unavailable" align="start" title="Campaign not found" description={`No review campaign ${id}.`} />
        ) : (
          <UnavailableNotice error={error} what="this review campaign" source="Campaigns are read from access_reviews" onRetry={refresh} />
        )}
      </Stack>
    );
  }
  if (!data) return <LoadingState label={isLoading ? 'Loading campaign…' : 'Loading…'} />;
  const review: AccessReview = data.review;

  async function decide() {
    if (!pending) return;
    const { item, decision: d } = pending;
    setPending(null); setBusy(true); setNotice(null);
    const res = await writeJson<{ review: AccessReview; item: AccessReviewItem }>(
      `${ACCESS_API}/reviews/${encodeURIComponent(review.id)}/items/${encodeURIComponent(item.id)}/decide`, 'POST',
      { decision: d, ...(comment.trim() ? { comment: comment.trim() } : {}) });
    setBusy(false);
    if (!res.ok) { setNotice({ tone: 'error', text: res.error ?? `The server refused (HTTP ${res.status}). Nothing changed.` }); refresh(); return; }
    setComment('');
    setNotice({ tone: 'success', text: d === 'keep'
      ? `Kept ${reviewItemTitle(item)}.`
      : `Revoked ${reviewItemTitle(item)} through ${res.data?.item.revocationRequestId ?? 'a revocation request'}; their sessions end at their next request.` });
    refresh();
  }

  const columns: DataTableColumn<AccessReviewItem>[] = [
    { key: 'user', header: 'Person', sortable: true, compare: (a, b) => a.user.displayName.localeCompare(b.user.displayName), render: (i) => i.user.displayName },
    { key: 'role', header: 'Role', width: '144px', render: (i) => <T size="sm" tabular>{i.role}</T> },
    {
      key: 'decision', header: 'Decision', width: '104px',
      render: (i) => (i.decision ? <Chip tone={i.decision === 'keep' ? 'success' : 'warning'} size="xs">{i.decision === 'keep' ? 'kept' : 'revoked'}</Chip> : <Chip tone="info" size="xs">undecided</Chip>),
    },
    { key: 'decidedBy', header: 'Decided by', render: (i) => i.decidedBy?.displayName ?? <T size="xs" tone="tertiary">—</T> },
    { key: 'comment', header: 'Comment', render: (i) => (i.comment ? <T size="sm" tone="secondary" title={i.comment} className="block max-w-[20rem] truncate">{i.comment}</T> : <T size="xs" tone="tertiary">—</T>) },
    {
      key: 'revocation', header: 'Revocation', width: '112px',
      // The id as text (one thing per cell, no buttons in cells); the row opens it.
      render: (i) => (i.revocationRequestId
        ? <T size="sm" tabular data-testid={`access-review-revocation-${i.id}`}>{i.revocationRequestId}</T>
        : <T size="xs" tone="tertiary">—</T>),
    },
    { key: 'decidedAt', header: 'Decided', numeric: true, render: (i) => (i.decidedAt ? relativeTime(i.decidedAt) : '—') },
  ];
  const anyDecidable = all.some((i) => i.can.decide);
  const commentProblem = pending ? reviewDecisionProblem(pending.decision, comment) : null;

  const page = ACCESS_SURFACES.review;
  return (
    <CollectionCommandPage data-testid="access-review-record" title={review.title} back={back}
      description={`${review.id} · ${TENANT_LABELS[review.tenant] ?? review.tenant} · opened ${relativeTime(review.openedAt)}${review.owner ? ` by ${review.owner.displayName}` : ''}${review.closedAt ? ` · closed ${relativeTime(review.closedAt)}` : ''}`}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <ProgressBar size="sm" value={review.progress.decided} max={Math.max(review.progress.total, 1)} completeTone="success"
            label={<T size="sm">{review.status === 'closed' ? 'Closed: every item decided' : 'Progress'}</T>}
            valueLabel={`${reviewProgressLabel(review.progress)} · ${review.progress.kept} kept · ${review.progress.revoked} revoked`}
            data-testid="access-review-progress" aria-label={reviewProgressLabel(review.progress)} />
          <CollectionToolbar {...{
            label: 'Review item filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search items', 'aria-label': 'Search review items' },
            filters: [{ id: 'decision', label: 'Decision', value: decision, onChange: setDecision, options: DECISION_OPTIONS }],
            summary: `${rows.length} of ${all.length} items`,
            notices: [review.can.decide
              ? 'Keep or revoke each grant. A revoke removes it at once through a pre-approved revocation request; nobody decides their own grant.'
              : `${page.description} Only the campaign’s owner or an access admin decides; you see ${all.length ? 'the items you may see' : 'no item of yours here'}.`],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {notice && <InlineAlert tone={notice.tone} onDismiss={() => setNotice(null)} data-testid="access-review-notice">{notice.text}</InlineAlert>}
          <DataTable
            data-testid="access-review-items"
            data={rows}
            columns={columns}
            keyField={(i) => i.id}
            pageSize={50}
            onRowClick={(i) => { if (i.revocationRequestId) navigate(requestHref(i.revocationRequestId)); }}
            {...(anyDecidable ? {
              rowActions: (i: AccessReviewItem) => (i.can.decide ? (
                <Inline gap="xs" wrap={false}>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setComment(''); setPending({ item: i, decision: 'keep' }); }} data-testid={`access-review-keep-${i.id}`}><CheckIcon />Keep</Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => { setComment(''); setPending({ item: i, decision: 'revoke' }); }} data-testid={`access-review-revoke-${i.id}`}><CloseIcon />Revoke</Button>
                </Inline>
              ) : null),
            } : {})}
            emptyMessage={query.trim() || decision ? 'No item matches this search and decision.' : 'No standing grant of yours is in this campaign.'}
          />
        </Stack>
        <CollectionCommandHost adapter={adapter} disabled={busy} />
      </Stack>
      <ConfirmDialog
        open={!!pending}
        title={pending?.decision === 'revoke' ? `Revoke ${pending ? reviewItemTitle(pending.item) : ''}?` : `Keep ${pending ? reviewItemTitle(pending.item) : ''}?`}
        body={pending?.decision === 'revoke'
          ? `${pending.item.user.displayName} loses ${pending.item.role} in ${TENANT_LABELS[pending.item.tenant]} at once, and every session they hold is signed out at its next request. A pre-approved revocation request records it.`
          : pending ? `${pending.item.user.displayName} keeps ${pending.item.role} in ${TENANT_LABELS[pending.item.tenant]}. The decision is recorded on the campaign.` : ''}
        confirmLabel={pending?.decision === 'revoke' ? 'Revoke' : 'Keep'}
        confirmDisabled={!!commentProblem}
        cancelLabel="Not now"
        tone={pending?.decision === 'revoke' ? 'destructive' : 'info'}
        onConfirm={() => void decide()}
        onCancel={() => setPending(null)}
      >
        <FormField label="Comment" hint={pending?.decision === 'revoke' ? 'Required: it becomes the revocation’s reason, sent to the person.' : 'Optional; recorded on the item.'} required={pending?.decision === 'revoke'}>
          {(wiring) => <Textarea {...wiring} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="access-review-comment" />}
        </FormField>
      </ConfirmDialog>
    </CollectionCommandPage>
  );
}
