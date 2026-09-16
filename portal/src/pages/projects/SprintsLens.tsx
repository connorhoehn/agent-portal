// The Sprints lens of the Initiatives page.
//
// Sprints are not a separate place — a sprint is one initiative's iteration,
// so this renders inside /iq/projects (?lens=sprints) as a second zoom on the
// same program wall. The standalone /iq/sprints page this replaces stacked
// KPI tiles, a card grid, AND a full work board on one scroll; here the list
// is the page and the board opens in a drawer for the sprint you pick.
//
// Deeper planning (PI planning, capacity) is deliberately out of scope — that
// is a future tool, not more stacking on this page.

import { useMemo, useState } from 'react';
import {
  Button,
  CatalogGrid,
  Drawer,
  EmptyState,
  LoadingState,
  SegmentedControl,
  Stack,
  StatStrip,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
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

export function SprintsLens({ view }: { view: 'grid' | 'list' }) {
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

  const [scope, setScope] = useState<'mine' | 'all'>(canRequestAll ? 'all' : 'mine');
  const [activeOnly, setActiveOnly] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newSprintOpen, setNewSprintOpen] = useState(false);
  const [envelopesOpen, setEnvelopesOpen] = useState(false);

  const url = `/api/sprints?scope=${scope}${activeOnly ? '&status=active' : ''}`;
  const { data, isLoading, error, refresh } = useFetch<SprintsResponse>(url, 60_000);

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

  // The drawer tracks the live list — a refetch that drops the open sprint
  // (scope switch, filter change) closes it rather than showing stale data.
  const open = sprints.find((s) => s.id === openId) ?? null;

  const handleCreated = (created: Sprint) => {
    if (activeOnly && created.status !== 'active') setActiveOnly(false);
    setOpenId(created.id);
    refresh();
  };

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
      <NewSprintModal open={newSprintOpen} onClose={() => setNewSprintOpen(false)} onCreated={handleCreated} />

      {/* The per-envelope breakdown behind the "My envelope" tile. */}
      <EnvelopeDrawer
        open={envelopesOpen}
        onClose={() => setEnvelopesOpen(false)}
        data={envelopeData}
      />

      <StatStrip
        aria-label="Sprint rollup"
        items={[
          {
            label: scope === 'mine' ? 'My sprints' : 'Sprints',
            value: sprints.length,
            hint: activeOnly ? 'active only' : 'all statuses',
          },
          {
            label: 'Needs attention',
            value: needsAttention,
            ...(needsAttention > 0 ? { tone: 'danger' as const } : {}),
            hint: needsAttention > 0 ? 'behind window or over envelope' : 'all on track',
          },
          {
            label: 'Points',
            value: `${totals.pointsDone} / ${totals.pointsTotal}`,
            hint: 'delivered vs committed',
          },
          {
            label: 'Spend in windows',
            value: usd(totals.spend),
            ...(totals.granted > 0 && totals.spend > totals.granted ? { tone: 'danger' as const } : {}),
            hint: `of ${usd(totals.granted)} granted`,
          },
          // The reader's OWN envelope, last because it is personal rather than
          // programme-wide — and in the strip rather than a card of its own so
          // it costs the table no vertical space. `usd()` is not applied here:
          // the summary decides whether the value is money or a word, because
          // an unattributed burn has no number to print.
          ...(envelopes ? [{
            label: 'My envelope',
            value: envelopes.value,
            hint: envelopes.hint,
            ...(envelopes.tone ? { tone: envelopes.tone } : {}),
            ...(envelopes.openable ? { onSelect: () => setEnvelopesOpen(true) } : {}),
          }] : []),
        ]}
      />

      {filters}

      {sprints.length === 0 ? (
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
        <SprintTable sprints={sprints} onSelect={setOpenId} />
      ) : (
        <CatalogGrid columns={3} dense>
          {sprints.map((s) => (
            <SprintCard
              key={s.id}
              s={s}
              selected={s.id === openId}
              onSelect={() => setOpenId(s.id)}
            />
          ))}
        </CatalogGrid>
      )}

      {/* The board, on demand — not a second page stacked under the list. */}
      <Drawer
        open={open != null}
        onClose={() => setOpenId(null)}
        aria-label={open?.name ?? 'Sprint detail'}
        width={880}
      >
        {open ? (
          // frameless: the detail's own DetailHeader is the drawer's header —
          // a Drawer title above it would say the sprint's name twice.
          <SprintDetail
            s={open}
            personId={personId}
            canManageSprints={canManageSprints}
            canManageBudgets={canManageBudgets}
            onChanged={refresh}
            frameless
          />
        ) : null}
      </Drawer>
    </Stack>
  );
}
