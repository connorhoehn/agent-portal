// /iq/runs/:id — one run, whichever executor ran it (docs/learning-loop-design.md "Pages"; lane E1).
// Four sections from the run's own records: Brief (the frozen text the run was given), Report (what it
// handed back), Runbooks (what it was given and what it said of each) and Learned (the proposal it
// produced, or why there was no debrief). A run the façade projects with steps adds a fifth, Steps.
// The id is a run ref (a local job's id, a bot run's job) or the façade's `job:<ref>`.
//
// Reads: GET /api/runs/:ref/report, GET /api/runs/:ref/brief, and the façade's run and steps
// (GET /api/runs/:id, /steps). A run with no report yet says so; a run whose report block was missing
// or unreadable says it did not report. Mock runs carry `simulated` and show "Demo data".

import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import {
  Banner, Button, Chip, DataTable, DetailPage, DetailSection, EmptyState, Inline, KeyValue, LoadingState, MetaLine, Stack, T,
  type DataTableColumn, type DetailPageTab,
} from '@connorhoehn/ui-components/shared';
import { ReadOnlyDocument } from '../../components/documents/ReadOnlyDocument';
import { PipelineRunEvents, PipelineRunSteps, usePipelineRun } from '../../components/runs/PipelineRunParts';
import { isNotFoundError } from '../../components/notFound';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { usd } from '../../lib/format';
import { relativeTime } from '../../lib/relativeTime';
import { RecordLink } from '../decisions/RecordLink';
import { briefReadingMarkdown } from '../runbooks/runbookTitles';
import type { Brief, BriefOffer } from '../runbooks/types';
import { useRunbookNames } from '../runbooks/useRunbookNames';
import type { Names } from '../runbooks/runbookNames';
import {
  EXECUTOR_WORD, OUTCOME_LABEL, OUTCOME_TONE, costWords, didNotReport, facadeIdOf, failureWords, isSimulated, runRefOf, stepDetail, stepWords, whoRan,
  type RunReportRow,
} from './runsModel';

const DEMO_SENTENCE = 'This run was simulated. Its report, and any runbook it filed, are hand-written demo data.';

export default function RunPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const ref = runRefOf(id);
  const facadeId = id ? facadeIdOf(id) : null;
  const names = useRunbookNames();
  const reportFeed = useFetch<{ report: RunReportRow }>(ref ? `/api/runs/${encodeURIComponent(ref)}/report` : null, 0);
  const briefFeed = useFetch<{ brief: Brief }>(ref ? `/api/runs/${encodeURIComponent(ref)}/brief` : null, 0);
  const facade = usePipelineRun('/api/runs', facadeId);
  const report = reportFeed.data?.report ?? null;
  const title = facade.run?.context.title ?? 'Run';
  useCrumbLabel(id, facade.run?.context.title);

  if (!id) return <LoadingState label="Loading run…" />;
  const waiting = (ref !== null && reportFeed.isLoading && !reportFeed.data && !reportFeed.error) || (facade.loading && !facade.run && !facade.error);
  if (waiting) return <LoadingState label="Loading run…" />;
  const nothing = !report && !facade.run;
  if (nothing) {
    const missing = isNotFoundError(reportFeed.error) || isNotFoundError(facade.error) || reportFeed.error === null;
    return (
      <DetailPage title="Run" gutter="page" data-testid="run-page-missing">
        {missing
          ? <EmptyState align="start" title="Run not found" description="No run with this reference. It may have been pruned, or belong to another workspace." />
          : <UnavailableNotice error={reportFeed.error ?? facade.error ?? ''} what="this run" source="Runs are read from the run reports and the job queue" onRetry={() => { reportFeed.refresh(); facade.refresh(); }} />}
      </DetailPage>
    );
  }

  const hasSteps = facade.steps.length > 0;
  const tab = params.get('tab') ?? 'report';
  const setTab = (next: string) => setParams((prev) => { const p = new URLSearchParams(prev); if (next === 'report') p.delete('tab'); else p.set('tab', next); return p; }, { replace: true });
  const simulated = report ? isSimulated(report) : false;
  const botName = facade.run?.context.kind === 'bot' ? facade.run.context.title : null;
  const tabs: DetailPageTab[] = [
    { id: 'brief', label: 'Brief', testId: 'run-tab-brief', content: <BriefSection feed={briefFeed} /> },
    { id: 'report', label: 'Report', testId: 'run-tab-report', content: <ReportSection report={report} missing={reportFeed.error} who={report ? whoRan(report.executor, botName) : null} onRetry={reportFeed.refresh} /> },
    { id: 'runbooks', label: 'Runbooks', testId: 'run-tab-runbooks', content: <RunbooksSection report={report} offer={briefFeed.data?.brief.offer ?? null} names={names} /> },
    { id: 'learned', label: 'Learned', testId: 'run-tab-learned', content: <LearnedSection report={report} names={names} simulated={simulated} /> },
    ...(hasSteps ? [{ id: 'steps', label: 'Steps', testId: 'run-tab-steps', content: <StepsSection steps={facade.steps} eventsUrl={facade.eventsUrl} /> }] : []),
  ];

  return (
    <DetailPage
      title={title}
      gutter="page"
      data-testid="run-page"
      badge={report ? (
        <Inline gap="xs" align="center" wrap>
          <Chip tone={OUTCOME_TONE[report.outcome]} size="xs" data-testid="run-outcome">{OUTCOME_LABEL[report.outcome]}</Chip>
          {simulated && <Chip tone="neutral" size="xs" data-testid="run-demo-data">Demo data</Chip>}
        </Inline>
      ) : undefined}
      meta={report ? <MetaLine size="xs" tone="tertiary" items={[
        whoRan(report.executor, botName),
        names.initiative(report.initiativeId),
        `ended ${relativeTime(report.endedAt)}`,
      ]} /> : undefined}
      tabs={tabs}
      tabsLabel="Run sections"
      activeTab={tabs.some((t) => t.id === tab) ? tab : 'report'}
      onTabChange={setTab}
    />
  );
}

