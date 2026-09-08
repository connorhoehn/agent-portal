// Distillation → Review sample. The human sample queue the old page only
// summarized as "4% what humans review" with no queue to open. A small,
// tunable slice of L1 clusters and L2 artifacts is sampled for a person to
// check against its evidence — not everything, by design; reviewing every
// merge would defeat the point of running the machine unattended. Whether
// that sample rate is right is the calibration verdict, explained here next
// to the queue it's actually calibrating.
import { useEffect, useState } from 'react';
import {
  Button, Card, Chip, EmptyState, Inline, InlineAlert, LoadingState, PageSection, Stack, Tabs, Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { T } from './Text';
import {
  REVIEW_VERDICT_LABEL, REVIEW_VERDICT_TONE, SAMPLING_LABEL, SAMPLING_TONE, artifactFactCount,
} from './distillationFormat';
import type { Item, ReviewResponse, ReviewSample, ReviewVerdict, SamplingResponse } from './types';

type DecidedVerdict = Extract<ReviewVerdict, 'agree' | 'disagree'>;

export default function DistillationReviewPage() {
  const { can, ready } = useCapabilities();
  const canReview = ready && can('ManageBots');
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  // The banner counts the same samples the queue lists, so a decision must
  // refresh it too — on a 60s poll alone it sat contradicting the queue
  // beneath it for up to a minute.
  const { data: samplingData, refresh: refreshSampling } =
    useFetch<SamplingResponse>('/api/distillation/sampling', 60_000);

  const url = tab === 'pending' ? '/api/distillation/review?verdict=pending' : '/api/distillation/review';
  const { data, isLoading, error, refresh } = useFetch<ReviewResponse>(url, 30_000);
  const [samples, setSamples] = useState<ReviewSample[]>([]);

  useEffect(() => {
    const all = data?.samples ?? [];
    setSamples(tab === 'decided' ? all.filter((s) => s.verdict !== 'pending') : all);
  }, [data, tab]);

  function decide(id: string, verdict: DecidedVerdict, note: string) {
    const prev = samples;
    setSamples((cur) => (tab === 'pending'
      ? cur.filter((s) => s.id !== id)
      : cur.map((s) => (s.id === id ? { ...s, verdict, note: note || null } : s))));
    void (async () => {
      try {
        const res = await fetch(`/api/distillation/review/${encodeURIComponent(id)}`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict, note }),
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        toastSuccess(null, `Marked ${REVIEW_VERDICT_LABEL[verdict].toLowerCase()}`);
        refresh();
        refreshSampling();
      } catch (err) {
        setSamples(prev);
        toastError(null, 'Could not save review', err instanceof Error ? err.message : 'Request failed');
      }
    })();
  }

  return (
    <PageSection
      title="Review sample"
      description="The sampled clusters and artifacts a human checks against their evidence."
    >
      <Stack gap="md">
        {samplingData && (
          <InlineAlert tone={SAMPLING_TONE[samplingData.verdict.verdict]}>
            <T className="font-semibold">{SAMPLING_LABEL[samplingData.verdict.verdict]}</T> — {samplingData.verdict.reason}
            {' · '}{samplingData.l1SampleRatePct}% of L1 sampled · {samplingData.reviewedLast30d} reviewed in 30d
            {' · '}{samplingData.queueDepth} pending now · {samplingData.agreementRatePct}% agreement
          </InlineAlert>
        )}

        <Tabs
          items={[
            { id: 'pending', label: 'Pending' },
            { id: 'decided', label: 'Decided' },
          ]}
          value={tab}
          onValueChange={(id) => setTab(id === 'decided' ? 'decided' : 'pending')}
          aria-label="Review queue"
          size="sm"
        />

        {error ? (
          <EmptyState title="Could not load the review queue" description={error} />
        ) : isLoading && !data ? (
          <LoadingState label="Loading review queue…" />
        ) : samples.length === 0 ? (
          <EmptyState
            title={tab === 'pending' ? 'Queue is empty' : 'Nothing decided yet'}
            description={tab === 'pending' ? 'No samples waiting on a human right now.' : 'No sample has been agreed or disagreed with yet.'}
          />
        ) : (
          <Stack gap="sm">
            {samples.map((s) => (
              <SampleCard key={s.id} sample={s} canReview={canReview} onDecide={decide} />
            ))}
          </Stack>
        )}
      </Stack>
    </PageSection>
  );
}

