// Distillation → Review (spec §1): queue · claim · Sources.
//
//   rail    Tabs Pending N / Reviewed N · SearchInput · GroupedList rows with
//           the server-resolved target title · type · N notes · age (an
//           unresolvable target says so, with Retry)
//   pane    the claim on EditorShell — "Does this match the source run?",
//           the claim, "View proposed guide →", Your review, Agree /
//           Disagree for ManageBots (else a read-only AccessNotice), Earlier
//           reviews and Sampling details disclosures, the explain-only composer
//   aside   ContextColumn → SourcesPanel, as in Knowledge
//
// A verdict is optimistic (reviewQueueModel): the counts move, the next
// pending sample opens, the decided one lands under Reviewed; a failed write
// rolls the sample back and reopens it. `?sample=` is the selection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router';
import {
  AccessNotice, CommentList, ContextColumn, Disclosure, ExplorerLayout,
  type CommentListItem, type ContextColumnState,
} from '@connorhoehnslalom/ui-components';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
import {
  Button, DetailSection, EmptyState, FileKindMark, FormField, GroupedList, Inline, LinkIcon, LoadingState, SearchInput,
  Stack, StatStrip, StatusPill, T, Tabs, Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useDistillationChannel } from '../../hooks/useDistillationChannel';
import type { DistillationOutletContext } from './DistillationModule';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { knowledgeItemHref, parseReview, reviewHref, type ReviewState } from './distillationRoutes';
import { RecordExplainComposer } from './ExplainComposer';
import { compactAge, shortRepo } from './knowledgeModel';
import {
  applyOptimisticVerdict, nextSampleAfterVerdict, queueCounts, queueRows, rollbackVerdict, toQueueRow,
  type ReviewQueueRow,
} from './reviewQueueModel';
import { SourcesPanel, useItemSources } from './SourcesPanel';
import { recordFileKind } from './sourcesModel';
import { SAMPLING_LABEL } from './distillationFormat';
import type { Item, Lineage, ReviewSampleWithTarget, SamplingResponse } from './types';

interface ReviewSnapshot {
  samples: ReviewSampleWithTarget[];
  counts?: { pending: number; decided: number };
}

type Verdict = 'agree' | 'disagree';

const VERDICT_PILL = {
  pending: { label: 'Pending review', tone: 'warning' },
  agree: { label: 'Agreed', tone: 'success' },
  disagree: { label: 'Disagreed', tone: 'error' },
} as const;

/** "View proposed guide →": the guide a sampled pattern was distilled into,
 *  from the pattern's own lineage; a sampled guide links to itself. */
function useProposedGuide(row: ReviewQueueRow | null, kind: string | null): string | null {
  const isCluster = kind === 'cluster';
  const lineage = useFetch<Lineage>(
    row && isCluster ? `/api/distillation/items/${encodeURIComponent(row.targetId)}/lineage?depth=1` : null, 0,
  );
  if (!row) return null;
  if (kind === 'artifact') return knowledgeItemHref(row.targetId, 'L2');
  const art = lineage.data?.nodes.find((n) => n.kind === 'artifact');
  return art ? knowledgeItemHref(art.id, 'L2') : null;
}

function samplingItems(s: SamplingResponse) {
  return [
    { label: 'Sampled', value: `${s.l1SampleRatePct}%`, hint: 'of new patterns' },
    { label: 'Reviewed', value: String(s.reviewedLast30d), hint: 'last 30 days' },
    { label: 'Agreement', value: `${s.agreementRatePct}%` },
    { label: 'Waiting', value: String(s.queueDepth) },
  ];
}

