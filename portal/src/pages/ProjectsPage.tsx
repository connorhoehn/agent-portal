import { Fragment, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { usePublishPageContext } from '../lib/voice/pageContext';
import { UNDER_CRUMBS_BAND } from '../components/shell/headerRhythm';
import {
  Button,
  EmptyState,
  Inline,
  LoadingState,
  PageHeader,
  SectionLabel,
  Stack,
  StatStrip,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { UnavailableNotice } from '../components/UnavailableNotice';
import { useCapabilities } from '../lib/capabilities';
import { InitiativesExplorer } from './projects/InitiativesExplorer';
import { useInitiativeListRail } from './projects/InitiativeListRail';
import { InitiativeComposer } from './projects/InitiativeComposer';
import { initiativeBreadcrumbs, initiativeHref } from './projects/initiativeNavigation';
import { ProjectTable } from './projects/ProjectTable';
import { BudgetAccessRequest, LockedFigure } from './projects/BudgetAccess';
import { REQUEST_PARAM, REQUEST_PARAM_VALUE, budgetLock } from './projects/budgetAccessModel';
import { SprintsLens, useSprintsLens } from './projects/SprintsLens';
import { MINE_DESCRIPTION, MINE_TITLE, buildMine, type MineEmptyCopy } from './projects/mineModel';
import {
  SPEND_MONTH,
  compareProjects,
  filterByStatus,
  matchesQuery,
  programTotals,
  usd,
} from './projects/projectFormat';
import type { ProjectSummary, SessionPerson } from './projects/types';
import type { PersonDetail } from './project-detail/types';

// /iq/projects — the Initiatives explorer with nothing selected (D4).
//
// The rail is the initiative list (or, on ?lens=sprints, the sprints); the
// pane is the program:
//   Everyone — "All initiatives": the program rollup strip and the table.
//   Mine     — "My initiatives": the table of what lists you, or — when
//              nothing does — WHY (mineModel): your account is not connected
//              to a team profile, or it is and nobody has listed you. The two
//              need different remedies, so the page asks /api/session/person
//              rather than guessing. A failed read is a failure, never
//              "nothing linked".
//   Sprints  — the Sprints lens, unchanged, beside a rail of the same sprints.
// Under all of them, the light Agent composer about the initiatives.

const EVERYONE_TITLE = 'All initiatives';
const EVERYONE_DESCRIPTION = 'Every initiative in the program: its owner, live agents, delivery and spend.';
const SPRINTS_TITLE = 'Sprints';
const SPRINTS_DESCRIPTION = "Each initiative's iterations: their window, progress and envelope.";

function Lines({ lines }: { lines: string[] }) {
  return <>{lines.map((l, i) => <Fragment key={l}>{i > 0 ? <br /> : null}{l}</Fragment>)}</>;
}

function ProjectsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can: canDo, ready: capsReady } = useCapabilities();
  const canIngest = capsReady && canDo('ManageIngest');

  const wantsSprints = searchParams.get('lens') === 'sprints';
  const sprints = useSprintsLens(wantsSprints);
  const list = useInitiativeListRail({
    sprints: {
      data: sprints.data,
      error: sprints.error,
      openId: sprints.openId,
      onOpen: sprints.setOpenId,
    },
  });
  const { scope, setScope, lens } = list;
  const rows = list.list.data;

  // Mine's "why is it empty" — asked only when Mine came back empty.
  const mineEmpty = lens === 'initiatives' && scope === 'mine' && rows != null && rows.length === 0;
  const person = useFetch<SessionPerson>(mineEmpty ? '/api/session/person' : null, undefined, { share: true });
  const linkedId = person.data?.linked ? person.data.personId : null;
  const personDetail = useFetch<PersonDetail>(
    mineEmpty && linkedId ? `/api/graph/people/${encodeURIComponent(linkedId)}` : null,
  );
  const mine = useMemo(() => buildMine({
    list: { data: rows, error: rows ? null : list.list.error },
    person: { data: person.data, error: person.error ?? person.degraded },
    personName: personDetail.data?.name ?? null,
  }), [rows, list.list.error, person.data, person.error, person.degraded, personDetail.data]);

  const visible = useMemo(
    () => filterByStatus(rows ?? [], list.statusFilter)
      .filter((p) => matchesQuery(p, list.query))
      .sort((a, b) => compareProjects(a, b, list.sort) || a.name.localeCompare(b.name)),
    [rows, list.statusFilter, list.query, list.sort],
  );
  const totals = useMemo(() => programTotals(rows ?? []), [rows]);
  // The voice's page context (G21): the initiatives as the table lists them, from this page's own read.
  const { pathname } = useLocation();
  usePublishPageContext(rows ? {
    path: pathname, rowsLabel: 'initiatives', total: rows.length,
    rows: visible.map((p) => ({ ref: `initiative:${p.id}`, title: p.name, status: p.status ?? null, href: `/iq/projects/${encodeURIComponent(p.id)}` })),
  } : null);
  // Below the budgets read tier the server withholds spend and allocation
  // (budgetAccess on each row): the strip and the Spend column show a lock and
  // the header carries the one quick request for the tier. A locked budget
  // answer links here with ?request=budget-access, which opens the form.
  const lock = budgetLock(rows);
  const wantsRequest = searchParams.get(REQUEST_PARAM) === REQUEST_PARAM_VALUE;
  const dropRequestParam = () => {
    if (!wantsRequest) return;
    const next = new URLSearchParams(searchParams);
    next.delete(REQUEST_PARAM);
    setSearchParams(next, { replace: true });
  };
  const openProject = (p: ProjectSummary) => navigate(initiativeHref(p.id, searchParams, scope));
  const refreshAll = () => { list.list.refresh(); person.refresh(); personDetail.refresh(); };

  const header = (title: string, description: string, actions?: ReactNode) => (
    <PageHeader
      title={title}
      description={description}
      {...(actions ? { actions } : {})}
      className={`border-b border-border px-6 pb-3 ${UNDER_CRUMBS_BAND}`}
      data-testid="initiatives-pane-header"
    />
  );

  const failure = (
    <UnavailableNotice
      error={list.list.error ?? ''}
      what="initiatives"
      source="Initiatives are read from the org graph"
      onRetry={list.list.refresh}
    />
  );

  const table = visible.length > 0 ? (
    <ProjectTable projects={visible} onOpen={openProject} hrefOf={(p) => initiativeHref(p.id, searchParams, scope)} />
  ) : (
    <EmptyState
      title="No matching initiatives"
      description="No initiative matches this search or status filter."
      actions={[{ label: 'Clear search and filters', onClick: list.clearFilters }]}
    />
  );

  let paneHeader;
  let body;

  if (lens === 'sprints') {
    paneHeader = header(SPRINTS_TITLE, SPRINTS_DESCRIPTION);
    body = <SprintsLens view="list" lens={sprints} />;
  } else if (scope === 'mine') {
    paneHeader = header(MINE_TITLE, MINE_DESCRIPTION);
    if (mine.state === 'loading') body = <LoadingState label="Loading your initiatives…" />;
    else if (mine.state === 'error') {
      body = mine.failed === 'initiatives' ? failure : (
        <UnavailableNotice
          error={mine.error}
          what="your profile connection"
          source="Whether your account is connected to a team profile is read from Identity"
          onRetry={person.refresh}
        />
      );
    } else if (mine.state === 'has-rows') body = table;
    else body = <MineEmpty copy={mine.copy} onEveryone={() => setScope('all')} onProfile={() => navigate(mine.copy.secondary.href)} onRefresh={refreshAll} />;
  } else {
    paneHeader = header(EVERYONE_TITLE, EVERYONE_DESCRIPTION,
      lock ? <BudgetAccessRequest lock={lock} autoOpen={wantsRequest} onClosed={dropRequestParam} /> : undefined);
    if (rows == null) body = list.list.error ? failure : <LoadingState label="Loading initiatives…" />;
    else if (rows.length === 0) {
      body = (
        <EmptyState
          align="start"
          title="No initiatives yet"
          description={canIngest
            ? 'An initiative is a program with an owner, epics, stories and a budget. Nothing creates one by hand: they are built by the graph-builder agent from documents you ingest, so the way to fill this page is to point Ingestion at a source and run it.'
            : 'An initiative is a program with an owner, epics, stories and a budget. Nothing creates one by hand: they are built by the graph-builder agent from documents someone ingests. Running ingestion needs the ManageIngest capability, which an HR admin holds — this page fills itself once they have pointed it at a source.'}
        />
      );
    } else {
      const velocityPct = totals.pointsTotal > 0 ? Math.round((totals.pointsDone / totals.pointsTotal) * 100) : null;
      body = (
        <Stack gap="md">
          {/* One line of prose stats, as the initiative detail page draws
              them: the KPI-card strip gave each cluster ~140px of the 708px
              pane at 1440px and cut "$431.00 allocated" to 51px. The line
              wraps between clusters, never inside one. */}
          <StatStrip
            variant="line"
            aria-label="Program rollup"
            items={[
              {
                // How many initiatives those runs are spread across — the
                // same number the value counts, not the in-flight status count.
                label: `agent${totals.agentsActive === 1 ? '' : 's'} active${totals.agentsActiveInitiatives > 0
                  ? ` on ${totals.agentsActiveInitiatives} initiative${totals.agentsActiveInitiatives === 1 ? '' : 's'}`
                  : ''}`,
                value: totals.agentsActive,
                ...(totals.agentsActive > 0 ? { tone: 'accent' as const } : {}),
              },
              {
                label: `active initiative${totals.inFlight === 1 ? '' : 's'}${totals.planning > 0 ? ` · ${totals.planning} planning` : ` of ${rows.length}`}`,
                value: totals.inFlight,
              },
              {
                label: totals.criticalCount > 0
                  ? `open items · ${totals.criticalCount} critical`
                  : `open items · ${totals.openStories} stories, ${totals.openBugs} bugs`,
                value: totals.openStories + totals.openBugs,
                ...(totals.criticalCount > 0 ? { tone: 'danger' as const } : {}),
              },
              {
                label: totals.pointsTotal > 0 ? `delivered · ${totals.pointsDone}/${totals.pointsTotal} pts` : 'delivered · nothing estimated',
                value: velocityPct != null ? `${velocityPct}%` : '—',
              },
              lock ? {
                // Withheld by the server below the budgets read tier: no sum of absent figures.
                label: `spent in ${SPEND_MONTH.split(' ')[0]} · budget figures locked`,
                value: <LockedFigure lock={lock} testId="spend-strip-locked" />,
                title: lock.reason,
              } : {
                label: `spent in ${SPEND_MONTH.split(' ')[0]}${totals.allocatedUsd > 0 ? ` of ${usd(totals.allocatedUsd)} allocated` : ' · no allocations'}`,
                value: usd(totals.spendUsd),
                ...(totals.allocatedUsd > 0 && totals.spendUsd > totals.allocatedUsd ? { tone: 'danger' as const } : {}),
              },
            ]}
          />
          {table}
        </Stack>
      );
    }
  }

  return (
    <InitiativesExplorer
      rail={list.rail}
      scope={list.scope}
      lens={list.lens}
      collapsible
      breadcrumbs={initiativeBreadcrumbs({
        search: searchParams, scope, sprints: lens === 'sprints',
        sprint: lens === 'sprints' ? sprints.data?.sprints.find((s) => s.id === sprints.openId)?.name : undefined,
      })}
      paneHeader={paneHeader}
      composer={<InitiativeComposer subject={{ kind: 'initiatives', rows }} />}
      data-testid="initiatives-page"
    >
      <Stack gap="md" className="px-6 py-5">{body}</Stack>
    </InitiativesExplorer>
  );
}

