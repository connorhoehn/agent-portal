// /interviews/candidates/:id — one candidate (docs/interviews-tenant-plan.md
// "Pages", row I1.2): the header (who, the opening, the stage, when they
// applied and where they came from), the stage tracker with the history of
// each move, and the rounds list. Reads only: GET /api/interviews/candidates/:id
// answers 404 for a candidate the viewer may not open (a recruiter reads all, a
// hiring manager their own openings, an interviewer the people they interview),
// and that shows the usual not-found page, never an error. Résumé, recordings
// and the activity log arrive with their own rows.
//
// Row I1.6: a "Résumé" section below the rounds. Everyone who can open the profile reads the PDF in ResumeViewer;
// the recruiter also sees its name, size, when and by whom, can upload or replace it (PDF, 10 MB, the server's
// own sentence on a refusal) and remove it through a prompt in the composer's deck, never a dialog.
//
// Row I1.4: the recruiter assigns a round from the rounds list ("Assign a
// round", its own form) and reassigns one that has not started. Who declined a
// seat and why shows on its round for the recruiter and the hiring manager (the
// server sends declines to nobody else); the hiring manager's view is read-only.
//
// Row I6.3: a "Deletions" section at the end of the profile for the recruiter and the opening's hiring manager (when, what
// was removed and what is left, by whom). The recruiter's "Delete recordings and transcripts" is asked through a prompt
// in the composer's deck (what goes and what stays, in two sentences), never a dialog. Afterwards the résumé section
// shows its no-file line and the contact fields show what the redaction left.

