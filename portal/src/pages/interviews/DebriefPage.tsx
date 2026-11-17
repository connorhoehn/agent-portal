// /interviews/candidates/:id/debrief — a candidate's rounds side by side and the stage decision (docs/interviews-tenant-
// plan.md decisions 6, 14, 15; rows I5.4, I5.5; contract E4). The recruiter, the hiring manager of the opening and the
// admin read it (an interviewer gets the usual not-found); the recruiter sees submissions here as they arrive.
//
// "Rounds" first: per round one table, a row per competency and a column per scorecard, then the recommendation and the
// summary; who is still due; Milo's recap read in place (contract E3) in a disclosure; the round's record (E2) one click
// away. Nothing is averaged, totalled or ranked (decision 6): the page shows what people wrote. "Stage history" lists
// every move with who made it and why, each decision with what was missing when it was made.
//
// The hiring manager's decision waits in the footer's prompt deck: the three choices, then the reason, then one
// confirmation that it is recorded under their name (asked once more when a scorecard is still due). The recruiter and
// the admin read the same page without it.
//
// /interviews/rounds/:id/debrief (DebriefFromRound) is where the bells lead: they carry a round, never a candidate, and
// this resolves the round to its candidate's debrief.

import {
  Button, Chip, DataTable, DetailPage, DetailSection, Disclosure, Inline, LoadingState, MetaLine, Stack, T, type DataTableColumn, type DataTableColumnGroup,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { FlushDetailFrame, useFlushTrailItems } from '../../components/shell/FlushPage';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { INTERVIEWS_API, RECOMMENDATION_LABELS, ROUND_TYPE_LABELS, STAGE_LABELS, recommendationTone, roundStatus, type InterviewRow } from '../../lib/interviews';
import {
  DECISION_CHOICES, DECISION_DONE, confirmQuestion, debriefApi, debriefHref, decideStage, decisionTone, dueLine, missingLine, reasonProblem, recapLine,
  roundEmptyLine, scorecardNotes, applicationSideBySide,
  type DebriefApplication, type DebriefMove, type DebriefRound, type DebriefView, type Decision, type RecapBody, type SideCell, type SideRow,
} from '../../lib/interviewsDebrief';
import { plural } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import { Dash, PanelCell, StageChip } from './interviewsCells';

export default function DebriefPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const trail = useFlushTrailItems();
  const { data, error, failure, refresh } = useFetch<{ debrief: DebriefView }>(id ? debriefApi(id) : null);
  const view = data?.debrief ?? null;
  useCrumbLabel(id, view?.candidate.name);
  if (failure?.status === 404) {
    return <RecordNotFound heading="Debrief" title="Debrief not found" body="There is no candidate here whose debrief you can open." backLabel="Home" onBack={() => navigate('/interviews')} />;
  }
  if (error && !view) return <UnavailableNotice error={error} what="this debrief" source="Debriefs are read from the interviews tenant" onRetry={refresh} />;
  if (!view) return <FlushDetailFrame><DetailPage title="Debrief" breadcrumbs={trail}><T size="sm" tone="tertiary">Loading the debrief…</T></DetailPage></FlushDetailFrame>;
  return <FlushDetailFrame><DebriefWorkspace view={view} trail={trail} onChanged={refresh} /></FlushDetailFrame>;
}

/** Where a bell leads: the round's candidate's debrief, for whoever may read it. */
export function DebriefFromRound() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, refresh } = useFetch<{ interview: InterviewRow }>(id ? `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}` : null);
  if (data?.interview) return <Navigate to={debriefHref(data.interview.candidate.id)} replace />;
  if (error) {
    return /404|not found/i.test(error)
      ? <RecordNotFound heading="Debrief" title="Debrief not found" body="There is no round here whose debrief you can open." backLabel="Home" onBack={() => navigate('/interviews')} />
      : <UnavailableNotice error={error} what="this debrief" source="Debriefs are read from the interviews tenant" onRetry={refresh} />;
  }
  return <LoadingState label="Opening the debrief…" />;
}

type Trail = ReturnType<typeof useFlushTrailItems>;

