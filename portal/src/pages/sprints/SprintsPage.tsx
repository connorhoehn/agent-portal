// Sprints — the SME's own cadence, and the org-leader's view across them.
//
// The program operating model (docs/program-operating-model.md) is built on
// sprints: an initiative runs them, one SME stewards each, a budget_grant
// scopes an envelope to one, and work items carry sprint_id. Until this page
// existed the only surface for any of that was the grants TABLE on the Budgets
// page — gated to org-leader/hr-admin — so the SME the model is written for
// could not open their own sprint anywhere.
//
// Two framings this page holds deliberately:
//
//  • "Mine" is not "mine to steward". Stewardship in the seed sits with six
//    people while sprint work is assigned across the whole cast, so a sprint is
//    yours when you steward it, hold its envelope, OR have work in it — and
//    each card says which. Anything narrower shows most SMEs an empty page.
//
//  • The money is INITIATIVE spend inside the sprint window, and it is labelled
//    that way everywhere it appears. bot_runs record which initiative and which
//    bot paid, never whose envelope authorized it, so a "your burn" figure
//    would be invented. This repeats a decision already made for the Budgets
//    grants table rather than quietly softening it here.
//
// Planning lives here too, gated by capability. A user who holds ManageSprints
// gets a "New sprint" control and can move a work item into or out of a sprint
// from the board; one who holds ManageBudgets gets per-sprint grant management
// (list, add, re-size, revoke an envelope). Everything else stays read-only,
// and every write refetches the same data the page already loads.
//
// This file is the page SHELL only — scope, filters, the rollup, and which of
// the two list views is showing. The sprint card, the table, the detail with
// its work board and grants panel, and the create modal are each their own
// module beside this one; the pure derivations are in sprintFormat.ts and the
// form rules in sprintForm.ts, both covered by node:test.

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  CatalogGrid,
  EmptyState,
  KPIGrid,
  LoadingState,
  PageSection,
  SegmentedControl,
  Stack,
  StatCard,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { NewSprintModal } from './NewSprintModal';
import { SprintCard } from './SprintCard';
import { SprintDetail } from './SprintDetail';
import { SprintTable } from './SprintTable';
import { sprintTotals, usd } from './sprintFormat';
import type { Sprint, SprintsResponse } from './types';