/** Mine with nothing in it (mockup variant 3): what is true, two ways forward,
 *  and how the view decides — left-aligned at the top of the pane. */
function MineEmpty({
  copy, onEveryone, onProfile, onRefresh,
}: {
  copy: MineEmptyCopy;
  onEveryone: () => void;
  onProfile: () => void;
  onRefresh: () => void;
}) {
  return (
    <Stack gap="none">
      <EmptyState
        align="start"
        testId="mine-empty"
        title={copy.heading}
        description={<Lines lines={copy.lines} />}
        action={(
          <Inline gap="sm">
            <Button size="sm" onClick={onEveryone}>{copy.primary.label}</Button>
            <Button size="sm" variant="secondary" onClick={onProfile}>{copy.secondary.label}</Button>
          </Inline>
        )}
      />
      <Stack gap="sm" className="mt-5 border-t border-border pt-5 text-sm leading-5 text-text-secondary">
        <SectionLabel as="h2" case="sentence" className="text-sm font-semibold">{copy.details.title}</SectionLabel>
        <div><Lines lines={copy.details.lines} /></div>
        <Button size="sm" variant="ghost" className="self-start" onClick={onRefresh}>{copy.details.action.label}</Button>
      </Stack>
    </Stack>
  );
}

export default ProjectsPage;