function DebriefWorkspace({ view, trail, onChanged }: { view: DebriefView; trail: Trail; onChanged: () => void }) {
  const { session } = useSession();
  const [asked, setAsked] = useState(0);
  const several = view.applications.length > 1;
  const first = view.applications[0]!;

  const prompts = useMemo<ComposerPrompt[]>(() => view.applications.flatMap((a) => {
    const decide = a.decide;
    if (!decide || !decide.options.some((o) => o.allowed)) return [];
    const scope = `interviews-debrief:${a.applicationId}`;
    const title = `${view.candidate.name}, ${a.opening.title}`;
    const base = `${scope}:${a.basedOn}:${asked}`;
    const confirm = (decision: Decision, reason: string): ComposerPrompt => ({
      id: `${base}:confirm:${decision}`, scope, eyebrow: 'Record the decision', title, kind: 'choice',
      fields: [{ label: 'Decision', value: DECISION_CHOICES[decision] }, { label: 'Reason', value: reason }],
      question: confirmQuestion(decide, decision, session?.name ?? 'you'),
      options: [{ id: 'record', label: 'Record it', emphasis: 'primary' }, { id: 'back', label: 'Not yet' }],
      onAnswer: async (ans) => {
        if (!('optionId' in ans) || ans.optionId !== 'record') { setAsked((n) => n + 1); return { receipt: 'Nothing was recorded.' }; }
        const out = await decideStage(a.applicationId, { decision, reason, basedOn: a.basedOn });
        if (!out.ok) {
          if (out.stale) onChanged();
          return { error: out.error };
        }
        onChanged();
        return { receipt: 'Recorded under your name. The recruiter has been told.' };
      },
    });
    const reasonFor = (decision: Decision): ComposerPrompt => ({
      id: `${base}:reason:${decision}`, scope, eyebrow: DECISION_CHOICES[decision], title, kind: 'text',
      question: 'Why? Your reason is recorded with the decision and read by the recruiter.',
      placeholder: 'Your reason, in a sentence or two',
      onAnswer: async (ans) => {
        const reason = ans.kind === 'text' ? ans.text.trim() : '';
        const problem = reasonProblem(reason, decide.limits);
        return problem ? { error: problem } : { next: confirm(decision, reason) };
      },
    });
    return [{
      id: `${base}:choose`, scope, eyebrow: 'Your decision', title, kind: 'choice',
      fields: [{ label: 'Stage', value: STAGE_LABELS[a.stage] }, ...(decide.scorecardsMissing ? [{ label: 'Still due', value: plural(decide.scorecardsMissing, 'scorecard') }] : [])],
      question: 'What happens next for this candidate? You choose, then say why.',
      options: decide.options.map((o) => ({ id: o.decision, label: DECISION_CHOICES[o.decision], ...(o.allowed ? {} : { disabledReason: o.refusal ?? undefined }) })),
      onAnswer: async (ans) => {
        const picked = 'optionId' in ans ? decide.options.find((o) => o.decision === ans.optionId && o.allowed) : undefined;
        return picked ? { next: reasonFor(picked.decision) } : { error: 'Choose one of the three.' };
      },
    }];
  }), [view, asked, session?.name, onChanged]);

  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'debrief' }, {
    id: 'interviews-debrief-commands', label: 'Debrief', placeholder: 'Refresh this debrief…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: onChanged,
    scopeNote: 'Refresh reloads the scorecards as they now stand. A decision is asked here and never made by a typed command.',
  }), [onChanged]);

  const rounds = view.applications.flatMap((a) => a.rounds);
  const inCount = rounds.reduce((n, r) => n + r.scorecards.length, 0);
  return (
    <>
      <DetailPage data-testid="interviews-debrief" title={`${view.candidate.name}: debrief`} breadcrumbs={trail}
        badge={several ? undefined : <StageChip stage={first.stage} />}
        meta={<MetaLine size="sm" items={[
          view.candidate.headline,
          view.applications.map((a) => a.opening.title).join(' · '),
          `${plural(inCount, 'scorecard')} in on ${plural(rounds.length, 'round')}`,
        ]} />}
        tabs={[
          { id: 'rounds', label: 'Rounds', badge: rounds.length || undefined, testId: 'interviews-debrief-tab-rounds',
            content: <Stack gap="lg">{view.applications.map((a) => <ApplicationRounds key={a.applicationId} app={a} several={several} />)}</Stack> },
          { id: 'history', label: 'Stage history', testId: 'interviews-debrief-tab-history',
            content: <Stack gap="lg">{view.applications.map((a) => <StageHistory key={a.applicationId} app={a} several={several} />)}</Stack> },
        ]} />
      <CollectionCommandHost adapter={adapter} prompts={prompts} />
    </>
  );
}