import {
  Avatar, Button, Chip, DataTable, DetailSection, FileUploadDrop, Inline, KeyValue, LoadingState, PageHeader, Stack, T, Tabs, WorkflowStepper,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { DebriefLink } from './interviewsCells';
import { plural } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import {
  INTERVIEWS_API, candidateHref, RECOMMENDATION_LABELS, ROUND_TYPE_LABELS, STAGE_LABELS, recommendationTone, roundStatus, stageSteps, whenLabel,
  type ApplicationStage, type CandidateProfile, type CandidateRow, type ItemsResponse, type OpeningRow, type ProfileApplication, type ProfileRound, type StageMove,
} from '../../lib/interviews';
import { entriesFromCandidates, entriesFromOpenings, railKindFor, railModel, railNames } from '../../lib/interviewsCandidateRail';
import { assignHref, canReassign, declineLines } from '../../lib/interviewsAssign';
import { hasRecord, recordPath } from '../../lib/interviewsRecord';
import { AppLink } from './interviewsCells';
import { RESUME_MAX_BYTES, removeResume, resumePath, sizeLabel, uploadResume, type ResumeRecord } from '../../lib/interviewsResume';
import {
  REDACTED_NAME, askedByLine, deletionQuestion, deletionState, deletionsPath, lateLine, leftLines, removedLine, requestDeletion,
  type DeletionView, type RetentionPeriods,
} from '../../lib/interviewsRetention';
import { Dash, PanelCell, StageChip } from './interviewsCells';
import ResumeViewer from './ResumeViewer';
import ProfileConsents from './ProfileConsents';
import { readsConsents } from '../../lib/interviewsRecords';

const ROUND_COLUMNS: DataTableColumn<ProfileRound>[] = [
  {
    key: 'round', header: 'Round', sortable: true, compare: (a, b) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999'),
    render: (r) => <T size="sm" title={`${ROUND_TYPE_LABELS[r.round.type]}, ${r.round.minutes} minutes`} data-testid="interviews-profile-round">{r.round.name}</T>,
  },
  { key: 'who', header: 'Interviewers', render: (r) => <PanelCell lead={r.lead} panel={r.panel} /> },
  {
    key: 'when', header: 'When', numeric: true,
    render: (r) => (r.scheduledAt ? <T size="sm" title={new Date(r.scheduledAt).toLocaleString()}>{whenLabel(r.scheduledAt)}</T> : <Dash />),
  },
  {
    key: 'status', header: 'Status', width: '136px',
    render: (r) => { const s = roundStatus(r.state); return <Chip tone={s.tone} size="sm" data-testid="interviews-profile-round-status">{s.label}</Chip>; },
  },
  {
    key: 'result', header: 'Result',
    render: (r) => (r.results.length
      ? (
        <Inline gap="xs" wrap>
          {r.results.map((x) => (
            <Chip key={x.interviewer.id} tone={recommendationTone(x.recommendation)} size="sm"
              title={`${RECOMMENDATION_LABELS[x.recommendation]} from ${x.interviewer.name}`}>
              {r.results.length > 1 ? `${RECOMMENDATION_LABELS[x.recommendation]} · ${x.interviewer.name.split(' ')[0]}` : RECOMMENDATION_LABELS[x.recommendation]}
            </Chip>
          ))}
        </Inline>
      )
      : <Dash />),
  },
  {
    key: 'declined', header: 'Declined',
    render: (r) => {
      const lines = declineLines(r);
      return lines.length
        ? <T size="sm" tone="secondary" wrap data-testid="interviews-profile-round-declined">{lines.join(' ')}</T>
        : <Dash />;
    },
  },
  {
    key: 'record', header: 'Record',
    render: (r) => (hasRecord(r.state)
      ? <AppLink to={recordPath(r.id)} data-testid="interviews-profile-round-record">Open the record</AppLink>
      : <Dash />),
  },
];

const MOVE_COLUMNS: DataTableColumn<StageMove>[] = [
  { key: 'stage', header: 'Stage', width: '176px', render: (m) => <StageChip stage={m.stage} /> },
  { key: 'at', header: 'Reached', numeric: true, width: '144px', render: (m) => <T size="sm" title={new Date(m.at).toLocaleString()}>{relativeTime(m.at)}</T> },
  { key: 'by', header: 'By', render: (m) => (m.byName ? <T size="sm">{m.byName}</T> : <T size="sm" tone="secondary">The candidate</T>) },
  { key: 'reason', header: 'Note', render: (m) => (m.reason ? <T size="sm" tone="secondary" wrap>{m.reason}</T> : <Dash />) },
];

export default function CandidateProfilePage() {
  const { id } = useParams();
  const { session } = useSession();
  return <CandidateProfile key={`${session?.sub}:${session?.tenant}:${session?.role}:${id}`} id={id ?? ''} />;
}

/** The viewer's own list: where "back" goes from a candidate they cannot open. */
function homeFor(role: string | undefined): { to: string; label: string } {
  if (role === 'hiring-manager') return { to: '/interviews/my-openings', label: 'My openings' };
  if (role === 'interviewer') return { to: '/interviews/my-interviews', label: 'My interviews' };
  return { to: '/interviews/candidates', label: 'Candidates' };
}

/**
 * The profile beside the viewer's own candidates list (the layout cascade): a recruiter or admin reads every
 * candidate, a hiring manager the candidates on their openings. An interviewer has no candidates list (theirs is
 * rounds) and My interviews' read names no candidates, so they keep the page without a rail.
 */
function ProfileFrame({ id, role, footer, listVersion = 0, children }: { id: string; role: string; footer?: ReactNode; listVersion?: number; children: ReactNode }) {
  const navigate = useNavigate();
  const kind = railKindFor(role);
  const [query, setQuery] = useState('');
  const mine = useFetch<ItemsResponse<CandidateRow>>(kind === 'candidates' ? `${INTERVIEWS_API}/candidates` : null);
  const openings = useFetch<ItemsResponse<OpeningRow>>(kind === 'openings' ? `${INTERVIEWS_API}/openings` : null);
  const source = kind === 'openings' ? openings : mine;
  // A deletion renames the candidate on the server: the rail re-reads so it shows what the breadcrumb shows.
  const refreshRail = source.refresh;
  useEffect(() => { if (listVersion > 0) refreshRail(); }, [listVersion, refreshRail]);
  const entries = useMemo(
    () => (kind === 'candidates' ? entriesFromCandidates(mine.data?.items ?? []) : kind === 'openings' ? entriesFromOpenings(openings.data?.items ?? []) : []),
    [kind, mine.data, openings.data],
  );
  const model = useMemo(() => railModel(entries, query, id), [entries, query, id]);
  if (!kind) return <Stack gap="md" className="h-full min-h-0 min-w-0 overflow-auto">{children}</Stack>;
  const names = railNames(kind);
  return (
    <CollectionRecordFrame
      title={names.title} description={names.description} listTitle={names.listTitle} listLabel={names.listLabel}
      {...(source.data ? { count: model.total } : {})}
      search={{ value: query, onChange: setQuery, placeholder: names.placeholder }}
      groups={model.groups} rows={model.rows} currentId={id}
      onOpen={(next) => void navigate(candidateHref(next))}
      loading={source.isLoading && !source.data} error={source.error} onRetry={source.refresh}
      {...(footer ? { footer } : {})}
      railType="app" data-testid="interviews-candidate-frame">
      {children}
    </CollectionRecordFrame>
  );
}

function CandidateProfile({ id }: { id: string }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const { data, error, isLoading, refresh } = useFetch<{ candidate: CandidateProfile }>(id ? `${INTERVIEWS_API}/candidates/${encodeURIComponent(id)}` : null);
  const profile = data?.candidate;
  useCrumbLabel(id, profile?.candidate.name);
  const role = String(session?.role);
  const manages = role === 'recruiter' || role === 'admin';
  // An interviewer's page has no list rail, so it keeps its own h1 (the name); beside a rail the frame's title is the h1.
  const framed = railKindFor(role) !== null;
  const deletions = useDeletionPrompt(id, role, refresh);
  const resume = useResumeState(id, profile?.candidate.name ?? '', manages);
  const [tab, setTab] = useState<ProfileTab>('rounds');

  // The dock floats over the foot of the column: the room under the last section lets the rows and a prompt's receipt scroll clear of it (pb-56 below).
  // The résumé's and the deletion's prompts live in the page's dock, whichever tab is open.
  const dock = manages ? <CollectionCommandHost inPlace adapter={resume.adapter} prompts={[...resume.prompts, ...deletions.prompts]} /> : undefined;

  if (error && !profile) {
    const home = homeFor(session?.role);
    return (
      <ProfileFrame id={id} role={role}>
        {isNotFoundError(error) || /404|not found/i.test(error) ? (
          <RecordNotFound heading="Candidate" title="Candidate not found" {...(framed ? { size: 'md' as const } : {})}
            body="There is no candidate here that you can open. You can open the candidates you hire for or interview."
            backLabel={home.label} onBack={() => navigate(home.to)} />
        ) : (
          <UnavailableNotice error={error} what="this candidate" source="Candidates are read from the interviews tenant's applications" onRetry={refresh} />
        )}
      </ProfileFrame>
    );
  }
  if (!profile) return <ProfileFrame id={id} role={role}><LoadingState label={isLoading ? 'Loading candidate…' : 'Loading…'} /></ProfileFrame>;

  const { candidate, applications } = profile;
  const first = applications[0];
  const redacted = candidate.name === REDACTED_NAME;
  const rounds = applications.flatMap((a) => a.interviews);
  const recorded = recordedRounds(applications);
  return (
    <ProfileFrame id={id} role={role} footer={dock} listVersion={deletions.done}>
      {!framed && <PageHeader density="compact" title={candidate.name} description={candidate.headline} badge={first ? <StageChip stage={first.stage} /> : undefined} />}
      <Stack gap="md" className={framed ? 'pb-56' : 'px-[var(--ui-page-gutter)] pb-4'} data-testid="interviews-candidate-profile">
        <ProfileHead framed={framed} name={candidate.name} headline={candidate.headline} stage={first?.stage}>
          <Inline gap="md" align="start" wrap={false} data-testid="interviews-profile-header">
            <Avatar name={candidate.name} size={48} />
            <KeyValue layout="grid" items={[
              { label: 'Applied for', value: <T size="sm" data-testid="interviews-profile-opening">{applications.length ? applications.map((a) => `${a.opening.title}, ${a.opening.team}`).join(' · ') : '—'}</T> },
              { label: 'Applied', value: <T size="sm" data-testid="interviews-profile-applied" title={first?.history[0] ? new Date(first.history[0].at).toLocaleString() : undefined}>{first?.history[0] ? relativeTime(first.history[0].at) : '—'}</T> },
              { label: 'Came from', value: <T size="sm" data-testid="interviews-profile-source">{candidate.source || '—'}</T> },
              { label: 'Based in', value: <T size="sm" data-testid="interviews-profile-location">{redacted ? 'Removed' : candidate.location || '—'}</T> },
            ]} />
          </Inline>
        </ProfileHead>
        {redacted && (
          <T size="sm" tone="secondary" data-testid="interviews-profile-redacted">
            This candidate's contact details were removed. Their interview records stay for their period without them.
          </T>
        )}
        {applications.length === 0 && <T size="sm" tone="secondary">This candidate has no application you can read.</T>}
        {applications.map((a) => <StageSection key={a.applicationId} app={a} several={applications.length > 1} candidateId={candidate.id} />)}
        <Tabs idPrefix="interviews-profile" aria-label="Candidate" variant="underline" size="sm" value={tab} onValueChange={(v) => setTab(v as ProfileTab)}
          getItemTestId={(item) => `interviews-profile-tab-${item.id}`}
          items={[
            { id: 'rounds', label: 'Rounds', badge: rounds.length || undefined },
            { id: 'resume', label: 'Résumé' },
            { id: 'recordings', label: 'Recordings', badge: recorded.length || undefined },
            { id: 'activity', label: 'Activity' },
          ]} />
        {tab === 'rounds' && applications.map((a) => (
          <RoundsSection key={a.applicationId} app={a} several={applications.length > 1} candidateId={candidate.id} assigns={manages} />
        ))}
        {tab === 'resume' && <ResumeSection candidateId={candidate.id} manages={manages} state={resume} />}
        {tab === 'recordings' && <RecordingsSection rows={recorded} />}
        {tab === 'activity' && (
          <Stack gap="md" data-testid="interviews-profile-activity">
            {applications.map((a) => <HistorySection key={a.applicationId} app={a} several={applications.length > 1} />)}
            {readsConsents(role) && <ProfileConsents candidateId={candidate.id} />}
            {deletions.reads && <DeletionsSection rows={deletions.rows} asks={deletions.asks} onAsk={deletions.ask} />}
          </Stack>
        )}
      </Stack>
    </ProfileFrame>
  );
}

/** The name and its facts. Beside the rail the frame's title is the h1, so the name is the first section; without a rail the page header carries it. */
function ProfileHead({ framed, name, headline, stage, children }: { framed: boolean; name: string; headline: string; stage: ApplicationStage | undefined; children: ReactNode }) {
  if (!framed) return <>{children}</>;
  return (
    <DetailSection variant="heading" as="h2" first title={name} hint={stage ? <StageChip stage={stage} /> : undefined} {...(headline ? { description: headline } : {})}>
      {children}
    </DetailSection>
  );
}

type ProfileTab = 'rounds' | 'resume' | 'recordings' | 'activity';

/** Stages that take no more rounds (the server refuses them too). */
const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'hired']);