// ── Brief ────────────────────────────────────────────────────────────────────

function BriefSection({ feed }: { feed: ReturnType<typeof useFetch<{ brief: Brief }>> }) {
  const [copied, setCopied] = useState(false);
  if (feed.error && /no brief|404|NO_BRIEF/i.test(feed.error)) {
    return <EmptyState align="start" title="No brief was frozen for this run" description="Runs that started before briefs existed were given none." data-testid="run-brief-none" />;
  }
  if (feed.error) return <UnavailableNotice error={feed.error} what="this run's brief" source="Briefs are read from the runbook store" onRetry={feed.refresh} />;
  if (!feed.data) return <LoadingState label="Loading brief…" />;
  const { brief } = feed.data;
  return (
    <Stack gap="sm" className="h-[70vh] min-h-96" data-testid="run-brief">
      <Inline justify="between" align="center" gap="md" wrap>
        <T size="xs" tone="secondary">{`The text this run was given · ${brief.used_tokens.toLocaleString('en-US')} of ${brief.budget_tokens.toLocaleString('en-US')} tokens · saved ${relativeTime(brief.assembled_at)}`}</T>
        <Button size="sm" variant="secondary" data-testid="run-brief-copy"
          onClick={() => { void navigator.clipboard?.writeText(brief.markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined); }}>
          {copied ? 'Copied' : 'Copy markdown'}
        </Button>
      </Inline>
      <ReadOnlyDocument markdown={briefReadingMarkdown(brief.markdown)} testId="run-brief-document" />
    </Stack>
  );
}

// ── Report ───────────────────────────────────────────────────────────────────

const FILE_COLUMNS: DataTableColumn<RunReportRow['changes']['files'][number]>[] = [
  { key: 'path', header: 'File', render: (f) => <T size="sm" className="break-all">{f.path}</T> },
  { key: 'added', header: 'Added', numeric: true, render: (f) => (f.added == null ? '—' : `+${f.added}`) },
  { key: 'removed', header: 'Removed', numeric: true, render: (f) => (f.removed == null ? '—' : `−${f.removed}`) },
];
const CHECK_COLUMNS: DataTableColumn<RunReportRow['verification'][number]>[] = [
  { key: 'command', header: 'Check', render: (v) => <T size="sm" className="break-all">{v.command}</T> },
  { key: 'passed', header: 'Result', width: '96px', render: (v) => <Chip tone={v.passed ? 'success' : 'danger'} size="xs">{v.passed ? 'Passed' : 'Failed'}</Chip> },
];
const OBSTACLE_COLUMNS: DataTableColumn<{ text: string }>[] = [
  { key: 'text', header: 'What got in the way', render: (o) => <T size="sm" wrap>{o.text}</T> },
];