function ApplicationRounds({ app, several }: { app: DebriefApplication; several: boolean }) {
  const blocked = app.decide && !app.decide.options.some((o) => o.allowed)
    ? app.decide.options.find((o) => o.decision === 'reject')?.refusal ?? null : null;
  const { columns, rows } = applicationSideBySide(app.rounds, app.competencies);
  // One group per round (its header the round's name); each column is one interviewer's scorecard under it.
  const columnGroups: DataTableColumnGroup[] = [];
  for (const c of columns) if (!columnGroups.some((g) => g.key === c.roundId)) columnGroups.push({ key: c.roundId, header: c.roundName });
  const tableColumns: DataTableColumn<SideRow>[] = [
    { key: 'label', header: 'Competency', width: '176px', render: (r) => <T size="sm" weight="medium" data-testid="interviews-debrief-row">{r.label}</T> },
    ...columns.map((c): DataTableColumn<SideRow> => ({
      key: c.id, width: '300px', minWidth: '240px', group: c.roundId,
      header: c.version > 1 ? `${c.interviewer.name} (version ${c.version})` : c.interviewer.name,
      render: (r) => <SideCellView cell={r.cells[c.id] ?? { kind: 'none' }} />,
    })),
  ];
  const body = (
    <Stack gap="md" data-testid="interviews-debrief-application">
      {app.decide && (
        <T size="sm" tone="secondary" data-testid="interviews-debrief-decide-line">
          {blocked ?? [missingLine(app.decide.scorecardsMissing, 'now'), 'Your decision waits in the box at the bottom of the page.'].filter(Boolean).join('. ')}
        </T>
      )}
      {app.rounds.length === 0 && <T size="sm" tone="secondary">No round has been assigned yet.</T>}
      {columns.length > 0 && (
        <DataTable rowHeight="content" stickyFirstColumn columnGroups={columnGroups} data-testid="interviews-debrief-side-by-side" aria-label={`${app.opening.title}: scorecards side by side`} data={rows} columns={tableColumns}
          keyField={(r) => r.id} staticRows="Each competency as each interviewer rated it, read in place" />
      )}
      {app.rounds.map((r) => <RoundBlock key={r.interviewId} round={r} />)}
    </Stack>
  );
  return several
    ? <DetailSection variant="heading" title={app.opening.title} hint={STAGE_LABELS[app.stage]} actions={<StageChip stage={app.stage} />}>{body}</DetailSection>
    : body;
}