/** The stage tracker, above the tabs: where the application stands and the way to its debrief. */
function StageSection({ app, several, candidateId }: { app: ProfileApplication; several: boolean; candidateId: string }) {
  const steps = stageSteps(app.stage, app.history, relativeTime);
  return (
    <DetailSection variant="heading" as="h2" title={several ? `Stage, ${app.opening.title}` : 'Stage'} hint={STAGE_LABELS[app.stage]} data-testid="interviews-profile-stage" actions={<DebriefLink candidateId={candidateId} />}>
      <WorkflowStepper size="compact" steps={steps} aria-label={`${app.opening.title}: ${STAGE_LABELS[app.stage]}`} data-testid="interviews-profile-tracker" />
    </DetailSection>
  );
}

function RoundsSection({ app, several, candidateId, assigns }: { app: ProfileApplication; several: boolean; candidateId: string; assigns: boolean }) {
  const navigate = useNavigate();
  const rounds = [...app.interviews].sort((a, b) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999'));
  return (
    <DetailSection variant="heading" as="h2" first title={several ? `Rounds, ${app.opening.title}` : 'Rounds'} hint={plural(rounds.length, 'round')} data-testid="interviews-profile-rounds-section"
      actions={assigns && !CLOSED_STAGES.has(app.stage) ? (
        <Button size="sm" variant="secondary" data-testid="interviews-profile-assign"
          onClick={() => navigate(assignHref(candidateId, { application: app.applicationId }))}>Assign a round</Button>
      ) : undefined}>
      <DataTable narrow rowHeight="content" data-testid="interviews-profile-rounds" aria-label="Rounds" data={rounds} columns={ROUND_COLUMNS}
        keyField={(r) => r.id} staticRows="Each round with its status and result; its record opens from the Record column" emptyMessage="No round has been assigned yet."
        {...(assigns ? {
          rowActionsHeader: 'Change', rowActionsHeaderHidden: true,
          rowActions: (r: ProfileRound) => (canReassign(r.state) ? (
            <Button size="sm" variant={r.state === 'declined' ? 'primary' : 'ghost'} data-testid="interviews-profile-reassign"
              onClick={() => navigate(assignHref(candidateId, { round: r.id }))}>Reassign</Button>
          ) : null),
        } : {})} />
    </DetailSection>
  );
}

function HistorySection({ app, several }: { app: ProfileApplication; several: boolean }) {
  const moves = [...app.history].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <DetailSection variant="heading" as="h2" first title={several ? `Stage history, ${app.opening.title}` : 'Stage history'} hint={plural(moves.length, 'move')} data-testid="interviews-profile-history-section">
      <DataTable narrow rowHeight="content" data-testid="interviews-profile-history" aria-label="Stage history" data={moves} columns={MOVE_COLUMNS}
        keyField={(m) => `${m.stage}:${m.at}`} staticRows="Each move between stages, read in place" emptyMessage="No stage changes yet." />
    </DetailSection>
  );
}

