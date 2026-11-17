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

import {
  Avatar, Button, Chip, DataTable, DetailSection, FileUploadDrop, Inline, KeyValue, LoadingState, PageHeader, Stack, T, WorkflowStepper,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { plural } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import {
  INTERVIEWS_API, RECOMMENDATION_LABELS, ROUND_TYPE_LABELS, STAGE_LABELS, recommendationTone, roundStatus, stageSteps, whenLabel,
  type CandidateProfile, type ProfileApplication, type ProfileRound, type StageMove,
} from '../../lib/interviews';
import { assignHref, canReassign, declineLines } from '../../lib/interviewsAssign';
import { RESUME_MAX_BYTES, removeResume, resumePath, sizeLabel, uploadResume, type ResumeRecord } from '../../lib/interviewsResume';
import { Dash, PanelCell, StageChip } from './interviewsCells';
import ResumeViewer from './ResumeViewer';

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
    render: (r) => { const s = roundStatus(r.state); return <Chip tone={s.tone} size="xs" data-testid="interviews-profile-round-status">{s.label}</Chip>; },
  },
  {
    key: 'result', header: 'Result',
    render: (r) => (r.results.length
      ? (
        <Inline gap="xs" wrap>
          {r.results.map((x) => (
            <Chip key={x.interviewer.id} tone={recommendationTone(x.recommendation)} size="xs"
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
        ? <T size="sm" tone="secondary" title={lines.join('\n')} className="block max-w-[22rem] truncate" data-testid="interviews-profile-round-declined">{lines[0]}</T>
        : <Dash />;
    },
  },
];

const MOVE_COLUMNS: DataTableColumn<StageMove>[] = [
  { key: 'stage', header: 'Stage', width: '176px', render: (m) => <StageChip stage={m.stage} /> },
  { key: 'at', header: 'Reached', numeric: true, width: '144px', render: (m) => <T size="sm" title={new Date(m.at).toLocaleString()}>{relativeTime(m.at)}</T> },
  { key: 'by', header: 'By', render: (m) => (m.byName ? <T size="sm">{m.byName}</T> : <T size="sm" tone="secondary">The candidate</T>) },
  { key: 'reason', header: 'Note', render: (m) => (m.reason ? <T size="sm" tone="secondary" title={m.reason} className="block max-w-[28rem] truncate">{m.reason}</T> : <Dash />) },
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

function CandidateProfile({ id }: { id: string }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const { data, error, isLoading, refresh } = useFetch<{ candidate: CandidateProfile }>(id ? `${INTERVIEWS_API}/candidates/${encodeURIComponent(id)}` : null);
  const profile = data?.candidate;
  useCrumbLabel(id, profile?.candidate.name);

  if (error && !profile) {
    const home = homeFor(session?.role);
    return isNotFoundError(error) || /404|not found/i.test(error) ? (
      <RecordNotFound heading="Candidate" title="Candidate not found"
        body="There is no candidate here that you can open. You can open the candidates you hire for or interview."
        backLabel={home.label} onBack={() => navigate(home.to)} />
    ) : (
      <UnavailableNotice error={error} what="this candidate" source="Candidates are read from the interviews tenant's applications" onRetry={refresh} />
    );
  }
  if (!profile) return <LoadingState label={isLoading ? 'Loading candidate…' : 'Loading…'} />;

  const { candidate, applications } = profile;
  const first = applications[0];
  return (
    <Stack gap="none" className="h-full min-h-0 min-w-0" data-testid="interviews-candidate-profile">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto">
        <PageHeader density="compact" title={candidate.name} description={candidate.headline}
          badge={first ? <StageChip stage={first.stage} /> : undefined} />
        <Inline gap="md" align="start" wrap={false} className="px-[var(--ui-page-gutter)]" data-testid="interviews-profile-header">
          <Avatar name={candidate.name} size={48} />
          <KeyValue layout="grid" items={[
            { label: 'Applied for', value: <T size="sm" data-testid="interviews-profile-opening">{applications.length ? applications.map((a) => `${a.opening.title}, ${a.opening.team}`).join(' · ') : '—'}</T> },
            { label: 'Applied', value: <T size="sm" data-testid="interviews-profile-applied" title={first?.history[0] ? new Date(first.history[0].at).toLocaleString() : undefined}>{first?.history[0] ? relativeTime(first.history[0].at) : '—'}</T> },
            { label: 'Came from', value: <T size="sm" data-testid="interviews-profile-source">{candidate.source || '—'}</T> },
            { label: 'Based in', value: <T size="sm">{candidate.location || '—'}</T> },
          ]} />
        </Inline>
        {applications.length === 0 && <T size="sm" tone="secondary" className="px-[var(--ui-page-gutter)]">This candidate has no application you can read.</T>}
        {applications.map((a) => <ApplicationSection key={a.applicationId} app={a} several={applications.length > 1} candidateId={candidate.id}
          assigns={['recruiter', 'admin'].includes(String(session?.role))} />)}
        <ResumeSection candidateId={candidate.id} name={candidate.name} manages={['recruiter', 'admin'].includes(String(session?.role))} />
      </Stack>
    </Stack>
  );
}

/** Stages that take no more rounds (the server refuses them too). */
const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'hired']);

function ApplicationSection({ app, several, candidateId, assigns }: { app: ProfileApplication; several: boolean; candidateId: string; assigns: boolean }) {
  const navigate = useNavigate();
  const steps = stageSteps(app.stage, app.history, relativeTime);
  const moves = [...app.history].sort((a, b) => b.at.localeCompare(a.at));
  const rounds = [...app.interviews].sort((a, b) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999'));
  return (
    <Stack gap="md" className="px-[var(--ui-page-gutter)]" data-testid="interviews-profile-application">
      <DetailSection variant="heading" first title={several ? `Stage, ${app.opening.title}` : 'Stage'} hint={STAGE_LABELS[app.stage]} data-testid="interviews-profile-stage">
        <WorkflowStepper size="compact" steps={steps} aria-label={`${app.opening.title}: ${STAGE_LABELS[app.stage]}`} data-testid="interviews-profile-tracker" />
      </DetailSection>
      <DetailSection variant="heading" title={several ? `Rounds, ${app.opening.title}` : 'Rounds'} hint={plural(rounds.length, 'round')} data-testid="interviews-profile-rounds-section"
        actions={assigns && !CLOSED_STAGES.has(app.stage) ? (
          <Button size="sm" variant="secondary" data-testid="interviews-profile-assign"
            onClick={() => navigate(assignHref(candidateId, { application: app.applicationId }))}>Assign a round</Button>
        ) : undefined}>
        <DataTable narrow data-testid="interviews-profile-rounds" aria-label="Rounds" data={rounds} columns={ROUND_COLUMNS}
          keyField={(r) => r.id} emptyMessage="No round has been assigned yet."
          {...(assigns ? {
            rowActionsHeader: 'Change', rowActionsHeaderHidden: true,
            rowActions: (r: ProfileRound) => (canReassign(r.state) ? (
              <Button size="sm" variant={r.state === 'declined' ? 'primary' : 'ghost'} data-testid="interviews-profile-reassign"
                onClick={() => navigate(assignHref(candidateId, { round: r.id }))}>Reassign</Button>
            ) : null),
          } : {})} />
      </DetailSection>
      <DetailSection variant="heading" title="Stage history" hint={plural(moves.length, 'move')} data-testid="interviews-profile-history-section">
        <DataTable narrow data-testid="interviews-profile-history" aria-label="Stage history" data={moves} columns={MOVE_COLUMNS}
          keyField={(m) => `${m.stage}:${m.at}`} staticRows="Each move between stages, read in place" emptyMessage="No stage changes yet." />
      </DetailSection>
    </Stack>
  );
}

/** The résumé: the file for everyone who can open the profile; its facts and the three actions for the recruiter. */
function ResumeSection({ candidateId, name, manages }: { candidateId: string; name: string; manages: boolean }) {
  const { data, refresh } = useFetch<{ resume: ResumeRecord }>(manages ? resumePath(candidateId) : null);
  const [version, setVersion] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(0);
  const [removing, setRemoving] = useState(false);
  const resume = data?.resume ?? null;
  const reread = () => { setVersion((v) => v + 1); refresh(); };

  const send = async (files: File[]) => {
    const file = files[0];
    if (!file || busy) return;
    setProblem(null); setBusy(true);
    const out = await uploadResume(candidateId, file);
    setBusy(false);
    if (!out.ok) { setProblem(out.error); return; }
    reread();
  };

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
  }, [removing, resume, candidateId, name, asked]);

  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'candidate' }, {
    id: 'interviews-profile-commands', label: 'Candidate', placeholder: 'Refresh this candidate…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: reread,
    scopeNote: 'Refresh reloads the résumé shown. Removing it is asked here and never done by a typed command.',
  }), []);

  return (
    <Stack gap="md" className="px-[var(--ui-page-gutter)] pb-4" data-testid="interviews-profile-resume-section">
      <DetailSection variant="heading" title="Résumé" hint={manages && resume ? `${resume.fileName}, ${sizeLabel(resume.sizeBytes)}` : undefined}
        actions={manages && resume ? (
          <Button size="sm" variant="ghost" data-testid="interviews-resume-remove" onClick={() => { setAsked((n) => n + 1); setRemoving(true); }}>Remove</Button>
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
      {manages && <CollectionCommandHost adapter={adapter} prompts={prompts} />}
    </Stack>
  );
}
