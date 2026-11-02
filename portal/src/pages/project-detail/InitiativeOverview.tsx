// The initiative's Overview tab (v2, docs/design/initiative-v2-plan.md S1,
// A1–A2, U1–U2): one stats line under the tabs, "Needs attention N" as toned
// rows, and "Up next" with "View all N →". v1's "How to move this forward"
// is gone (V7): the composer's placeholder and prefill carry that job.
//
// Every number and every sentence is read off rows by `overviewModel` — this
// file only maps that model onto library composites. The header above it and
// the composer under it belong to the page (ScopeHeader, InitiativeComposer).

import type { ReactNode } from 'react';
import {
  ActionRowList,
  ActionRowPerson,
  type ActionRowColumn,
  type ActionRowItem,
} from '@connorhoehnslalom/ui-components';
import {
  ArrowRightIcon,
  Button,
  Chip,
  Inline,
  LoadingState,
  PageSection,
  Stack,
  StatStrip,
  T,
  type StatStripItem,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { relativeTime } from '../../lib/relativeTime';
import { RecordLink } from '../decisions/RecordLink';
import { ATTENTION_NONE, type OverviewModel, type OverviewStat } from './overviewModel';
import { DECISION_TONE } from './projectFormat';
import type { ProjectDecision } from './types';

function statItem(s: OverviewStat): StatStripItem {
  return {
    label: s.label,
    value: s.value,
    ...(s.progress != null ? { progress: { value: s.progress, max: 1 } } : {}),
  };
}

/** Match RecentWorkActivity's person + trailing fact widths so avatars share
 * an edge across Up next and Recent activity, including narrow panes. */
const COLUMNS: ActionRowColumn[] = [
  { id: 'person', width: 'xl', label: 'Assignee' },
  { id: 'points', width: 'sm', label: 'Points' },
];

function cells(assigneeName: string | null, avatarUrl: string | null, points: string | null): Record<string, ReactNode> {
  return {
    person: assigneeName ? <ActionRowPerson name={assigneeName} avatarUrl={avatarUrl ?? undefined} size={24} /> : <T tone="secondary">Unassigned</T>,
    points: points ?? <T tone="secondary">Unsized</T>,
  };
}

export function InitiativeOverview({
  model,
  onOpen,
  onRetry,
  recent,
  decisions,
}: {
  model: OverviewModel;
  /** The initiative's decisions; the ones still waiting are listed, each opening its record. */
  decisions?: ProjectDecision[] | null;
  /** The Recent activity list (a compact `RecentWorkActivity`); the canvas lives on the Activity tab. */
  recent?: ReactNode;
  /** Client-side navigation to a Work-tab deep link. */
  onOpen: (href: string) => void;
  onRetry?: () => void;
}) {
  const hrefOf = (items: Array<{ id: string; href: string }>) => (row: ActionRowItem) => {
    const hit = items.find((r) => r.id === row.id);
    if (hit) onOpen(hit.href);
  };

  const waiting = (decisions ?? []).filter((d) => d.status === 'open' || d.status === 'escalated');
  return (
    <Stack gap="xl" className="px-6 pb-6 pt-4" data-testid="initiative-overview">
      {/* Every role here sits on the app's body step (ui-components 2.429.0
          `size="sm"`: 14px headings/titles/stats, 12px descriptions) so the
          Overview reads like the tabs above it and the Distillation,
          Initiatives and scorecard surfaces — e2e/initiative-overview-type. */}
      <Inline gap="md" align="center" wrap>
        <StatStrip variant="line" items={model.stats.map(statItem)} aria-label="Initiative progress" data-testid="overview-stats" className="flex-1" />
        {model.state === 'ready' && model.attention.length === 0 && (
          <T size="sm" tone="secondary" role="status" data-testid="overview-attention-clear">{ATTENTION_NONE}</T>
        )}
      </Inline>

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
          {model.attention.length > 0 && <PageSection size="sm"
            title="Needs attention"
            // The count is the rows below it, never a stored total. It reads
            // as the pale-indigo pill of the mockup (ui-components 2.396.0).
            count={model.attention.length}
            countTone="primary"
            data-testid="overview-attention-section"
          >
            {
              <ActionRowList
                aria-label="Needs attention"
                tone="warning"
                accent="bar"
                action="Open"
                columns={COLUMNS}
                items={model.attention.map((a) => ({
                  id: a.id,
                  title: a.title,
                  // The tag of the mockup: pale red fill, soft red border, red text
                  // (outline soft since ui-components 2.396.0) at the 12px
                  // tag step of the compact rows.
                  leading: <Inline gap="xs" align="center" wrap={false}>
                    {a.key && <Chip tone="neutral" size="sm" mono>{a.key}</Chip>}
                    <Chip tone="danger" size="md" outline="soft">Blocked</Chip>
                  </Inline>,
                  // The row truncates its description to one line, and a
                  // blocked reason is a sentence (Cannot be written until the
                  // cu... at 1440px): whole on hover.
                  ...(a.reason ? { description: <T title={a.reason}>{a.reason}</T> } : {}),
                  cells: cells(a.assigneeName, a.assigneeAvatarUrl, a.points),
                }))}
                onOpen={hrefOf(model.attention)}
                data-testid="overview-attention"
              />
            }
          </PageSection>}

          {waiting.length > 0 && <PageSection size="sm" title="Waiting on a decision" count={waiting.length} data-testid="overview-decisions">
            <Stack gap="xs">
              {waiting.map((d) => (
                <Inline key={d.id} gap="sm" align="baseline" wrap={false}>
                  <Chip tone={DECISION_TONE[d.status] ?? 'warning'} size="xs" uppercase>{d.status}</Chip>
                  <T size="sm"><RecordLink to={`/iq/decisions/${encodeURIComponent(d.id)}`}>{d.topic}</RecordLink></T>
                  <T size="xs" tone="tertiary" className="truncate">
                    {[d.requiredRole ? `needs ${d.requiredRole}` : null, d.escalatedAt ? `escalated ${relativeTime(d.escalatedAt)}` : null].filter(Boolean).join(' · ')}
                  </T>
                </Inline>
              ))}
            </Stack>
          </PageSection>}

          <PageSection
            size="sm"
            title="Up next"
            // The mockup puts 32px between the attention row and this heading
            // where the other sections sit 24px apart (the library story
            // mt-8 against mt-6); the xl gap of the stack carries 24 of it.
            className={model.attention.length > 0 ? 'mt-2' : undefined}
            actions={model.viewAll ? (
              <Button variant="link" size="sm" onClick={() => onOpen(model.viewAll!.href)} data-testid="overview-view-all">
                <Inline gap="sm" align="center">
                  {model.viewAll.label}
                  <ArrowRightIcon size={16} />
                </Inline>
              </Button>
            ) : undefined}
            data-testid="overview-up-next"
          >
            <ActionRowList
              aria-label="Up next"
              className="work-overview-striped-rows"
              columns={COLUMNS}
              items={model.upNext.map((r) => ({
                id: r.id,
                title: r.title,
                description: r.key ? <T size="xs" tone="secondary" className="font-mono">{r.key}</T> : undefined,
                cells: cells(r.assigneeName, r.assigneeAvatarUrl, r.points),
              }))}
              onOpen={hrefOf(model.upNext)}
              emptyLabel="Nothing is up next."
            />
          </PageSection>
        </>
      )}
      {recent}
    </Stack>
  );
}