function Claim({
  sample, row, all, canReview, sampling, onVerdict, onRetry, onOpenSources, sourceCount, onOpen,
}: {
  sample: ReviewSampleWithTarget;
  row: ReviewQueueRow;
  all: ReviewSampleWithTarget[];
  canReview: boolean;
  sampling: SamplingResponse | null;
  onVerdict: (id: string, verdict: Verdict, note: string) => void;
  onRetry: () => void;
  onOpenSources: () => void;
  sourceCount: number | null;
  onOpen: (href: string) => void;
}) {
  const [note, setNote] = useState('');
  const target = useFetch<Item>(row.resolved ? `/api/distillation/items/${encodeURIComponent(row.targetId)}` : null, 0);
  const kind = sample.target?.kind ?? sample.target_kind;
  const guideHref = useProposedGuide(row, kind);
  const claim = target.data ? (target.data.level === 'L0' ? target.data.body : target.data.summary) : null;
  const pending = sample.verdict === 'pending';

  const earlier: CommentListItem[] = all
    .filter((s) => s.target_id === sample.target_id && s.verdict !== 'pending')
    .map((s) => ({
      id: s.id,
      author: { id: s.reviewer ?? s.id, name: s.reviewer ?? 'Unknown reviewer' },
      role: s.verdict === 'agree' ? 'Agreed' : 'Disagreed',
      createdAt: s.reviewed_at ?? s.sampled_at,
      text: s.note ?? (s.verdict === 'agree' ? 'Agreed with no note.' : 'Disagreed with no note.'),
    }));

  const pill = VERDICT_PILL[sample.verdict];

  return (
    <EditorShell
      title={row.title}
      kind={recordFileKind(kind, sample.target?.type)}
      breadcrumbs={[{ label: 'Review' }, { label: row.typeLabel }]}
      statusPill={<StatusPill tone={pill.tone} label={pill.label} size="sm" />}
      subtitle={[row.repo ? `From ${shortRepo(row.repo)}` : null, `Sampled ${relativeTime(row.sampledAt)}`].filter(Boolean).join(' · ')}
      headActions={(
        <Button size="sm" variant="secondary" onClick={onOpenSources}>
          Sources{sourceCount != null ? ` ${sourceCount}` : ''}
        </Button>
      )}
      surface="plain"
      label="Review claim"
      data-testid="review-claim"
      footer={(
        <RecordExplainComposer
          subject={{ kind: row.typeLabel.toLowerCase(), id: row.targetId, title: row.title }}
          referenceLabel="This review"
          placeholder="Show the evidence for this finding…"
        />
      )}
    >
      <Stack gap="md" className="mx-auto w-full max-w-3xl px-6 py-4">
        {!row.resolved ? (
          <AccessNotice
            tone="warning"
            title="The sampled record could not be loaded"
            body={row.error ?? 'The server could not resolve this sample’s target.'}
            action={{ label: 'Retry', onClick: onRetry }}
          />
        ) : (
          <DetailSection first title="Does this match the source run?">
            <Stack gap="sm">
              {target.error ? (
                <UnavailableNotice error={target.error} what="the sampled claim" source="Distillation items are read from Aurora" onRetry={target.refresh} />
              ) : claim == null ? (
                <T className="text-[13px] text-text-tertiary">Loading the claim…</T>
              ) : (
                <T className="text-[15px] leading-6 text-text-primary" wrap data-testid="review-claim-text">{claim}</T>
              )}
              {guideHref && (
                <Button size="sm" variant="link" className="self-start px-0" onClick={() => onOpen(guideHref)}>
                  {kind === 'artifact' ? 'Open this guide →' : 'View proposed guide →'}
                </Button>
              )}
            </Stack>
          </DetailSection>
        )}

        {pending && row.resolved && (canReview ? (
          <Stack gap="sm">
            {/* A plain note box, as the mockup draws it: OutcomeSection read
                "No outcome yet · Add outcome", which is the wrong noun here. */}
            <FormField label="Your review">
              {(wiring) => (
              <Textarea
                {...wiring}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note about the evidence…"
                minRows={3}
                autoResize
                data-testid="review-note"
              />
              )}
            </FormField>
            <Inline gap="sm">
              <Button size="sm" variant="primary" onClick={() => onVerdict(sample.id, 'agree', note)} data-testid="review-agree">
                ✓ Agree
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onVerdict(sample.id, 'disagree', note)} data-testid="review-disagree">
                ✕ Disagree
              </Button>
            </Inline>
            <T className="text-[12px] text-text-tertiary">This records your review; it does not publish the guide.</T>
          </Stack>
        ) : (
          <AccessNotice
            tone="info"
            title="Read-only"
            body="You can inspect this claim and its evidence. Recording a verdict needs the ManageBots capability."
            data-testid="review-readonly"
          />
        ))}

        {!pending && (
          <DetailSection title="This review">
            <T className="text-[13px] text-text-secondary" wrap>
              {pill.label}{sample.reviewer ? ` by ${sample.reviewer}` : ''}{sample.reviewed_at ? ` · ${relativeTime(sample.reviewed_at)}` : ''}
              {sample.note ? ` — “${sample.note}”` : ''}
            </T>
          </DetailSection>
        )}

        <Disclosure summary={`Earlier reviews${earlier.length ? ` (${earlier.length})` : ''}`} variant="plain" density="compact">
          {/* first + a title: CommentList otherwise heads itself "Planning notes". */}
          <CommentList first title="Reviews" comments={earlier} emptyLabel="No review yet for this sample." />
        </Disclosure>

        <Disclosure summary="Sampling details" variant="plain" density="compact">
          {sampling ? (
            <Stack gap="sm">
              <StatStrip frameless items={samplingItems(sampling)} aria-label="Sampling" />
              <T className="text-[12px] text-text-secondary" wrap>
                {SAMPLING_LABEL[sampling.verdict.verdict]} — {sampling.verdict.reason}
              </T>
            </Stack>
          ) : (
            <T className="text-[12px] text-text-tertiary">Sampling figures are not available right now.</T>
          )}
        </Disclosure>
      </Stack>
    </EditorShell>
  );
}