function ReportSection({ report, missing, who, onRetry }: { report: RunReportRow | null; missing: string | null; who: string | null; onRetry: () => void }) {
  if (!report) {
    return isNotFoundError(missing) || !missing
      ? <EmptyState align="start" title="This run has not reported" description="It is still running, or it ended before reports existed." data-testid="run-report-none" />
      : <UnavailableNotice error={missing} what="this run's report" source="Reports are read from the run report store" onRetry={onRetry} />;
  }
  const noReport = didNotReport(report);
  const why = failureWords(report.failureCode);
  return (
    <Stack gap="md" data-testid="run-report">
      {noReport && <Banner variant="warning" layout="callout" data-testid="run-did-not-report">{noReport}</Banner>}
      {report.summary && (
        <DetailSection as="h2" first title="Summary" data-testid="run-summary"><T size="sm" wrap>{report.summary}</T></DetailSection>
      )}
      <DetailSection as="h2" first={!report.summary} title="The run">
        <KeyValue layout="grid" aria-label="Run facts" items={[
          { label: 'Outcome', value: OUTCOME_LABEL[report.outcome] },
          ...(why ? [{ label: 'Why it stopped', value: why }] : []),
          { label: 'Ran on', value: who ?? EXECUTOR_WORD[report.executor] },
          { label: 'Ended', value: relativeTime(report.endedAt) },
          { label: 'Cost', value: costWords(report.cost, (n) => usd(n, { precision: 4 })), muted: report.cost.basis === 'unknown' },
        ]} />
      </DetailSection>
      {report.changes.files.length > 0 && (
        <DetailSection as="h2" title="Changed files" hint={`${report.changes.files.length}`} data-testid="run-changes">
          <DataTable narrow data={report.changes.files} columns={FILE_COLUMNS} keyField={(f) => f.path} staticRows="The files this run changed." />
        </DetailSection>
      )}
      {report.verification.length > 0 && (
        <DetailSection as="h2" title="Verification" hint={`${report.verification.length}`} data-testid="run-verification">
          <DataTable narrow data={report.verification} columns={CHECK_COLUMNS} keyField={(v) => v.command} staticRows="The checks this run said it ran." />
        </DetailSection>
      )}
      {report.obstacles.length > 0 && (
        <DetailSection as="h2" title="Obstacles" hint={`${report.obstacles.length}`} data-testid="run-obstacles">
          <DataTable narrow data={report.obstacles.map((text) => ({ text }))} columns={OBSTACLE_COLUMNS} keyField={(o) => o.text} staticRows="What got in the way, as the run wrote it." />
        </DetailSection>
      )}
    </Stack>
  );
}

// ── Runbooks ─────────────────────────────────────────────────────────────────

interface RunbookRow { id: string; title: string; reason: string | null; said: string; wrongStep: string; note: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }

export function runbookRows(report: RunReportRow, offer: BriefOffer | null, names: Pick<Names, 'runbook'>): RunbookRow[] {
  const accounts = new Map((report.runbookAccounts ?? []).map((a) => [a.id, a]));
  const loaded = new Set(report.runbooksUsed.map((u) => u.id));
  return report.runbooksOffered.map((o) => {
    const given = offer?.runbooks.find((r) => r.id === o.id);
    const acct = accounts.get(o.id);
    const said = acct ? { yes: 'Followed it', partly: 'Followed it in part', no: 'Did not follow it' }[acct.followed] : loaded.has(o.id) ? 'Loaded, not reported' : 'Not said';
    const tone = acct ? { yes: 'success', partly: 'warning', no: 'danger' }[acct.followed] as RunbookRow['tone'] : 'neutral';
    return {
      id: o.id, title: given?.title ?? names.runbook(o.id), reason: given?.reason ?? null,
      said, tone, wrongStep: acct?.wrongStep != null ? `Step ${acct.wrongStep}` : '—', note: acct?.note ?? '—',
    };
  });
}

function RunbooksSection({ report, offer, names }: { report: RunReportRow | null; offer: BriefOffer | null; names: Names }) {
  if (!report) return <EmptyState align="start" title="Nothing to show yet" description="This run has not reported." />;
  const rows = runbookRows(report, offer, names);
  if (rows.length === 0) {
    return (
      <EmptyState align="start" title="This run was given no runbook" data-testid="run-runbooks-none"
        description={offer?.none_reason ?? 'Nothing in the library matched this work.'} />
    );
  }
  const columns: DataTableColumn<RunbookRow>[] = [
    { key: 'title', header: 'Runbook', render: (r) => <RecordLink to={`/iq/runbooks/${encodeURIComponent(r.id)}`}><T size="sm">{r.title}</T></RecordLink> },
    { key: 'reason', header: 'Why it was given', render: (r) => <T size="sm" tone={r.reason ? 'primary' : 'tertiary'} className="block max-w-[26rem] whitespace-normal">{r.reason ?? '—'}</T> },
    { key: 'said', header: 'What the run said', width: '176px', render: (r) => <Chip tone={r.tone} size="xs">{r.said}</Chip> },
    { key: 'note', header: 'Step it had wrong, and a note', render: (r) => <T size="sm" className="block max-w-[22rem] whitespace-normal">{[r.wrongStep, r.note].filter((x) => x !== '—').join(' · ') || '—'}</T> },
  ];
  return (
    <Stack gap="sm" data-testid="run-runbooks">
      <DataTable narrow data={rows} columns={columns} keyField={(r) => r.id} staticRows="The runbooks this run was given, and what it said of each." />
    </Stack>
  );
}