/** One row per finished round that has a record, from what the profile read already answers. */
export interface RecordedRound { id: string; round: string; opening: string; when: string | null; lead: string }
export function recordedRounds(applications: readonly ProfileApplication[]): RecordedRound[] {
  return applications
    .flatMap((a) => a.interviews.filter((r) => hasRecord(r.state)).map((r) => ({ id: r.id, round: r.round.name, opening: a.opening.title, when: r.scheduledAt, lead: r.lead.name })))
    .sort((x, y) => (y.when ?? '').localeCompare(x.when ?? ''));
}

const RECORDING_COLUMNS: DataTableColumn<RecordedRound>[] = [
  { key: 'round', header: 'Round', render: (r) => <T size="sm">{r.round}</T> },
  { key: 'when', header: 'When', numeric: true, render: (r) => (r.when ? <T size="sm" title={new Date(r.when).toLocaleString()}>{whenLabel(r.when)}</T> : <Dash />) },
  { key: 'lead', header: 'Led by', render: (r) => <T size="sm">{r.lead}</T> },
  { key: 'record', header: 'Record', render: (r) => <AppLink to={recordPath(r.id)} data-testid="interviews-profile-recording-open">Open the record</AppLink> },
];

function RecordingsSection({ rows }: { rows: RecordedRound[] }) {
  return (
    <DetailSection variant="heading" as="h2" first title="Recordings" hint={plural(rows.length, 'recording')} data-testid="interviews-profile-recordings-section">
      <DataTable narrow rowHeight="content" data-testid="interviews-profile-recordings" aria-label="Recordings" data={rows} columns={RECORDING_COLUMNS}
        keyField={(r) => r.id} emptyMessage="No round has been recorded yet." />
    </DetailSection>
  );
}