export default function ReviewTab() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = parseReview(location.search);
  const stateRef = useRef(state);
  stateRef.current = state;
  const go = useCallback((patch: Partial<ReviewState>, opts: { push?: boolean } = {}) => {
    navigate(reviewHref({ ...stateRef.current, ...patch }), { replace: !opts.push });
  }, [navigate]);

  const { can, ready } = useCapabilities();
  const canReview = ready && can('ManageBots');
  const { session } = useSession();
  const review = useDistillationChannel<ReviewSnapshot>('distill:review');
  const moduleCtx = useOutletContext<DistillationOutletContext | undefined>();
  const sampling = useFetch<SamplingResponse>('/api/distillation/sampling', 60_000);

  const [query, setQuery] = useState(state.q ?? '');
  useEffect(() => {
    const next = query.trim() || null;
    if (next === stateRef.current.q) return undefined;
    const t = setTimeout(() => go({ q: next }), 250);
    return () => clearTimeout(t);
  }, [query, go]);

  const all = useMemo(() => review.data?.samples ?? [], [review.data]);
  // The header's repository scope narrows the queue; a target that could not
  // be resolved has no repo to test and stays visible.
  const scoped = useMemo(
    () => (state.repo ? all.filter((s) => !s.target || !s.target.repo || s.target.repo === state.repo) : all),
    [all, state.repo],
  );
  const counts = queueCounts(scoped);
  const rows = useMemo(() => queueRows(scoped, state.tab, state.q), [scoped, state.tab, state.q]);
  const unresolved = rows.filter((r) => !r.resolved).length;
  const selectedSample = scoped.find((s) => s.id === state.sample) ?? null;
  const selectedRow = selectedSample ? toQueueRow(selectedSample) : null;

  // First entry (or a stale ?sample=) opens the first row of the tab.
  useEffect(() => {
    if (review.isLoading && !review.data) return;
    if (state.sample && scoped.some((s) => s.id === state.sample)) return;
    if (rows.length > 0) go({ sample: rows[0].id });
  }, [state.sample, scoped, rows, review.isLoading, review.data, go]);

  const sources = useItemSources(selectedRow?.resolved ? selectedRow.targetId : null);

  const decide = useCallback((id: string, verdict: Verdict, note: string) => {
    const before = review.data?.samples ?? [];
    const next = nextSampleAfterVerdict(before, id);
    const applied = applyOptimisticVerdict(before, id, verdict, { note: note.trim() || null, reviewer: session?.name ?? null });
    review.setData((prev) => (prev ? { ...prev, samples: applied.samples } : prev));
    go({ sample: next });
    void (async () => {
      try {
        await sendJson(`/api/distillation/review/${encodeURIComponent(id)}`, 'POST', { verdict, note: note.trim() });
        toastSuccess(null, verdict === 'agree' ? 'Recorded: agree' : 'Recorded: disagree', 'The guide is not published by a review.');
        sampling.refresh();
        review.refresh();
        moduleCtx?.refreshReview();
      } catch (err) {
        review.setData((prev) => (prev ? { ...prev, samples: rollbackVerdict(prev.samples, applied.previous) } : prev));
        go({ sample: id, tab: 'pending' });
        toastError(null, 'Could not save review', err instanceof Error ? err.message : 'Request failed');
      }
    })();
  }, [review, session?.name, go, sampling]);

  const openHref = useCallback((href: string) => navigate(href), [navigate]);

  const [wide, setWide] = useState(false);
  const columnState: ContextColumnState = state.panel === 'sources' ? (wide ? 'wide' : 'open') : 'collapsed';
  const subject = useMemo(
    () => (selectedRow && selectedRow.resolved
      ? { id: selectedRow.targetId, kind: selectedSample?.target?.kind ?? selectedSample?.target_kind ?? 'cluster', title: selectedRow.title }
      : null),
    [selectedRow?.targetId, selectedRow?.resolved, selectedRow?.title, selectedSample?.target?.kind, selectedSample?.target_kind],
  );

  const railHeader = (
    <Stack gap="xs" className="px-3 pb-2">
      <Tabs
        size="sm"
        aria-label="Review queue"
        value={state.tab}
        onValueChange={(id) => go({ tab: id === 'decided' ? 'decided' : 'pending', sample: null })}
        items={[
          { id: 'pending', label: 'Pending', badge: counts.pending },
          { id: 'decided', label: 'Reviewed', badge: counts.decided },
        ]}
      />
      <SearchInput value={query} onChange={setQuery} placeholder="Find a review" aria-label="Find a review" size="sm" />
      <T className="text-[11px] text-text-tertiary">Check findings against their sources.</T>
    </Stack>
  );

  const nowMs = Date.now();
  const railBody = review.error ? (
    <Stack className="p-3">
      <UnavailableNotice error={review.error} what="the review queue" source="Review samples are read from Aurora" onRetry={review.refresh} />
    </Stack>
  ) : review.isLoading && !review.data ? (
    <LoadingState label="Loading review queue…" />
  ) : rows.length === 0 ? (
    <EmptyState
      size="sm"
      title={state.q ? 'No matches' : state.tab === 'pending' ? 'Nothing waiting' : 'Nothing reviewed yet'}
      description={state.q
        ? 'No sample in this list matches the search.'
        : state.tab === 'pending'
          ? 'Samples arrive after a compaction pass; a person checks a small share of them against their evidence.'
          : 'Verdicts land here once a pending sample is agreed or disagreed with.'}
    />
  ) : (
    <GroupedList
      size="sm"
      groups={[{ id: state.tab, title: state.tab === 'pending' ? 'Pending' : 'Reviewed', count: rows.length }]}
      rows={rows.map((r) => ({
        id: r.id,
        groupId: state.tab,
        icon: <FileKindMark kind={recordFileKind(r.typeLabel === 'Pattern' ? 'cluster' : 'artifact')} size="sm" variant="glyph" />,
        title: r.title,
        subline: [
          r.resolved ? r.typeLabel : (r.error ?? 'Target could not be loaded'),
          r.sourceCount != null ? `${r.sourceCount} ${r.sourceCount === 1 ? 'note' : 'notes'}` : null,
          compactAge(r.sampledAt, nowMs) ? `${compactAge(r.sampledAt, nowMs)} ago` : null,
        ].filter(Boolean).join(' · '),
        pill: state.tab === 'decided' ? <StatusPill tone={VERDICT_PILL[r.verdict].tone} label={VERDICT_PILL[r.verdict].label} size="sm" /> : undefined,
        trailing: r.resolved ? undefined : <Button size="sm" variant="ghost" onClick={review.refresh}>Retry</Button>,
      }))}
      currentId={state.sample}
      onOpenRow={(row) => go({ sample: row.id })}
      data-testid="review-queue"
    />
  );

  const railFooter = (
    <Inline gap="sm" align="center" justify="between" className="px-3 py-2">
      <T className="text-[12px] text-text-tertiary">
        {counts.pending} pending{unresolved > 0 ? ` · ${unresolved} could not be loaded` : ''}
      </T>
    </Inline>
  );

  return (
    <ExplorerLayout
      railWidth="ml"
      railTitle="Review"
      railLabel="review queue"
      railHeader={railHeader}
      rail={railBody}
      railFooter={railFooter}
      panePadding="none"
      asidePlacement="beside"
      className="min-h-0 flex-1"
      data-testid="distillation-review"
      aside={selectedSample ? (
        <ContextColumn
          state={columnState}
          onStateChange={(next) => { setWide(next === 'wide'); go({ panel: next === 'collapsed' ? null : 'sources' }, { push: true }); }}
          label="Sources column"
          activeId="sources"
          onActivate={() => go({ panel: 'sources' }, { push: true })}
          roomy
          panels={[{
            id: 'sources',
            label: 'Sources',
            icon: <LinkIcon size={18} />,
            badge: sources.data?.sources?.length,
            content: subject ? (
              <SourcesPanel subject={subject} view={state.sourceView} onViewChange={(v) => go({ sourceView: v })} onOpen={openHref} />
            ) : (
              <EmptyState size="sm" title="No sources to show" description="The sampled record could not be loaded." />
            ),
          }]}
        />
      ) : undefined}
    >
      {selectedSample && selectedRow ? (
        <Claim
          key={selectedSample.id}
          sample={selectedSample}
          row={selectedRow}
          all={all}
          canReview={canReview}
          sampling={sampling.data}
          onVerdict={decide}
          onRetry={review.refresh}
          onOpenSources={() => go({ panel: 'sources' }, { push: true })}
          sourceCount={sources.data?.sources ? sources.data.sources.length : null}
          onOpen={openHref}
        />
      ) : (
        <EmptyState
          title={review.isLoading ? 'Loading…' : counts.pending === 0 && state.tab === 'pending' ? 'The queue is empty' : 'Nothing selected'}
          description="Pick a sample from the queue to compare its claim with the evidence."
        />
      )}
    </ExplorerLayout>
  );
}
