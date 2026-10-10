// Build → Distillation, the module's own landing (`?nav=distillation`): real
// content, never a placeholder (docs/layout-cascade.md). The three knowledge
// tiers with their live counts and their newest records, plus the review
// queue's waiting count — each a way into its destination.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  Button, EmptyState, GroupedList, LoadingState, PageSection, Stack, StatStrip,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { knowledgeHref, knowledgeItemHref, levelForView, reviewHref, type KnowledgeView } from './distillationRoutes';
import { VIEW_LABEL, VIEW_NOUN, VIEWS, explorerRows } from './knowledgeModel';
import { useKnowledgeItems } from './useKnowledgeItems';
import { DistillationDemoPanel } from './DistillationDemoPanel';

const PREVIEW = 5;

function TierPreview({ view, repo, count, version }: { view: KnowledgeView; repo: string | null; count: number | null; version: string | null }) {
  const navigate = useNavigate();
  const level = levelForView(view);
  const feed = useKnowledgeItems({ level, repo, initiative: null, q: null, version });
  const rows = useMemo(() => explorerRows(feed.items, { kind: null, lifecycle: null }, Date.now()).slice(0, PREVIEW), [feed.items]);
  return (
    <PageSection
      size="md"
      title={VIEW_LABEL[view]}
      {...(count != null ? { count } : {})}
      actions={<Button size="sm" variant="ghost" onClick={() => navigate(knowledgeHref({ view, repo }))}>Open {VIEW_NOUN[view]} →</Button>}
      data-testid={`distillation-overview-${view}`}
    >
      {feed.error ? (
        <UnavailableNotice error={feed.error} what={VIEW_NOUN[view]} source="Distillation items are read from Aurora" onRetry={feed.retry} />
      ) : feed.loading ? (
        <LoadingState label={`Loading ${VIEW_NOUN[view]}…`} />
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={`No ${VIEW_NOUN[view]} yet`} description="This fills in as agent sessions run and their notes are compacted up the tiers." />
      ) : (
        <GroupedList
          size="md"
          groupHeading="label"
          groups={[{ id: 'newest', title: 'Newest', count: rows.length }]}
          rows={rows.map((r) => ({ id: r.id, groupId: 'newest', title: r.title, subline: r.subline, ariaLabel: r.ariaLabel }))}
          onOpenRow={(row) => navigate(knowledgeItemHref(row.id, level, { repo }))}
        />
      )}
    </PageSection>
  );
}

export function DistillationOverview({ repo, counts, pending, versions, canPlay = false, onDemoChanged }: {
  repo: string | null;
  counts: Record<KnowledgeView, number | null>;
  pending: number | null | undefined;
  /** Each tier's digest, so the previews follow the live tiers. */
  versions?: Record<KnowledgeView, string | null>;
  /** ManageBots: may start the mock demo (shown only on a mock server). */
  canPlay?: boolean;
  onDemoChanged?: () => void;
}) {
  const navigate = useNavigate();
  const stat = (n: number | null | undefined) => (n == null ? '—' : String(n));
  return (
    <Stack gap="lg" data-testid="distillation-overview">
      <DistillationDemoPanel canPlay={canPlay} onChanged={onDemoChanged ?? (() => {})} />
      <StatStrip
        aria-label="Distillation at a glance"
        items={[
          { label: VIEW_LABEL.guides, value: stat(counts.guides), hint: 'reusable guides', onSelect: () => navigate(knowledgeHref({ view: 'guides', repo })) },
          { label: VIEW_LABEL.patterns, value: stat(counts.patterns), hint: 'recurring across runs', onSelect: () => navigate(knowledgeHref({ view: 'patterns', repo })) },
          { label: VIEW_LABEL.notes, value: stat(counts.notes), hint: 'raw observations', onSelect: () => navigate(knowledgeHref({ view: 'notes', repo })) },
          { label: 'Waiting for review', value: stat(pending), hint: 'sampled claims', tone: pending ? 'accent' : 'default', onSelect: () => navigate(reviewHref({ repo })) },
        ]}
      />
      {VIEWS.map((view) => <TierPreview key={view} view={view} repo={repo} count={counts[view]} version={versions?.[view] ?? null} />)}
    </Stack>
  );
}