/** The résumé's state, held by the page so its removal prompt (like the deletion's) stays in the dock whichever tab is open. */
function useResumeState(candidateId: string, name: string, manages: boolean) {
  const { data, refresh } = useFetch<{ resume: ResumeRecord }>(manages && candidateId ? resumePath(candidateId) : null);
  const [version, setVersion] = useState(0);
  const [asked, setAsked] = useState(0);
  const [removing, setRemoving] = useState(false);
  const resume = data?.resume ?? null;
  const reread = () => { setVersion((v) => v + 1); refresh(); };

  const prompts = useMemo<ComposerPrompt[]>(() => {
    if (!removing || !resume) return [];
    const scope = `interviews-resume:${candidateId}`;
    return [{
      id: `${scope}:remove-${asked}`, scope, kind: 'choice', eyebrow: 'Remove the résumé', title: name,
      fields: [{ label: 'File', value: resume.fileName }],
      question: 'Remove this résumé? Nobody will be able to read it here until a new one is added.',
      options: [{ id: 'remove', label: 'Remove', emphasis: 'danger' }, { id: 'keep', label: 'Keep it', emphasis: 'primary' }],
      onAnswer: async (a) => {
        if (!('optionId' in a) || a.optionId !== 'remove') { setRemoving(false); return { receipt: 'Kept. The résumé did not change.' }; }
        const out = await removeResume(candidateId);
        if (!out.ok) return { error: out.error };
        setRemoving(false); setAsked((n) => n + 1); reread();
        return { receipt: 'The résumé is removed.' };
      },
    }];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removing, resume, candidateId, name, asked]);

  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'candidate' }, {
    id: 'interviews-profile-commands', label: 'Candidate', placeholder: 'Refresh this candidate…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: reread,
    scopeNote: 'Refresh reloads the résumé shown. Removing it is asked here and never done by a typed command.',
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return { resume, version, reread, prompts, adapter, remove: () => { setAsked((n) => n + 1); setRemoving(true); } };
}
type ResumeState = ReturnType<typeof useResumeState>;

