/**
 * Sprints report — a release manager handing an SME an envelope of money for
 * one sprint. Labelled "Sprints" in the nav and the section heading (the word
 * "envelope" survives in prose below, where it is the correct domain term for
 * the grant itself).
 *
 * The window figure is the INITIATIVE's spend inside the sprint dates, and is
 * labelled as such: bot_runs record which initiative and which bot paid, never
 * which person's envelope, so presenting it as the SME's personal burn would
 * be a number the data cannot support.
 *
 * Nothing is hidden silently. A bare `.slice(0, 12)` under a header reading
 * "What each SME was given" dropped 6 of 18 envelopes with no count and no
 * paging — and because 13 were active, one live envelope was invisible. Every
 * ACTIVE envelope now always renders; only closed sprints collapse, behind an
 * explicit count and a toggle.
 *
 * There is no grant-CREATION route anywhere in the middleware
 * (`routes/budgets.ts` only reads `/grants`; `routes/sprints.ts` has none) —
 * granting an envelope is a `budget_grants` write the API does not expose
 * yet. Rather than fabricate a form this page cannot wire to anything (and
 * rather than repeat the old self-referential copy that told a reader on
 * THIS page to grant "from Initiatives → Sprints", i.e. here), a
 * ManageBudgets holder gets a real link to `/iq/sprints` — the page
 * `docs/program-operating-model.md` names as where a release manager works
 * sprint stewardship — with the gap said out loud rather than implied.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { matchesGrant } from './budgetsCommands';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Inline,
  Stack,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { usd } from './budgetsFormat';
import type { GrantRow } from './types';

const CLOSED_PREVIEW = 4;

export interface SprintsReportProps {
  grants: GrantRow[];
  error: string | null;
  hasData: boolean;
  /** ManageBudgets — the same gate Initiatives' allocation editor uses. */
  canManage: boolean;
  refresh?: () => void;
  /** The page's controlled search; narrows the table, never the empty state. */
  query?: string;
}

/** Points a ManageBudgets holder at where granting actually happens today.
 *  No `/api/sprints/:id/grants` (or similar) route exists, so this is a
 *  link, not an action that would need somewhere to POST. */
function GrantEnvelopeLink() {
  return (
    <T as="span" size="xs" weight="medium" className="shrink-0">
      <Link
        to="/iq/sprints"
        className="text-primary no-underline hover:underline"
        title="Granting envelopes is done from Sprints, not from this report"
      >
        Grant envelope →
      </Link>
    </T>
  );
}

// One line per envelope at the 44px list step. The sprint window used to be
// a second line under the sprint name; it is its own column now.
const GRANT_COLUMNS: DataTableColumn<GrantRow>[] = [
  { key: 'sme', header: 'SME', render: (g) => <T>{g.granteeName ?? g.granteePersonId}</T> },
  {
    key: 'initiative',
    header: 'Initiative',
    render: (g) => (
      <T as="span">
        <Link to={`/iq/projects/${encodeURIComponent(g.orgProjectId)}`} className="text-primary no-underline hover:underline">
          {g.orgProjectName ?? g.orgProjectId}
        </Link>
      </T>
    ),
  },
  {
    key: 'sprint',
    header: 'Sprint',
    render: (g) => (
      <Inline align="center" gap="sm" wrap={false}>
        <T>{g.sprintName ?? '—'}</T>
        {g.sprintStatus === 'active' && <Chip tone="success" size="xs">active</Chip>}
      </Inline>
    ),
  },
  {
    key: 'window',
    header: 'Window',
    render: (g) => (g.startsOn && g.endsOn
      ? <T tone="tertiary" tabular>{g.startsOn} → {g.endsOn}</T>
      : <T tone="tertiary">—</T>),
  },
  { key: 'envelope', header: 'Envelope', numeric: true, render: (g) => <T tabular>{usd(g.allocatedUsd)}</T> },
  {
    key: 'spend',
    header: 'Initiative spend in window',
    numeric: true,
    render: (g) => <T tone="secondary" tabular>{usd(g.initiativeSpendInWindowUsd)}</T>,
  },
];

export function SprintsReport({ grants: allGrants, error, hasData, canManage, refresh, query = '' }: SprintsReportProps) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);

  if (error) {
    return (
      <UnavailableNotice
        error={error}
        what="sprint envelopes"
        source="Grants are read from Aurora"
        onRetry={refresh}
      />
    );
  }

  if (hasData && allGrants.length === 0) {
    return (
      <EmptyState
        title="No sprint envelopes yet"
        description="Nothing has been granted yet. Granting an envelope to an SME is done from Sprints, not from this report."
        {...(canManage ? { actionLabel: 'Open Sprints', onAction: () => navigate('/iq/sprints') } : {})}
      />
    );
  }

  const grants = allGrants.filter((g) => matchesGrant(g, query));
  const active = grants.filter((g) => g.sprintStatus === 'active');
  const rest = grants.filter((g) => g.sprintStatus !== 'active');
  const shownRest = showAll ? rest : rest.slice(0, CLOSED_PREVIEW);
  const ordered = [...active, ...shownRest];
  const hidden = rest.length - shownRest.length;
  const countText = ordered.length === grants.length
    ? `${grants.length} ${grants.length === 1 ? 'envelope' : 'envelopes'} · ${active.length} active`
    : `showing ${ordered.length} of ${grants.length} · all ${active.length} active`;

  return (
    <Card padding="none" className="overflow-x-auto">
      <CardHeader
        inset
        title="Sprints"
        subtitle="What each SME was given to see a sprint through. Spend shown is the initiative's within the sprint window, not the individual's."
        action={
          <Inline align="center" gap="md" wrap={false}>
            <T size="xs" tone="tertiary" tabular>{countText}</T>
            {canManage && <GrantEnvelopeLink />}
          </Inline>
        }
      />
      <DataTable
        data-testid="budgets-sprints-table"
        frameless
        data={ordered}
        columns={GRANT_COLUMNS}
        keyField={(g) => g.id}
        emptyMessage="No sprint envelope matches this search."
      />
      {(hidden > 0 || showAll) && (
        <Stack gap="none" className="px-3 py-2 border-t border-border">
          <Button variant="link" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll
              ? `Show fewer — collapse ${rest.length - CLOSED_PREVIEW} closed ${rest.length - CLOSED_PREVIEW === 1 ? 'sprint' : 'sprints'}`
              : `Show ${hidden} more closed ${hidden === 1 ? 'sprint' : 'sprints'}`}
          </Button>
        </Stack>
      )}
    </Card>
  );
}