/** What the table does not say about one round: when it was, who sat on it, who is still due, and Milo's recap under it. */
function RoundBlock({ round }: { round: DebriefRound }) {
  const navigate = useNavigate();
  const status = roundStatus(round.state);
  const empty = roundEmptyLine(round);
  const due = dueLine(round);
  const notes = round.scorecards.flatMap(scorecardNotes);
  return (
    <DetailSection variant="heading" title={round.name} data-testid="interviews-debrief-round"
      hint={<MetaLine size="sm" items={[
        `${ROUND_TYPE_LABELS[round.type]}, ${round.minutes} minutes`,
        round.endedAt ? `Ended ${relativeTime(round.endedAt)}` : round.scheduledAt ? `Set for ${new Date(round.scheduledAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'No time set',
      ]} />}
      actions={(
        <Inline gap="sm" align="center" wrap={false}>
          <PanelCell lead={round.lead} panel={round.panel} />
          <Chip tone={status.tone} size="xs">{status.label}</Chip>
          {round.recordPath && (
            <Button size="sm" variant="ghost" data-testid="interviews-debrief-record" onClick={() => navigate(round.recordPath!)}>Open the record</Button>
          )}
        </Inline>
      )}>
      <Stack gap="sm">
        {empty && <T size="sm" tone="secondary" data-testid="interviews-debrief-round-empty">{empty}</T>}
        {due && <T size="sm" tone="secondary" data-testid="interviews-debrief-due">{due}</T>}
        {notes.map((n) => <T key={n} size="xs" tone="secondary" data-testid="interviews-debrief-note">{n}</T>)}
        {round.recapPath && <RecapInPlace path={round.recapPath} />}
      </Stack>
    </DetailSection>
  );
}

function SideCellView({ cell }: { cell: SideCell }) {
  switch (cell.kind) {
    case 'rating':
      return (
        <Stack gap="xs">
          <Inline gap="xs" align="start" wrap={false}>
            <Chip size="xs" tone="neutral">{`${cell.rating} of 4`}</Chip>
            <T size="sm">{cell.anchor}</T>
          </Inline>
          {cell.note && <T size="sm" tone="secondary">{cell.note}</T>}
        </Stack>
      );
    case 'recommendation':
      return <Chip size="xs" tone={recommendationTone(cell.recommendation)}>{RECOMMENDATION_LABELS[cell.recommendation]}</Chip>;
    case 'summary':
      return <T size="sm">{cell.text}</T>;
    default:
      return <Dash />;
  }
}

/** Milo's recap of the round (contract E3), read only once it is opened. */
function RecapInPlace({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, failure, refresh } = useFetch<{ recap: RecapBody }>(open ? path : null);
  const recap = data?.recap ?? null;
  const line = recap ? recapLine(recap) : null;
  return (
    <Disclosure summary="Milo's recap: what was said, by competency" open={open} onToggle={setOpen} density="compact" data-testid="interviews-debrief-recap">
      {failure?.status === 404 ? <T size="sm" tone="secondary" data-testid="interviews-debrief-recap-unavailable">Milo's recap is not available for this round.</T>
        : error && !recap ? <UnavailableNotice error={error} what="the recap" source="Recaps are read from the interviews tenant" onRetry={refresh} />
          : !recap ? <T size="sm" tone="tertiary">Loading the recap…</T>
            : (
              <Stack gap="sm">
                {line && <T size="sm" tone="secondary">{line}</T>}
                {recap.competencies.filter((c) => c.evidence.length).map((c) => (
                  <Stack key={c.id} gap="xs">
                    <T size="sm" weight="medium">{c.name}</T>
                    {c.evidence.map((e) => (
                      <Stack key={`${e.source.seq}:${e.text}`} gap="none">
                        <T size="sm">{e.text}</T>
                        <T size="xs" tone="tertiary">{`“${e.source.quote}”`}</T>
                      </Stack>
                    ))}
                  </Stack>
                ))}
                {recap.notCovered.length > 0 && <T size="sm" tone="secondary">{`Not covered: ${recap.notCovered.map((c) => c.name).join(', ')}.`}</T>}
              </Stack>
            )}
    </Disclosure>
  );
}

const MOVE_COLUMNS: DataTableColumn<DebriefMove>[] = [
  { key: 'stage', header: 'Stage', width: '176px', render: (m) => <StageChip stage={m.stage} /> },
  { key: 'at', header: 'When', numeric: true, width: '144px', render: (m) => <T size="sm" title={new Date(m.at).toLocaleString()}>{relativeTime(m.at)}</T> },
  { key: 'by', header: 'By', render: (m) => (m.byName ? <T size="sm">{m.byName}</T> : <T size="sm" tone="secondary">The candidate</T>) },
  {
    key: 'decision', header: 'Decision', width: '176px',
    render: (m) => (m.decision ? <Chip size="xs" tone={decisionTone(m.decision)}>{DECISION_DONE[m.decision]}</Chip> : <Dash />),
  },
  {
    key: 'reason', header: 'Why',
    render: (m) => {
      const missing = missingLine(m.scorecardsMissing);
      if (!m.reason && !missing) return <Dash />;
      return <T size="sm" tone="secondary">{[m.reason, missing && `Decided while ${missing}.`].filter(Boolean).join(' ')}</T>;
    },
  },
];

function StageHistory({ app, several }: { app: DebriefApplication; several: boolean }) {
  const moves = [...app.history].reverse();
  return (
    <DetailSection variant="heading" first title={several ? `Stage history, ${app.opening.title}` : 'Stage history'} hint={plural(moves.length, 'move')}>
      <DataTable narrow data-testid="interviews-debrief-history" aria-label="Stage history" data={moves} columns={MOVE_COLUMNS}
        keyField={(m) => `${m.stage}:${m.at}`} staticRows="Each move between stages, newest first, read in place" emptyMessage="No stage changes yet." />
    </DetailSection>
  );
}