/** The résumé: the file for everyone who can open the profile; its facts and the three actions for the recruiter. */
function ResumeSection({ candidateId, manages, state }: { candidateId: string; manages: boolean; state: ResumeState }) {
  const { resume, version, reread, remove } = state;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (files: File[]) => {
    const file = files[0];
    if (!file || busy) return;
    setProblem(null); setBusy(true);
    const out = await uploadResume(candidateId, file);
    setBusy(false);
    if (!out.ok) { setProblem(out.error); return; }
    reread();
  };

  return (
    <Stack gap="md" className="pb-4" data-testid="interviews-profile-resume-section">
      <DetailSection variant="heading" as="h2" first title="Résumé" hint={manages && resume ? `${resume.fileName}, ${sizeLabel(resume.sizeBytes)}` : undefined}
        actions={manages && resume ? (
          <Button size="sm" variant="ghost" data-testid="interviews-resume-remove" onClick={remove}>Remove</Button>
        ) : undefined}>
        <Stack gap="sm">
          {manages && (
            <Stack gap="xs">
              {resume && (
                <T size="sm" tone="secondary" data-testid="interviews-resume-facts">
                  {`Added ${relativeTime(resume.uploadedAt)}${resume.uploadedBy ? ` by ${resume.uploadedBy.name}` : ''}.`}
                </T>
              )}
              <FileUploadDrop accept="application/pdf,.pdf" maxSize={RESUME_MAX_BYTES} disabled={busy} data-testid="interviews-resume-upload"
                label={busy ? 'Uploading…' : resume ? 'Replace: drop a PDF here, or click to choose' : 'Upload a résumé: drop a PDF here, or click to choose'}
                onFiles={(files) => void send(files)} onError={setProblem} />
              {problem && <T size="sm" tone="danger" role="alert" data-testid="interviews-resume-problem">{problem}</T>}
            </Stack>
          )}
          <Stack gap="none" className="h-[70vh] min-h-[28rem]" data-testid="interviews-resume-frame">
            <ResumeViewer candidateId={candidateId} version={version} />
          </Stack>
        </Stack>
      </DetailSection>
    </Stack>
  );
}

