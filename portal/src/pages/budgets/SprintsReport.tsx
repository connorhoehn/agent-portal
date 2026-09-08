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
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Inline,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { usd } from './budgetsFormat';
import { T } from './Text';
import type { GrantRow } from './types';

const CLOSED_PREVIEW = 4;

export interface SprintsReportProps {
  grants: GrantRow[];
  error: string | null;
  hasData: boolean;
  /** ManageBudgets — the same gate Initiatives' allocation editor uses. */
  canManage: boolean;
}

/** Points a ManageBudgets holder at where granting actually happens today.
 *  No `/api/sprints/:id/grants` (or similar) route exists, so this is a
 *  link, not an action that would need somewhere to POST. */
function GrantEnvelopeLink() {
  return (
    <Link
      to="/iq/sprints"
      className="text-[11.5px] font-medium text-primary no-underline hover:underline shrink-0"
      title="Granting envelopes is done from Sprints, not from this report"
    >
      Grant envelope →
    </Link>
  );
}

export function SprintsReport({ grants, error, hasData, canManage }: SprintsReportProps) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);

  if (error) {
    return (
      <Card padding="md">
        <T className="text-[12px] text-danger">Failed to load sprint envelopes: {error}</T>
      </Card>
    );
  }

  if (hasData && grants.length === 0) {
    return (
      <EmptyState
        title="No sprint envelopes yet"
        description="Nothing has been granted yet. Granting an envelope to an SME is done from Sprints, not from this report."
        {...(canManage ? { actionLabel: 'Open Sprints', onAction: () => navigate('/iq/sprints') } : {})}
      />
    );
  }

  const active = grants.filter((g) => g.sprintStatus === 'active');
  const rest = grants.filter((g) => g.sprintStatus !== 'active');
  const shownRest = showAll ? rest : rest.slice(0, CLOSED_PREVIEW);
  const ordered = [...active, ...shownRest];
  const hidden = rest.length - shownRest.length;

  return (
    <Card padding="none" className="overflow-x-auto">
      <Stack gap="none" className="px-3.5 py-3 border-b border-border">
        <Inline align="baseline" justify="between" gap="sm" wrap>
          <T className="text-[13px] font-semibold text-text-primary">Sprints</T>
          <Inline align="center" gap="md" wrap={false}>
            <T className="text-[11px] text-text-tertiary tabular-nums">
              {ordered.length === grants.length
                ? `${grants.length} ${grants.length === 1 ? 'envelope' : 'envelopes'} · ${active.length} active`
                : `showing ${ordered.length} of ${grants.length} · all ${active.length} active`}
            </T>
            {canManage && <GrantEnvelopeLink />}
          </Inline>
        </Inline>
        <T className="text-[11.5px] text-text-secondary mt-0.5" wrap>
          What each SME was given to see a sprint through. Spend shown is the initiative's
          within the sprint window, not the individual's.
        </T>
      </Stack>
      <Table>
        <TableHead>
          <TableRow>
            <TableTh>SME</TableTh>
            <TableTh>Initiative</TableTh>
            <TableTh>Sprint</TableTh>
            <TableTh>Envelope</TableTh>
            <TableTh>Initiative spend in window</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {ordered.map((g) => (
            <TableRow key={g.id}>
              <TableTd>
                <T className="text-[12.5px] text-text-primary">{g.granteeName ?? g.granteePersonId}</T>
              </TableTd>
              <TableTd>
                <Link
                  to={`/iq/projects/${encodeURIComponent(g.orgProjectId)}`}
                  className="text-[12.5px] text-primary no-underline hover:underline"
                >
                  {g.orgProjectName ?? g.orgProjectId}
                </Link>
              </TableTd>
              <TableTd>
                <Stack gap="none">
                  <Inline align="center" gap="sm">
                    <T className="text-[12.5px] text-text-primary">{g.sprintName ?? '—'}</T>
                    {g.sprintStatus === 'active' && <Chip tone="success">active</Chip>}
                  </Inline>
                  {g.startsOn && g.endsOn && (
                    <T className="text-[11px] text-text-tertiary mt-0.5 tabular-nums">
                      {g.startsOn} → {g.endsOn}
                    </T>
                  )}
                </Stack>
              </TableTd>
              <TableTd><T className="tabular-nums">{usd(g.allocatedUsd)}</T></TableTd>
              <TableTd>
                <T className="tabular-nums text-text-secondary">{usd(g.initiativeSpendInWindowUsd)}</T>
              </TableTd>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {(hidden > 0 || showAll) && (
        <Stack gap="none" className="px-3.5 py-2.5 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start px-0 py-0 border-0 h-fit w-fit text-[11.5px] text-primary hover:underline"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll
              ? `Show fewer — collapse ${rest.length - CLOSED_PREVIEW} closed ${rest.length - CLOSED_PREVIEW === 1 ? 'sprint' : 'sprints'}`
              : `Show ${hidden} more closed ${hidden === 1 ? 'sprint' : 'sprints'}`}
          </Button>
        </Stack>
      )}
    </Card>
  );
}
