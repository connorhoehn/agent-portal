// /interviews/rounds/:id/prepare — the lead's page for one round (docs/interviews-tenant-plan.md row I1.7, contract
// C6): who the candidate is, the résumé, what the kit judges, the question bank and "Your plan". The lead adds,
// removes and reorders questions and saves them; a panel member or the recruiter reads the same page and chooses
// nothing. One line says what the round still waits for; once it is ready the lead can open the room (row I2.4).
// The server decides everything (middleware lib/interviews/prepare.ts); a stale save shows what was saved.

import { Button, ChevronIcon, Chip, ContextColumn, DataTable, DetailPage, DetailSection, DocumentIcon, EmptyState, IconButton, Inline, MetaLine, Stack, T, TrashIcon, type ContextColumnState, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FlushDetailFrame, useFlushTrailItems } from '../../components/shell/FlushPage';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { INTERVIEWS_API, ROUND_TYPE_LABELS, roundStatus, whenWithZone } from '../../lib/interviews';
import { moved } from '../../lib/interviewsKit';
import { askForPlan, bankGroups, canOpenRoom, draftLine, planFromDraft, roomPath, samePlan, savePlan, type BankQuestion, type DraftQuestion, type InterviewRecord, type PlanDraft } from '../../lib/interviewsPrepare';
import ResumeViewer from './ResumeViewer';

export default function PreparePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const base = useFlushTrailItems();
  const { data, error, failure, refresh } = useFetch<{ interview: InterviewRecord }>(id ? `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}` : null);
  const record = data?.interview ?? null;
  // A refused stale save remounts the workspace (it is keyed by revision); the refusal is held here so its words outlive the refetch.
  const [carried, setCarried] = useState<string | null>(null);
  useCrumbLabel(id, record ? `${record.candidate.name}, ${record.round.name}` : null);
  if (failure?.status === 404) {
    return <RecordNotFound heading="Round" title="Round not found" body="There is no round here that you can open." backLabel="Home" onBack={() => navigate('/interviews')} />;
  }
  if (error && !record) return <UnavailableNotice error={error} what="this round" source="Rounds are read from the interviews tenant" onRetry={refresh} />;
  if (!record) return <FlushDetailFrame><DetailPage title="Prepare" breadcrumbs={base}><T size="sm" tone="tertiary">Loading the round…</T></DetailPage></FlushDetailFrame>;
  return <FlushDetailFrame><PrepareWorkspace key={`${record.id}:${record.revision}`} record={record} trail={base} onChanged={refresh} carried={carried} onCarried={setCarried} /></FlushDetailFrame>;
}

