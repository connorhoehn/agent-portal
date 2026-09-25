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
import { ATTENTION_NONE, type OverviewModel, type OverviewStat } from './overviewModel';

function statItem(s: OverviewStat): StatStripItem {
  return {
    label: s.label,
    value: s.value,
    ...(s.progress != null ? { progress: { value: s.progress, max: 1 } } : {}),
  };
}

/** Person ┆ points, declared once so the cells line up down both lists. */
const COLUMNS: ActionRowColumn[] = [
  { id: 'person', width: 'xl', label: 'Assignee' },
  { id: 'points', width: 'xs', label: 'Points' },
];

function cells(assigneeName: string | null, points: string | null): Record<string, ReactNode> {
  return {
    person: assigneeName ? <ActionRowPerson name={assigneeName} /> : <T className="text-text-secondary">Unassigned</T>,
    points: points ?? <T className="text-text-secondary">Unsized</T>,
  };
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
  const hrefOf = (items: Array<{ id: string; href: string }>) => (row: ActionRowItem) => {
    const hit = items.find((r) => r.id === row.id);
    if (hit) onOpen(hit.href);
  };

  return (
    <Stack gap="xl" className="px-6 pb-6 pt-5" data-testid="initiative-overview">
      <StatStrip variant="line" items={model.stats.map(statItem)} aria-label="Initiative progress" data-testid="overview-stats" />

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
          <PageSection
            size="md"
            title="Needs attention"
            // The count is the rows below it, never a stored total.
            count={model.attention.length}
            data-testid="overview-attention-section"
          >
            {model.attention.length > 0 ? (
              <ActionRowList
                aria-label="Needs attention"
                tone="warning"
                accent="bar"
                action="Open"
                columns={COLUMNS}
                items={model.attention.map((a) => ({
                  id: a.id,
                  title: a.title,
                  leading: <Chip tone="danger" size="md" outline>Blocked</Chip>,
                  ...(a.reason ? { description: a.reason } : {}),
                  cells: cells(a.assigneeName, a.points),
                }))}
                onOpen={hrefOf(model.attention)}
                data-testid="overview-attention"
              />
            ) : (
              <T className="text-text-secondary">{ATTENTION_NONE}</T>
            )}
          </PageSection>

          <PageSection
            size="md"
            title="Up next"
            actions={model.viewAll ? (
              <Button variant="link" onClick={() => onOpen(model.viewAll!.href)} data-testid="overview-view-all">
                <Inline gap="xs" align="center">
                  {model.viewAll.label}
                  <ArrowRightIcon size={16} />
                </Inline>
              </Button>
            ) : undefined}
            data-testid="overview-up-next"
          >
            <ActionRowList
              aria-label="Up next"
              columns={COLUMNS}
              items={model.upNext.map((r) => ({ id: r.id, title: r.title, cells: cells(r.assigneeName, r.points) }))}
              onOpen={hrefOf(model.upNext)}
              emptyLabel="Nothing is up next."
            />
          </PageSection>
        </>
      )}
    </Stack>
  );
}