const DELETION_COLUMNS: DataTableColumn<DeletionView>[] = [
  { key: 'at', header: 'When', numeric: true, width: '144px', render: (r) => <T size="sm" title={new Date(r.requestedAt).toLocaleString()}>{relativeTime(r.requestedAt)}</T> },
  {
    key: 'what', header: 'Removed',
    render: (r) => <T size="sm" wrap data-testid="interviews-deletion-removed">{removedLine(r)}</T>,
  },
  {
    key: 'left', header: 'Not removed',
    render: (r) => {
      const late = lateLine(r);
      const lines = late ? [late, ...leftLines(r)] : leftLines(r);
      if (late) return <T size="sm" tone={r.overdue ? 'danger' : 'secondary'} wrap data-testid="interviews-deletion-late">{lines.join(' ')}</T>;
      return lines.length
        ? <T size="sm" tone="secondary" wrap data-testid="interviews-deletion-left">{lines.join(' ')}</T>
        : <Dash />;
    },
  },
  { key: 'by', header: 'By', render: (r) => <T size="sm">{askedByLine(r)}</T> },
  { key: 'state', header: 'Status', width: '120px', render: (r) => { const s = deletionState(r); return <Chip tone={s.tone} size="sm">{s.label}</Chip>; } },
];

/** The deletion log and, for the recruiter, the prompt that asks for one. Hooks only; the section draws it. */
function useDeletionPrompt(candidateId: string, role: string, refreshProfile: () => void) {
  const reads = role === 'recruiter' || role === 'hiring-manager';
  const asks = role === 'recruiter';
  const { data, refresh } = useFetch<{ items: DeletionView[]; periods: RetentionPeriods }>(reads && candidateId ? deletionsPath(candidateId) : null);
  const [asking, setAsking] = useState(0);
  const [done, setDone] = useState(0);
  const periods = data?.periods ?? null;
  const prompts = useMemo<ComposerPrompt[]>(() => {
    if (!asks || !asking || !periods) return [];
    const scope = `interviews-deletion:${candidateId}`;
    return [{
      id: `${scope}:ask-${asking}`, scope, kind: 'choice', eyebrow: 'Delete recordings and transcripts', title: 'This candidate',
      question: deletionQuestion(periods),
      options: [{ id: 'delete', label: 'Delete', emphasis: 'danger' }, { id: 'keep', label: 'Keep everything', emphasis: 'primary' }],
      onAnswer: async (a) => {
        if (!('optionId' in a) || a.optionId !== 'delete') { setAsking(0); return { receipt: 'Kept. Nothing was removed.' }; }
        const out = await requestDeletion(candidateId);
        setAsking(0); refresh();
        if (!out.ok) return { error: out.error };
        setDone((n) => n + 1); refreshProfile();
        return { receipt: out.created ? `${removedLine(out.deletion)}` : 'This was already deleted. Nothing changed.' };
      },
    }];
  }, [asks, asking, periods, candidateId, refresh, refreshProfile]);
  return { reads, asks, rows: data?.items ?? null, prompts, done, ask: () => setAsking((n) => n + 1) };
}

function DeletionsSection({ rows, asks, onAsk }: { rows: DeletionView[] | null; asks: boolean; onAsk: () => void }) {
  return (
    <Stack gap="md" className="pb-4" data-testid="interviews-profile-deletions-section">
      <DetailSection variant="heading" as="h2" title="Deletions" hint={rows ? plural(rows.length, 'deletion') : undefined}
        actions={asks ? <Button size="sm" variant="ghost" data-testid="interviews-deletion-ask" onClick={onAsk}>Delete recordings and transcripts</Button> : undefined}>
        {rows === null
          ? <LoadingState label="Loading deletions…" />
          : (
            <DataTable narrow rowHeight="content" data-testid="interviews-profile-deletions" aria-label="Deletions" data={rows} columns={DELETION_COLUMNS}
              keyField={(r) => r.id} staticRows="Each deletion, read in place" emptyMessage="Nothing has been deleted for this candidate." />
          )}
      </DetailSection>
    </Stack>
  );
}