export default function SprintsPage() {
  const { session } = useSession();
  // The wide scope carries every sprint's envelope, which is the money
  // /api/budgets gates — the API refuses `scope=all` to anyone else, so the
  // control only offers it where it will be honoured.
  const canRequestAll = session?.role === 'org-leader'
    || session?.role === 'hr-admin'
    || session?.role === 'admin';

  const { can } = useCapabilities();
  const canManageSprints = can('ManageSprints');
  const canManageBudgets = can('ManageBudgets');

  const [scope, setScope] = useState<'mine' | 'all'>(canRequestAll ? 'all' : 'mine');
  const [activeOnly, setActiveOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newSprintOpen, setNewSprintOpen] = useState(false);
  // Cards scan by shape, the table scans by column — with the org-wide scope a
  // release manager is reading 14 initiatives' sprints, and that is a table
  // job. Device pref, preserved across tenant switches like projects-view.
  const [view, setView] = useState<'cards' | 'table'>(() => {
    try { return (localStorage.getItem('sprints-view') as 'cards' | 'table') ?? 'cards'; } catch { return 'cards'; }
  });
  const setViewPref = (v: 'cards' | 'table') => {
    setView(v);
    try { localStorage.setItem('sprints-view', v); } catch { /* ignore */ }
  };

  const url = `/api/sprints?scope=${scope}${activeOnly ? '&status=active' : ''}`;
  const { data, isLoading, error, refresh } = useFetch<SprintsResponse>(url, 60_000);

  const sprints = useMemo(() => data?.sprints ?? [], [data]);

  // Keep a selection valid across scope/filter changes rather than silently
  // rendering a detail panel for a sprint no longer in the list.
  useEffect(() => {
    if (sprints.length === 0) { setSelectedId(null); return; }
    setSelectedId((cur) => (cur && sprints.some((s) => s.id === cur) ? cur : sprints[0]!.id));
  }, [sprints]);

  const selected = sprints.find((s) => s.id === selectedId) ?? null;
  const personId = data?.personId ?? null;

  // A freshly-created sprint would otherwise vanish: the list defaults to
  // active-only and the New Sprint form defaults to 'planned'. If the created
  // sprint wouldn't survive the current filter, drop the filter and select it
  // so the user lands on exactly what they just made. Changing `activeOnly`
  // repoints the fetch URL (useFetch refetches on url change); when it is
  // already off, refresh() picks up the new row.
  const handleCreated = (created: Sprint) => {
    if (activeOnly && created.status !== 'active') setActiveOnly(false);
    setSelectedId(created.id);
    refresh();
  };

  const totals = useMemo(() => sprintTotals(sprints), [sprints]);

  const description = scope === 'mine'
    ? 'Sprints you steward, hold an envelope on, or have work in — with the dates, the work and the money for each.'
    : 'Every initiative\'s sprints, the SME accountable for each, and what the initiative spent inside the window.';

  // The filters used to sit in the page header beside the create button —
  // four control groups in one row, with nothing to say which were filters and
  // which was a verb. They belong on the list they filter.
  const filters = (
    <Toolbar aria-label="Sprint filters">
      {canRequestAll ? (
        <ToolbarGroup>
          <SegmentedControl
            size="sm"
            value={scope}
            onChange={(v) => setScope(v as 'mine' | 'all')}
            options={[
              { label: 'Mine', value: 'mine' },
              { label: 'All sprints', value: 'all' },
            ]}
          />
        </ToolbarGroup>
      ) : null}
      <ToolbarGroup>
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
        <ToolbarLabel>
          {totals.myOpen} open item{totals.myOpen === 1 ? '' : 's'} assigned to you
        </ToolbarLabel>
      ) : null}
      <ToolbarGroup>
        <SegmentedControl
          size="sm"
          value={view}
          onChange={(v) => setViewPref(v as 'cards' | 'table')}
          options={[
            { label: 'Cards', value: 'cards' },
            { label: 'Table', value: 'table' },
          ]}
        />
      </ToolbarGroup>
    </Toolbar>
  );

  return (
    <PageSection
      title="Sprints"
      description={description}
      actions={canManageSprints
        ? <Button size="sm" variant="primary" onClick={() => setNewSprintOpen(true)}>+ New sprint</Button>
        : undefined}
    >
      <NewSprintModal open={newSprintOpen} onClose={() => setNewSprintOpen(false)} onCreated={handleCreated} />
      {error ? (
        <EmptyState
          title="Could not load sprints"
          description={
            <>
              {error}
              {/* The one failure worth naming: the org-wide scope carries every
                  sprint's envelope, so the API refuses it without ManageBudgets. */}
              {error.startsWith('403')
                ? ' — the org-wide scope needs ManageBudgets; switch back to “Mine”.'
                : ''}
            </>
          }
        />
      ) : isLoading && !data ? (
        <LoadingState label="Loading sprints…" />
      ) : sprints.length === 0 ? (
        <Stack gap="md">
          {filters}
          <EmptyState
            title={scope === 'mine' ? 'No sprints of yours' : 'No sprints'}
            description={
              scope === 'mine' && personId === null
                // An unlinked account is a different answer from "you have no
                // sprints", and saying so is the difference between a fixable
                // provisioning gap and an apparently empty product.
                ? 'Your sign-in is not linked to a person in the org graph, so "mine" cannot be resolved. Link it from Identity → Users.'
                : scope === 'mine'
                  ? 'No sprint currently has your stewardship, your envelope, or work assigned to you.'
                  : activeOnly
                    ? 'No sprint is active right now. Switch to "All time" to see past and planned ones.'
                    : 'No initiative has sprints yet.'
            }
          />
        </Stack>
      ) : (
        <Stack gap="lg">
          <KPIGrid columns={4}>
            <StatCard
              label={scope === 'mine' ? 'My sprints' : 'Sprints'}
              value={sprints.length}
              hint={activeOnly ? 'active only' : 'all statuses'}
            />
            <StatCard
              label="Points"
              value={`${totals.pointsDone} / ${totals.pointsTotal}`}
              hint="Complexity delivered against committed"
            />
            {/* These totals sum only the sprints currently loaded, so under the
                default active-only filter they are an active-sprint subtotal,
                not an org-wide figure — the hint says which, mirroring the
                "My sprints" tile above. */}
            <StatCard
              label="Envelopes granted"
              value={usd(totals.granted)}
              hint={activeOnly
                ? 'Budget grants on the active sprints only'
                : 'Sum of the budget grants scoped to these sprints'}
            />
            <StatCard
              label="Initiative spend in windows"
              value={usd(totals.spend)}
              hint={activeOnly
                ? 'Attributed to initiatives — active sprints only'
                : 'Attributed to the initiatives, not to people'}
            />
          </KPIGrid>

          <Stack gap="sm">
            {filters}
            {view === 'cards' ? (
              <CatalogGrid columns={4} dense>
                {sprints.map((s) => (
                  <SprintCard
                    key={s.id}
                    s={s}
                    selected={s.id === selectedId}
                    onSelect={() => setSelectedId(s.id)}
                  />
                ))}
              </CatalogGrid>
            ) : (
              <SprintTable sprints={sprints} onSelect={setSelectedId} />
            )}
          </Stack>

          {selected ? (
            <SprintDetail
              s={selected}
              personId={personId}
              canManageSprints={canManageSprints}
              canManageBudgets={canManageBudgets}
              onChanged={refresh}
            />
          ) : null}
        </Stack>
      )}
    </PageSection>
  );
}