function PrepareWorkspace({ record, trail, onChanged, carried, onCarried }: {
  record: InterviewRecord; trail: ReturnType<typeof useFlushTrailItems>; onChanged: () => void;
  carried: string | null; onCarried: (line: string | null) => void;
}) {
  const navigate = useNavigate();
  const saved = useMemo(() => record.questionsChosen.map((q) => q.id), [record]);
  const [plan, setPlan] = useState<string[]>(saved);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [asking, setAsking] = useState(false);
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const [resumeState, setResumeState] = useState<ContextColumnState>('wide');
  useEffect(() => { setPlan(saved); }, [saved]);

  const byId = new Map(record.bank.map((q) => [q.id, q]));
  const planned = plan.map((q) => byId.get(q)).filter((q): q is BankQuestion => !!q);
  const groups = bankGroups(record.bank, record.competencies, plan);
  const dirty = !samePlan(plan, saved);
  // The carried refusal stays until the person changes the plan again.
  useEffect(() => { if (dirty) onCarried(null); }, [dirty, onCarried]);
  const shownProblem = problem ?? carried;
  const editable = record.canPrepare;
  const full = plan.length >= record.maxQuestions;
  const status = roundStatus(record.state);

  const save = async () => {
    setBusy(true); setProblem(null); setNote(null); onCarried(null);
    const out = await savePlan(record.id, record.revision, plan);
    setBusy(false);
    if (!out.ok) {
      if (out.stale) { onCarried(out.error); onChanged(); } else setProblem(out.error);
      return;
    }
    setNote('Your plan is saved.');
    onChanged();
  };

  const ask = async () => {
    setAsking(true); setAskProblem(null);
    const out = await askForPlan(record.id);
    setAsking(false);
    if (!out.ok) { setAskProblem(out.error); return; }
    setDraft(out.draft);
  };
  const suggested = draft?.plan?.questions ?? [];
  const suggestedLine = draft ? draftLine(draft) : null;
  const useDraft = () => { setPlan(planFromDraft(suggested, record.bank, record.maxQuestions)); setNote(null); };
  const draftColumns: DataTableColumn<DraftQuestion>[] = [
    { key: 'prompt', header: 'Question', render: (d) => <T size="sm" data-testid="interviews-draft-prompt">{byId.get(d.questionId)?.prompt ?? ''}</T> },
    { key: 'why', header: 'Why', render: (d) => <T size="sm" tone="secondary">{d.why}</T> },
  ];

  const planColumns: DataTableColumn<BankQuestion>[] = [
    { key: 'n', header: '#', numeric: true, width: '48px', render: (q) => <T size="sm" tone="secondary">{plan.indexOf(q.id) + 1}</T> },
    { key: 'prompt', header: 'Question', render: (q) => <T size="sm" data-testid="interviews-plan-prompt">{q.prompt}</T> },
    { key: 'competency', header: 'Competency', render: (q) => <T size="sm" tone="secondary">{q.competency}</T> },
  ];
  const bankColumns: DataTableColumn<BankQuestion>[] = [
    { key: 'prompt', header: 'Question', render: (q) => <T size="sm" data-testid="interviews-bank-prompt">{q.prompt}</T> },
    { key: 'starter', header: 'Starter code', width: '120px', render: (q) => (q.hasStarter ? <T size="sm">Has starter code</T> : <T size="xs" tone="tertiary">—</T>) },
  ];

  const planControls = (q: BankQuestion) => {
    const i = plan.indexOf(q.id);
    return (
      <Inline gap="xs" wrap={false} justify="end">
        <IconButton size="sm" variant="ghost" aria-label={`Move question ${i + 1} up`} icon={<ChevronIcon dir="up" size={14} />} disabled={!editable || i === 0}
          onClick={() => setPlan((p) => moved(p, i, -1))} />
        <IconButton size="sm" variant="ghost" aria-label={`Move question ${i + 1} down`} icon={<ChevronIcon dir="down" size={14} />} disabled={!editable || i === plan.length - 1}
          onClick={() => setPlan((p) => moved(p, i, 1))} />
        <IconButton size="sm" variant="ghost" aria-label={`Take question ${i + 1} out of your plan`} icon={<TrashIcon size={14} />} disabled={!editable}
          onClick={() => setPlan((p) => p.filter((x) => x !== q.id))} />
      </Inline>
    );
  };

  const planSection = (
    <Stack gap="md">
      <DetailSection variant="heading" as="h2" title="Your plan" hint={`${plan.length} of ${record.maxQuestions}`}>
        <Stack gap="sm">
          {editable && (
            <Inline gap="sm" align="center" wrap={false}>
              <Button size="sm" variant="primary" disabled={!dirty || busy} data-testid="interviews-plan-save" onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save plan'}</Button>
              <T size="xs" tone="tertiary">{dirty ? 'You have changes that are not saved yet.' : 'Everything here is saved.'}</T>
            </Inline>
          )}
          {record.missing && <T size="sm" tone="secondary" data-testid="interviews-prepare-missing">{record.missing}</T>}
          {!editable && <T size="sm" tone="secondary" data-testid="interviews-prepare-readonly">{readOnlyLine(record)}</T>}
          {shownProblem && <T size="sm" tone="danger" role="alert" data-testid="interviews-plan-problem">{shownProblem}</T>}
          {note && !shownProblem && <T size="sm" tone="secondary" role="status" data-testid="interviews-plan-note">{note}</T>}
          {planned.length === 0
            ? <T size="sm" tone="tertiary" data-testid="interviews-plan-empty">Nothing in the plan yet. Add questions from the list below.</T>
            : <DataTable narrow rowHeight="content" data-testid="interviews-plan-table" aria-label="Your plan" data={planned} columns={planColumns} keyField={(q) => q.id} staticRows="Each question in your plan, with its order controls"
              rowActions={editable ? planControls : undefined} rowActionsHeader="Order" rowActionsHeaderHidden />}
        </Stack>
      </DetailSection>
      {editable && record.seat === 'lead' && record.bank.length > 0 && (
        <DetailSection variant="heading" as="h2" title="Milo's suggested plan" hint="A suggestion from the kit. You choose.">
          <Stack gap="sm">
            <Inline gap="sm" align="center" wrap={false}>
              <Button size="sm" variant="secondary" disabled={asking} data-testid="interviews-draft-ask" onClick={() => { void ask(); }}>{asking ? 'Asking Milo…' : suggested.length ? 'Ask again' : 'Ask Milo for a plan'}</Button>
            </Inline>
            {askProblem && <T size="sm" tone="danger" role="alert" data-testid="interviews-draft-problem">{askProblem}</T>}
            {!draft && !askProblem && <T size="sm" tone="secondary" data-testid="interviews-draft-intro">Milo reads the kit and this candidate, then proposes questions with a reason for each. Nothing changes in your plan until you use it.</T>}
            {suggestedLine && <T size="sm" tone="secondary" data-testid="interviews-draft-line">{suggestedLine}</T>}
            {suggested.length > 0 && (
              <>
                <DataTable narrow rowHeight="content" data-testid="interviews-draft-table" aria-label="Milo's suggested plan" data={suggested} columns={draftColumns} keyField={(d) => d.questionId} staticRows="Each question Milo suggests, read in place" />
                <Inline gap="sm" wrap={false}>
                  <Button size="sm" variant="primary" data-testid="interviews-draft-use" onClick={useDraft}>Use this plan</Button>
                  <T size="xs" tone="tertiary">This replaces the selection above. Save it when you are happy with it.</T>
                </Inline>
              </>
            )}
          </Stack>
        </DetailSection>
      )}
      {groups.length === 0
        ? <T size="sm" tone="tertiary">{record.bank.length === 0 ? 'This opening has no questions for this kind of round yet. The recruiter adds them in the kit.' : 'Every question in the bank is in your plan.'}</T>
        : groups.map((g) => (
          <DetailSection key={g.competencyId} variant="heading" as="h2" title={g.name} hint={`${g.questions.length} to choose from`}>
            <DataTable narrow rowHeight="content" data-testid="interviews-bank-table" aria-label={`Questions for ${g.name}`} data={g.questions} columns={bankColumns} keyField={(q) => q.id} staticRows="Each question in the kit, with a button to add it"
              rowActions={editable ? (q) => (
                <Button size="sm" variant="secondary" disabled={full} title={full ? `A round takes at most ${record.maxQuestions} questions.` : undefined}
                  data-testid="interviews-bank-add" onClick={() => setPlan((p) => [...p, q.id])}>Add</Button>
              ) : undefined} rowActionsHeader="Add" rowActionsHeaderHidden />
          </DetailSection>
        ))}
    </Stack>
  );

  return (
    <DetailPage data-testid="interviews-prepare" title={`${record.candidate.name}, ${record.round.name}`} breadcrumbs={trail}
      badge={<Chip tone={status.tone} size="sm" data-testid="interviews-prepare-state">{status.label}</Chip>}
      meta={<MetaLine size="sm" data-testid="interviews-prepare-meta" items={[
        record.opening.title, `${ROUND_TYPE_LABELS[record.round.type]}, ${record.round.minutes} minutes`, whenWithZone(record.scheduledAt),
        record.seat === 'lead' ? 'You lead' : record.seat === 'panel' ? `${record.lead.name} leads` : `${record.lead.name} leads`,
      ]} />}
      actions={canOpenRoom(record) && record.seat === 'lead'
        ? <Button size="sm" variant="primary" data-testid="interviews-prepare-room" onClick={() => void navigate(roomPath(record.id))}>Open the room</Button>
        : undefined}
      aside={(
        <ContextColumn state={resumeState} onStateChange={setResumeState} label="Résumé" activeId="resume" onActivate={() => setResumeState('wide')} data-testid="interviews-prepare-resume"
          panels={[{ id: 'resume', label: 'Résumé', icon: <DocumentIcon size={16} />, content: <ResumeViewer candidateId={record.candidate.id} /> }]} />
      )}
      tabs={[
        { id: 'plan', label: 'Questions', badge: plan.length || undefined, testId: 'interviews-prepare-tab-plan', content: planSection },
        { id: 'competencies', label: 'Competencies', badge: record.competencies.length || undefined, testId: 'interviews-prepare-tab-competencies', content: <Competencies record={record} /> },
      ]} />
  );
}

function readOnlyLine(r: InterviewRecord): string {
  if (r.state === 'assigned') return r.seat === 'lead' ? 'Accept this round first: you choose its questions once you have.' : `${r.lead.name} chooses the questions once they accept.`;
  if (r.state === 'live' || r.state === 'ended' || r.state === 'scored' || r.state === 'reviewed') return 'This round has started, so its plan is fixed.';
  if (r.state === 'declined' || r.state === 'cancelled') return 'This round is no longer going ahead.';
  return `${r.lead.name} chooses the questions for this round.`;
}

function Competencies({ record }: { record: InterviewRecord }) {
  if (!record.competencies.length) return <EmptyState title="No competencies yet" description="The recruiter adds what each round judges in the opening's kit." />;
  return (
    <Stack gap="md" data-testid="interviews-prepare-competencies">
      {record.competencies.map((c) => (
        <DetailSection key={c.id} variant="heading" as="h2" title={c.name} hint={c.lookFor}>
          <Stack gap="xs">
            {([1, 2, 3, 4] as const).map((n) => <T key={n} size="sm" tone="secondary">{`${n}. ${c.anchors[n]}`}</T>)}
          </Stack>
        </DetailSection>
      ))}
    </Stack>
  );
}