function SampleCard({
  sample, canReview, onDecide,
}: { sample: ReviewSample; canReview: boolean; onDecide: (id: string, verdict: DecidedVerdict, note: string) => void }) {
  const [choice, setChoice] = useState<DecidedVerdict | null>(null);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const { data: item, isLoading: itemLoading } =
    useFetch<Item>(expanded ? `/api/distillation/items/${encodeURIComponent(sample.target_id)}` : null, 0);

  function submit() {
    if (!choice) return;
    onDecide(sample.id, choice, note);
    setChoice(null); setNote('');
  }

  // Defect #16 (org-leader/DEFECTS.md #16): Cancel used to just clear
  // `choice`/`note`, leaving `document.activeElement` on `<body>` once the
  // Cancel button itself unmounted with the form. Same pattern as
  // `sprints/GrantsPanel.tsx` and `marketplace/EstimateDrawer.tsx`: the
  // trigger that opened the form (Agree or Disagree) carries a stable,
  // re-queryable `data-review-trigger` rather than a captured ref, because
  // `requestAnimationFrame` below runs after this render has already
  // committed — by then the form is gone and the Agree/Disagree pair is
  // whatever fresh node React just produced, so a ref taken before the
  // click would already be stale.
  function cancelForm() {
    const opener = choice;
    setChoice(null); setNote('');
    if (!opener) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        `[data-review-trigger="${CSS.escape(sample.id)}:${opener}"]`,
      )?.focus();
    });
  }

  return (
    <Card padding="sm">
      <Stack gap="sm">
        <Inline gap="sm" align="center" justify="between" wrap>
          <Inline gap="xs" align="center">
            <Chip tone="neutral" size="xs">{sample.target_kind}</Chip>
            <T className="text-[12.5px] font-medium text-text-primary">
              {item && expanded ? item.title : sample.target_id}
            </T>
          </Inline>
          <Inline gap="xs" align="center">
            <Chip tone={REVIEW_VERDICT_TONE[sample.verdict]} size="xs">{REVIEW_VERDICT_LABEL[sample.verdict]}</Chip>
            <T className="whitespace-nowrap text-[11px] text-text-tertiary">sampled {relativeTime(sample.sampled_at)}</T>
          </Inline>
        </Inline>

        <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide evidence' : 'View evidence'}
        </Button>
        {expanded && (itemLoading && !item ? <LoadingState label="Loading evidence…" /> : <EvidenceView item={item ?? null} />)}

        {sample.note && (
          <T className="text-[11px] italic text-text-tertiary">
            “{sample.note}”{sample.reviewer ? ` — ${sample.reviewer}` : ''}
          </T>
        )}

        {canReview && sample.verdict === 'pending' && (
          <Stack gap="xs">
            <Inline gap="xs">
              <Button
                size="sm"
                variant={choice === 'agree' ? 'primary' : 'secondary'}
                onClick={() => setChoice('agree')}
                data-review-trigger={`${sample.id}:agree`}
              >
                Agree
              </Button>
              <Button
                size="sm"
                variant={choice === 'disagree' ? 'danger' : 'secondary'}
                onClick={() => setChoice('disagree')}
                data-review-trigger={`${sample.id}:disagree`}
              >
                Disagree
              </Button>
            </Inline>
            {choice && (
              <Stack gap="xs">
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note…"
                  aria-label={`Note for ${choice === 'agree' ? 'agreeing with' : 'disagreeing with'} this sample`}
                />
                <Inline gap="xs">
                  <Button size="sm" variant="primary" onClick={submit}>Submit {REVIEW_VERDICT_LABEL[choice]}</Button>
                  <Button size="sm" variant="ghost" onClick={cancelForm}>Cancel</Button>
                </Inline>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function EvidenceView({ item }: { item: Item | null }) {
  if (!item) return <T className="text-[11px] text-text-tertiary">Could not load the target.</T>;
  if (item.level === 'L2') {
    // `Artifact.facts` is bare fact IDs — a fact's statement/evidence only
    // exists via lineage (no `GET /facts/:id`), which this queue doesn't
    // fetch per sample, so evidence here is the artifact's own summary
    // (clusters + fact count); "Open lineage" from Artifacts is where the
    // per-fact evidence lives.
    return (
      <T className="text-[11.5px] text-text-secondary">
        {item.cluster_ids.length} cluster{item.cluster_ids.length === 1 ? '' : 's'} · {artifactFactCount(item)} fact{artifactFactCount(item) === 1 ? '' : 's'}
      </T>
    );
  }
  if (item.level === 'L1') {
    return (
      <T className="text-[11.5px] text-text-secondary">
        {item.member_observation_ids.length} member observation{item.member_observation_ids.length === 1 ? '' : 's'} · confidence {Math.round(item.confidence * 100)}%
      </T>
    );
  }
  return <T className="text-[11.5px] text-text-secondary" wrap>{item.body}</T>;
}
