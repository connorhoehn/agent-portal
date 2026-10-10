// The Sprints lens of the Initiatives page.
//
// Sprints are not a separate place — a sprint is one initiative's iteration,
// so this renders inside /iq/projects (?lens=sprints) as a second zoom on the
// same program wall. Selecting a sprint keeps its parent rails visible and
// opens the board inline; its URL selection survives Back and refresh.
//
// Deeper planning (PI planning, capacity) is deliberately out of scope — that
// is a future tool, not more stacking on this page.

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  CatalogGrid,
  EmptyState,
  Inline,
  LoadingState,
  SearchInput,
  SegmentedControl,
  Stack,
  StatStrip,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useRowSearch } from '../../hooks/useRowSearch';
import { useUrlState } from '../../lib/useUrlState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { EnvelopeDrawer } from '../sprints/EnvelopeDrawer';
import { NewSprintModal } from '../sprints/NewSprintModal';
import { SprintCard } from '../sprints/SprintCard';
import { SprintDetail } from '../sprints/SprintDetail';
import { SprintTable } from '../sprints/SprintTable';
import { atRiskCount, sprintTotals, usd } from '../sprints/sprintFormat';
import { summarizeEnvelopes } from '../../lib/envelopeFormat';
import type { EnvelopesResponse } from '../../lib/envelopeFormat';
import type { Sprint, SprintsResponse } from '../sprints/types';

/**
 * The lens's state and read, lifted out of the component so the Initiatives
 * explorer's rail can list the same sprints the pane shows (one read, one
 * scope, one open sprint). The list route calls this once and hands the
 * result to both `<SprintsLens>` and the rail.
 */
export function useSprintsLens(enabled = true) {
  const { session } = useSession();
  // The wide scope carries every sprint's envelope, which is the money
  // /api/budgets gates — the API refuses `scope=all` to anyone else, so the
  // control only offers it where it will be honoured.
  const canRequestAll = session?.role === 'org-leader'
    || session?.role === 'hr-admin'
    || session?.role === 'program-owner'
    || session?.role === 'admin';

  const { can } = useCapabilities();
  const canManageSprints = can('ManageSprints');
  const canManageBudgets = can('ManageBudgets');
  // Only a caller who can dispatch is ever braked by an envelope, so only they
  // are asked the question — and the read is self-scoped, so it needs no action.
  const canDispatch = can('DispatchAgentRun');

  const [params, setParams] = useSearchParams();
  const scope = canRequestAll && params.get('sprintScope') !== 'mine' ? 'all' : 'mine';
  const activeOnly = params.get('sprintWindow') !== 'any';
  const setScope = (next: 'mine' | 'all') => setParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('sprintScope', next);
    p.delete('sprint');
    return p;
  });
  const setActiveOnly = (next: boolean) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('sprintWindow', next ? 'active' : 'any');
    p.delete('sprint');
    return p;
  });
  const [openId, setOpenId] = useUrlState<string | null>('sprint', (raw) => raw, (value) => value, { replace: false });
  const [newSprintOpen, setNewSprintOpen] = useState(false);
  const [envelopesOpen, setEnvelopesOpen] = useState(false);

  const url = `/api/sprints?scope=${scope}${activeOnly ? '&status=active' : ''}`;
  const { data, isLoading, error, refresh } = useFetch<SprintsResponse>(enabled ? url : null, 60_000);

  return {
    canRequestAll, canManageSprints, canManageBudgets, canDispatch,
    scope, setScope, activeOnly, setActiveOnly, openId, setOpenId,
    newSprintOpen, setNewSprintOpen, envelopesOpen, setEnvelopesOpen,
    data, isLoading, error, refresh,
    onCreated: (created: Sprint) => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        if (created.status !== 'active') p.set('sprintWindow', 'any');
        p.set('sprint', created.id);
        return p;
      });
      refresh();
    },
  };
}

export type SprintsLensState = ReturnType<typeof useSprintsLens>;