// ── Learned ──────────────────────────────────────────────────────────────────

const LINT_COLUMNS: DataTableColumn<NonNullable<RunReportRow['debrief']>['lint'][number]>[] = [
  { key: 'rule', header: 'Rule', render: (l) => l.rule },
  { key: 'path', header: 'Where', render: (l) => <T size="sm" className="break-all">{l.path}</T> },
  { key: 'message', header: 'What is wrong', render: (l) => <T size="sm" wrap>{l.message}</T> },
];

function LearnedSection({ report, names, simulated }: { report: RunReportRow | null; names: Names; simulated: boolean }) {
  if (!report) return <EmptyState align="start" title="Nothing to show yet" description="This run has not reported." />;
  const d = report.debrief ?? null;
  const learned = report.learned?.trim() ?? '';
  return (
    <Stack gap="md" data-testid="run-learned">
      {simulated && <Banner variant="info" layout="callout" data-testid="run-learned-demo"><Inline gap="sm" align="center" wrap><Chip tone="neutral" size="xs">Demo data</Chip><T size="sm">{DEMO_SENTENCE}</T></Inline></Banner>}
      <DetailSection as="h2" first title="What the run learned" data-testid="run-learned-sentence">
        <T size="sm" wrap tone={learned ? 'primary' : 'secondary'}>{learned || 'The run did not name anything worth keeping.'}</T>
      </DetailSection>
      <DetailSection as="h2" title="The debrief" data-testid="run-debrief">
        <Stack gap="sm">
          {!d && <T size="sm" tone="secondary">No debrief was decided for this run.</T>}
          {d?.state === 'filed' && (
            <Stack gap="xs">
              <T size="sm" wrap>{d.proposalKind === 'edit'
                ? `Filed as an edit of ${names.runbook(d.convertedFrom ?? d.answer?.runbookId ?? null)}.`
                : 'Filed as a new runbook for review.'}</T>
              {d.proposalId && <RecordLink to={`/iq/runbooks/proposals/${encodeURIComponent(d.proposalId)}`} data-testid="run-proposal-link"><T size="sm">Open the proposal</T></RecordLink>}
            </Stack>
          )}
          {d?.state === 'skipped' && <T size="sm" wrap data-testid="run-debrief-reason">{d.reasonText ?? 'The run was not debriefed.'}</T>}
          {d?.state === 'nothing-to-keep' && <T size="sm" wrap>{d.answer?.reason ? `The session kept nothing: ${d.answer.reason}` : 'The session kept nothing.'}</T>}
          {d?.state === 'lint-failed' && (
            <Stack gap="sm">
              <T size="sm" wrap>The runbook it wrote did not pass the checks, so it was not filed.</T>
              <DataTable narrow data={d.lint} columns={LINT_COLUMNS} keyField={(l) => `${l.rule}:${l.path}`} staticRows="What the checks found." />
            </Stack>
          )}
          {d?.state === 'refused' && (
            <Stack gap="xs">
              <T size="sm" wrap>The folder it wrote was refused, so nothing was filed.</T>
              {d.problems.map((p) => <T key={p} size="sm" tone="secondary" wrap>{p}</T>)}
            </Stack>
          )}
          {d?.state === 'requested' && <T size="sm" wrap>Waiting for the debrief.</T>}
          {d?.state === 'expired' && <T size="sm" wrap>The debrief did not come back in time, so nothing was filed.</T>}
        </Stack>
      </DetailSection>
    </Stack>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

function StepsSection({ steps, eventsUrl }: { steps: ReturnType<typeof usePipelineRun>['steps']; eventsUrl: string | null }) {
  const plain = steps.map((s) => ({ ...s, label: stepWords(s.label), detail: stepDetail(s.detail) }));
  return (
    <Stack gap="md" data-testid="run-steps">
      <DetailSection as="h2" first title="Steps" hint={`${plain.length}`}><PipelineRunSteps steps={plain} /></DetailSection>
      <DetailSection as="h2" title="Events"><PipelineRunEvents eventsUrl={eventsUrl} title="EVENTS" /></DetailSection>
    </Stack>
  );
}
