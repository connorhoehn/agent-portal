import { Fragment, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ScopeHeader } from '@connorhoehnslalom/ui-components';
import {
  Button,
  EmptyState,
  LoadingState,
  Stack,
  StatStrip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { UnavailableNotice } from '../components/UnavailableNotice';
import { useCapabilities } from '../lib/capabilities';
import { InitiativesExplorer } from './projects/InitiativesExplorer';
import { useInitiativeListRail } from './projects/InitiativeListRail';
import { InitiativeComposer } from './projects/InitiativeComposer';
import { initiativeBreadcrumbs, initiativeHref } from './projects/initiativeNavigation';
import { ProjectTable } from './projects/ProjectTable';
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
  const [searchParams] = useSearchParams();
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
  const person = useFetch<SessionPerson>(mineEmpty ? '/api/session/person' : null);
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
  const openProject = (p: ProjectSummary) => navigate(initiativeHref(p.id, searchParams, scope));
  const refreshAll = () => { list.list.refresh(); person.refresh(); personDetail.refresh(); };

  const header = (title: string, description: string) => (
    <ScopeHeader
      // v2's type scale (V1): the 22px title and the 15px summary.
      titleSize="md"
      descriptionSize="sm"
      title={title}
      description={description}
      className="border-b border-border"
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
    paneHeader = header(EVERYONE_TITLE, EVERYONE_DESCRIPTION);
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
          <StatStrip
            aria-label="Program rollup"
            items={[
              {
                label: 'Agents active',
                value: totals.agentsActive,
                ...(totals.agentsActive > 0 ? { tone: 'accent' as const } : {}),
                // How many initiatives those runs are spread across — the
                // same number the tile shows, not the in-flight status count.
                hint: totals.agentsActiveInitiatives > 0
                  ? `on ${totals.agentsActiveInitiatives} initiative${totals.agentsActiveInitiatives === 1 ? '' : 's'}`
                  : 'none running',
              },
              {
                label: 'Active initiatives',
                value: totals.inFlight,
                hint: totals.planning > 0 ? `${totals.planning} planning` : `${rows.length} total`,
              },
              {
                label: 'Open work',
                value: totals.openStories + totals.openBugs,
                ...(totals.criticalCount > 0 ? { tone: 'danger' as const } : {}),
                hint: totals.criticalCount > 0
                  ? `${totals.criticalCount} critical`
                  : `${totals.openStories} stories · ${totals.openBugs} bugs`,
              },
              {
                label: 'Delivered',
                value: velocityPct != null ? `${velocityPct}%` : '—',
                hint: totals.pointsTotal > 0 ? `${totals.pointsDone}/${totals.pointsTotal} pts` : 'nothing estimated',
              },
              {
                label: `Spend · ${SPEND_MONTH.split(' ')[0]}`,
                value: usd(totals.spendUsd),
                ...(totals.allocatedUsd > 0 && totals.spendUsd > totals.allocatedUsd ? { tone: 'danger' as const } : {}),
                // "of $431.00 allocated" needed 108px in the 104px cell and was cut with
                // no title; the "of" carried nothing the label does not already say.
                hint: totals.allocatedUsd > 0 ? `${usd(totals.allocatedUsd)} allocated` : 'no allocations',
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
      {...list.slots}
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
    <Stack gap="none" className="pt-9">
      <EmptyState
        align="start"
        size="sm"
        testId="mine-empty"
        title={copy.heading}
        description={<Lines lines={copy.lines} />}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onEveryone}>{copy.primary.label}</Button>
            <Button size="sm" variant="secondary" onClick={onProfile}>{copy.secondary.label}</Button>
          </div>
        )}
      />
      <Stack gap="sm" className="mt-5 border-t border-border pt-5 text-[13px] leading-5 text-text-secondary">
        <h2 className="text-[14px] font-semibold text-text-primary">{copy.details.title}</h2>
        <div><Lines lines={copy.details.lines} /></div>
        <Button size="sm" variant="ghost" className="self-start" onClick={onRefresh}>{copy.details.action.label}</Button>
      </Stack>
    </Stack>
  );
}

export default ProjectsPage;