export function SprintsLens({ view, lens }: { view: 'grid' | 'list'; lens: SprintsLensState }) {
  const { session } = useSession();
  const {
    canRequestAll, canManageSprints, canManageBudgets, canDispatch,
    scope, setScope, activeOnly, setActiveOnly, openId, setOpenId,
    newSprintOpen, setNewSprintOpen, envelopesOpen, setEnvelopesOpen,
    data, isLoading, error, refresh, onCreated,
  } = lens;

  // "How much of my sprint envelope is left" — the number `decideEnvelope`
  // brakes a dispatch on, which until this had no read surface at all: the
  // grants table is gated to the roles that ALLOCATE money and reports the
  // INITIATIVE's window spend, a different figure. Deliberately independent of
  // the sprints list above: it is self-scoped and answers even when the chosen
  // scope/window shows no sprints at all.
  const {
    data: envelopeData, isLoading: envelopesLoading, error: envelopesError,
  } = useFetch<EnvelopesResponse>(canDispatch ? '/api/sprints/envelopes' : null, 60_000);

  const envelopes = useMemo(() => summarizeEnvelopes({
    data: envelopeData,
    isLoading: envelopesLoading,
    error: envelopesError,
    canDispatch,
    role: session?.role,
  }), [envelopeData, envelopesLoading, envelopesError, canDispatch, session?.role]);

  const sprints = useMemo(() => data?.sprints ?? [], [data]);
  const personId = data?.personId ?? null;
  const totals = useMemo(() => sprintTotals(sprints), [sprints]);
  const needsAttention = useMemo(() => atRiskCount(sprints), [sprints]);
  // The search shares the strip's row (docs/layout-cascade.md "Tables").
  const search = useRowSearch(sprints, (s) => [s.name, s.orgProjectName, s.stewardName, s.status].filter(Boolean).join(' '));

  // The detail tracks the live list — a refetch that drops the open sprint
  // (scope switch, filter change) closes it rather than showing stale data.
  const open = sprints.find((s) => s.id === openId) ?? null;

  if (error) {
    return (
      <UnavailableNotice
        error={error.startsWith('403')
          ? `${error} — the org-wide scope needs budget-administration access; switch back to "Mine"`
          : error}
        what="sprints"
        source="Sprints are read from Aurora"
        onRetry={refresh}
      />
    );
  }

  if (isLoading && !data) {
    return <LoadingState label="Loading sprints…" />;
  }

  // Same composition as the initiatives lens: labeled groups, divided
  // separators, and the one verb in the end slot.
  const filters = (
    <Toolbar
      size="md"
      aria-label="Sprint filters"
      end={canManageSprints ? (
        <Button size="sm" variant="primary" onClick={() => setNewSprintOpen(true)}>+ New sprint</Button>
      ) : undefined}
    >
      {canRequestAll ? (
        <ToolbarGroup aria-label="Scope">
          <ToolbarLabel>Show</ToolbarLabel>
          <SegmentedControl
            size="sm"
            value={scope}
            onChange={(v) => setScope(v as 'mine' | 'all')}
            options={[
              { label: 'Everyone', value: 'all' },
              { label: 'Mine', value: 'mine' },
            ]}
          />
        </ToolbarGroup>
      ) : null}
      <ToolbarGroup divided={canRequestAll} aria-label="Window">
        <ToolbarLabel>Window</ToolbarLabel>
        <SegmentedControl
          size="sm"
          value={activeOnly ? 'active' : 'any'}
          onChange={(v) => setActiveOnly(v === 'active')}
          options={[
            { label: 'Active', value: 'active' },
            { label: 'All time', value: 'any' },
          ]}
        />
      </ToolbarGroup>
      {scope === 'mine' && totals.myOpen > 0 ? (
        <ToolbarGroup divided>
          <ToolbarLabel>
            {totals.myOpen} open item{totals.myOpen === 1 ? '' : 's'} assigned to you
          </ToolbarLabel>
        </ToolbarGroup>
      ) : null}
    </Toolbar>
  );

  return (
    <Stack gap="md">
      <NewSprintModal open={newSprintOpen} onClose={() => setNewSprintOpen(false)} onCreated={onCreated} />

      {/* The per-envelope breakdown behind the "My envelope" tile. */}
      <EnvelopeDrawer
        open={envelopesOpen}
        onClose={() => setEnvelopesOpen(false)}
        data={envelopeData}
      />

      {/* One line of prose stats, as the initiative detail page draws them.
          The KPI-card strip gave each cluster ~140px of a 708px pane at
          1440px, so every hint was cut ("of $65.00 granted" in 51px); the
          line variant wraps between clusters, never inside one, so each
          hint now reads as the rest of its sentence. */}
      <Inline align="center" gap="md" wrap>
      {!open && <StatStrip
        variant="line"
        size="sm"
        aria-label="Sprint rollup"
        items={[
          {
            label: `${activeOnly ? 'active ' : ''}sprint${sprints.length === 1 ? '' : 's'}${scope === 'mine' ? ' of yours' : ''}`,
            value: sprints.length,
          },
          {
            label: 'late or over envelope',
            value: needsAttention,
            ...(needsAttention > 0 ? { tone: 'danger' as const, title: 'Behind its window or over its envelope' } : {}),
          },
          {
            label: 'points done',
            value: `${totals.pointsDone} / ${totals.pointsTotal}`,
            title: 'Points delivered vs points committed',
          },
          {
            label: `spent in windows of ${usd(totals.granted)} granted`,
            value: usd(totals.spend),
            ...(totals.granted > 0 && totals.spend > totals.granted ? { tone: 'danger' as const } : {}),
          },
          // The reader's OWN envelope, last because it is personal rather than
          // programme-wide — and in the strip rather than a card of its own so
          // it costs the table no vertical space. `usd()` is not applied here:
          // the summary decides whether the value is money or a word, because
          // an unattributed burn has no number to print.
          ...(envelopes ? [{
            // The reason sentence for an unknown burn is the tooltip, not the label — it
            // wrapped the strip onto a second row beside the filters and the search.
            label: envelopes.kind === 'known' ? `left in my envelope${envelopes.count === 1 ? '' : 's'} ${envelopes.hint}` : 'my envelope',
            value: envelopes.value,
            // A reason sentence can outrun the pane: whole on hover.
            title: envelopes.hint,
            ...(envelopes.tone ? { tone: envelopes.tone } : {}),
            ...(envelopes.openable ? { onSelect: () => setEnvelopesOpen(true) } : {}),
          }] : []),
        ]}
      />}
      {filters}
      {!open && sprints.length > 0 && (
        <SearchInput
          size="sm"
          className="ml-auto w-64 shrink-0"
          value={search.query}
          onChange={search.setQuery}
          onClear={() => search.setQuery('')}
          placeholder="Search sprints"
          aria-label="Search sprints"
        />
      )}
      </Inline>

      {open ? (
        <SprintDetail
          key={open.id}
          s={open}
          personId={personId}
          canManageSprints={canManageSprints}
          canManageBudgets={canManageBudgets}
          onChanged={refresh}
          frameless
        />
      ) : sprints.length === 0 ? (
        <EmptyState
          title={scope === 'mine' ? 'No sprints of yours' : 'No sprints'}
          description={
            scope === 'mine' && personId === null
              ? 'Your sign-in is not linked to a person in the org graph, so "mine" cannot be resolved. Link it from Identity → Users.'
              : scope === 'mine'
                ? 'No sprint currently has your stewardship, your envelope, or work assigned to you.'
                : activeOnly
                  ? 'No sprint is active right now. Switch to "All time" to see past and planned ones.'
                  : 'No initiative has sprints yet.'
          }
        />
      ) : view === 'list' ? (
        <SprintTable sprints={search.rows} onSelect={setOpenId} emptyMessage={`No sprint matches “${search.query.trim()}”.`} />
      ) : (
        <CatalogGrid columns={3} dense>
          {search.rows.map((s) => (
            <SprintCard
              key={s.id}
              s={s}
              selected={s.id === openId}
              onSelect={() => setOpenId(s.id)}
            />
          ))}
        </CatalogGrid>
      )}

    </Stack>
  );
}
