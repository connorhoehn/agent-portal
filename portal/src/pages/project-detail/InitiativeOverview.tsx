// The initiative's Overview tab (mockup variant 1, O6–O9): the inline stat
// strip, "What needs attention", "Plan next" and "How to move this forward".
//
// Every number and every sentence is read off rows by `overviewModel` — this
// file only maps that model onto library composites. The header above it and
// the composer under it belong to the page (ScopeHeader, InitiativeComposer).

import {
  ActionRowList,
  Banner,
  DetailSection,
  StatStrip,
  type StatStripItem,
} from '@connorhoehnslalom/ui-components';
import { ArrowRightIcon, Button, Inline, LoadingState, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import {
  ATTENTION_NONE,
  MOVE_FORWARD_BODY,
  MOVE_FORWARD_TITLE,
  type AttentionItem,
  type OverviewModel,
  type OverviewStat,
} from './overviewModel';

function statItem(s: OverviewStat): StatStripItem {
  return {
    label: s.label,
    value: s.value,
    ...(s.progress != null ? { progress: { value: s.progress, max: 1 } } : {}),
  };
}

/** "Open work →", "See all 11 work items →": a quiet link-styled action. */
function ArrowAction({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <Button variant="link" onClick={onClick} data-testid={testId}>
      <Inline gap="xs" align="center">
        {label}
        <ArrowRightIcon size={16} />
      </Inline>
    </Button>
  );
}

function AttentionCallout({ item, onOpen }: { item: AttentionItem; onOpen: (href: string) => void }) {
  return (
    <Banner
      layout="callout"
      variant="warning"
      accent="bar"
      size="lg"
      title={item.title}
      meta={(
        <Inline gap="xs" align="center" wrap>
          {item.meta.map((m, i) => (
            <T key={m.label} className={m.tone === 'warning' ? 'text-warning' : undefined}>
              {i > 0 ? `· ${m.label}` : m.label}
            </T>
          ))}
        </Inline>
      )}
      action={<ArrowAction label={item.actionLabel} onClick={() => onOpen(item.href)} testId="overview-attention-open" />}
      data-testid="overview-attention"
    >
      {item.body}
    </Banner>
  );
}

export function InitiativeOverview({
  model,
  onOpen,
  onRetry,
}: {
  model: OverviewModel;
  /** Client-side navigation to a Work-tab deep link. */
  onOpen: (href: string) => void;
  onRetry?: () => void;
}) {
  return (
    <Stack gap="lg" className="px-6 pb-6 pt-1" data-testid="initiative-overview">
      <StatStrip variant="inline" items={model.stats.map(statItem)} aria-label="Initiative progress" data-testid="overview-stats" />

      {model.state === 'loading' && <LoadingState label="Loading work…" />}
      {model.state === 'error' && (
        // A failed /work read is its own state — never "Nothing is blocked"
        // over data we could not read.
        <UnavailableNotice
          error={model.error}
          what="work items"
          source="Work items are read from the org graph"
          {...(onRetry ? { onRetry } : {})}
        />
      )}
      {model.state === 'ready' && (
        <>
          <DetailSection first variant="heading" size="lg" title="What needs attention" data-testid="overview-attention-section">
            {model.attention
              ? <AttentionCallout item={model.attention} onOpen={onOpen} />
              : <T className="text-text-secondary">{ATTENTION_NONE}</T>}
          </DetailSection>

          <DetailSection variant="heading" size="lg" title="Plan next" data-testid="overview-plan-next">
            <ActionRowList
              aria-label="Plan next"
              items={model.planNext.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
                meta: r.meta,
              }))}
              onOpen={(row) => {
                const hit = model.planNext.find((r) => r.id === row.id);
                if (hit) onOpen(hit.href);
              }}
              emptyLabel="Nothing is up next."
              footer={model.seeAll
                ? <ArrowAction label={model.seeAll.label} onClick={() => onOpen(model.seeAll!.href)} testId="overview-see-all" />
                : undefined}
            />
          </DetailSection>

          <DetailSection variant="heading" size="lg" title={MOVE_FORWARD_TITLE} description={MOVE_FORWARD_BODY}>
            {null}
          </DetailSection>
        </>
      )}
    </Stack>
  );
}
