// /interviews/openings/:id and /interviews/openings/:id/edit — one opening (docs/interviews-tenant-plan.md
// "Pages", rows I1.3 and I1.8): its details, its kit (rounds, competencies, questions) and its candidates.
// Everyone who may read the opening (the recruiter, its hiring manager, an interviewer with a round on it)
// reads it here; only the recruiter edits, on /edit. The recruiter, the hiring manager and the admin also see the
// opening's money in one line under its details (row I0.6); an interviewer sees none. Saving and discarding are asked in the composer's
// prompt deck, never a dialog; the server checks the kit and answers each problem on its field, and a save
// made against an older revision is refused rather than overwriting someone else's (409).

import {
  Button, Chip, CodeEditor, DataTable, DetailPage, DetailSection, EmptyState, Inline, MetaLine, Stack, T, type BreadcrumbItem, type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { INTERVIEWS_API, ROUND_TYPE_LABELS, byStageLine, nextInterviewLine, type PipelineEntry, type RoundType } from '../../lib/interviews';
import {
  OPENING_STATE_LABELS, PAD_LANGUAGES, PAD_LANGUAGE_LABELS, changesLine, detailsChanged, detailsOf, kitChanges, kitOf, padLine, problemsByPath,
  moneyLine, openingMoneyPath, readsOpeningMoney, saveDetails, saveKit, starterLine, type OpeningMoney, type KitCompetency, type KitQuestion, type KitRound, type OpeningDetails, type OpeningKit, type OpeningRecord,
} from '../../lib/interviewsKit';
import { Dash, PersonCell, ResultChip, StageChip } from './interviewsCells';
import { KitEditor, type OpenRow } from './KitEditor';
import { OpeningDetailsForm } from './OpeningDetailsForm';

const stateTone = (s: OpeningRecord['state']) => (s === 'open' ? 'success' : s === 'paused' ? 'caution' : 'neutral');

export default function OpeningPage({ editing = false }: { editing?: boolean }) {
  const { id = '' } = useParams();
  const { session } = useSession();
  // Flush: the page's own header draws the one trail, with the opening's title on it (Breadcrumbs.tsx).
  return (
    <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
      <OpeningWorkspace key={`${id}:${session?.sub}:${session?.role}:${editing}`} id={id} editing={editing} />
    </Stack>
  );
}

/** The shell's trail (Hire › Openings) with the opening, and "Edit kit" on the editor, after it. */
function useOpeningTrail(o: OpeningRecord | null, editing: boolean): BreadcrumbItem[] | undefined {
  const base = useFlushTrailItems();
  const navigate = useNavigate();
  return useMemo(() => {
    if (!base || !o) return base;
    const link = (label: string, href: string): BreadcrumbItem => ({
      label, href, onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); void navigate(href); },
    });
    const head = base.slice(0, -1);
    const openings = link(base[base.length - 1]?.label ?? 'Openings', '/interviews/openings');
    return editing
      ? [...head, openings, link(o.title, `/interviews/openings/${encodeURIComponent(o.id)}`), { label: 'Edit' }]
      : [...head, openings, { label: o.title }];
  }, [base, o, editing, navigate]);
}

function OpeningWorkspace({ id, editing }: { id: string; editing: boolean }) {
  const { data, error, failure, refresh } = useFetch<{ opening: OpeningRecord }>(`${INTERVIEWS_API}/openings/${encodeURIComponent(id)}`);
  const { session } = useSession();
  const seesMoney = readsOpeningMoney(session?.role);
  // An interviewer never asks: the server would answer not-found, and the page shows no money.
  const money = useFetch<{ spend: OpeningMoney }>(seesMoney ? openingMoneyPath(id) : null);
  const spend = money.data?.spend ?? null;
  const o = data?.opening ?? null;
  const trail = useOpeningTrail(o, editing);
  if (failure?.status === 404) {
    return <EmptyState testId="interviews-opening-missing" title="There is no opening here that you can open"
      description="It may have been removed, or it belongs to someone else's hiring." />;
  }
  if (error && !o) return <UnavailableNotice error={error} what="this opening" source="Openings are read from the interviews tenant" onRetry={refresh} />;
  // The editor starts its draft from the money too (the cap per interview), so it waits for it.
  if (!o || (editing && seesMoney && !spend && !money.error)) return <DetailPage title="Opening" breadcrumbs={trail}><T size="sm" tone="tertiary">Loading the opening…</T></DetailPage>;
  const refreshAll = () => { refresh(); money.refresh(); };
  return editing
    ? <OpeningEditor opening={o} money={spend} trail={trail} onSaved={refreshAll} />
    : <OpeningView opening={o} money={spend} trail={trail} />;
}

function OpeningMeta({ o, money }: { o: OpeningRecord; money?: OpeningMoney | null }) {
  const people = <MetaLine size="sm" data-testid="interviews-opening-meta" items={[
    o.team, o.level, o.location, o.hiringManager ? `Hiring manager ${o.hiringManager.name}` : 'No hiring manager named yet', `Recruiter ${o.recruiter.name}`,
  ]} />;
  if (!money) return people;
  return (
    <Stack gap="xs">
      {people}
      <MetaLine size="sm" data-testid="interviews-opening-money" items={moneyLine(money)} />
    </Stack>
  );
}

// ── reading ──────────────────────────────────────────────────────────────────

function OpeningView({ opening: o, money, trail }: { opening: OpeningRecord; money: OpeningMoney | null; trail: BreadcrumbItem[] | undefined }) {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const editable = can('ManageCandidates');
  return (
    <DetailPage data-testid="interviews-opening" title={o.title} breadcrumbs={trail}
      badge={<Chip tone={stateTone(o.state)} size="xs">{OPENING_STATE_LABELS[o.state]}</Chip>}
      meta={<OpeningMeta o={o} money={money} />}
      actions={editable
        ? <Button size="sm" variant="secondary" data-testid="interviews-opening-edit" onClick={() => void navigate(`/interviews/openings/${encodeURIComponent(o.id)}/edit`)}>Edit kit</Button>
        : <T size="xs" tone="tertiary" data-testid="interviews-opening-readonly">Read only: the recruiter edits this kit.</T>}
      tabs={[
        { id: 'kit', label: 'Kit', testId: 'interviews-opening-tab-kit', content: <KitView o={o} /> },
        { id: 'candidates', label: 'Candidates', badge: o.candidates || undefined, testId: 'interviews-opening-tab-candidates', content: <Pipeline o={o} /> },
      ]} />
  );
}

function KitView({ o }: { o: OpeningRecord }) {
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const names = new Map(o.competencies.map((c) => [c.id, c.name]));
  const probes = (id: string) => o.questions.filter((q) => q.competencyId === id).length;
  const roundColumns: DataTableColumn<KitRound>[] = [
    { key: 'name', header: 'Round', render: (r) => <T size="sm" weight="medium">{r.name}</T> },
    { key: 'type', header: 'Type', render: (r) => <T size="sm">{ROUND_TYPE_LABELS[r.type]}</T> },
    { key: 'minutes', header: 'Length', numeric: true, render: (r) => <T size="sm">{r.minutes} min</T> },
    { key: 'pad', header: 'Code pad', render: (r) => <T size="sm" tone={r.type === 'technical' ? 'primary' : 'tertiary'} data-testid="interviews-round-pad">{padLine(r.type)}</T> },
  ];
  const competencyColumns: DataTableColumn<KitCompetency>[] = [
    { key: 'name', header: 'Competency', render: (c) => <T size="sm" weight="medium" className="block max-w-[14rem] truncate">{c.name}</T> },
    { key: 'lookFor', header: 'What good looks like', render: (c) => <T size="sm" tone="secondary" title={c.lookFor} className="block max-w-[36rem] truncate">{c.lookFor}</T> },
    { key: 'questions', header: 'Questions', numeric: true, render: (c) => <T size="sm">{probes(c.id)}</T> },
  ];
  const questionColumns: DataTableColumn<KitQuestion>[] = [
    { key: 'prompt', header: 'Question', render: (q) => <T size="sm" title={q.prompt} className="block max-w-[30rem] truncate" data-testid="interviews-question-prompt">{q.prompt}</T> },
    { key: 'competency', header: 'Competency', render: (q) => <T size="sm" className="block max-w-[12rem] truncate">{names.get(q.competencyId) ?? '—'}</T> },
    { key: 'followUps', header: 'Follow-ups', numeric: true, render: (q) => <T size="sm">{q.followUps.length}</T> },
    { key: 'starter', header: 'Starter code', render: (q) => (starterLine(q) ? <T size="sm">{starterLine(q)}</T> : <Dash />) },
  ];
  const byType = (t: RoundType) => o.questions.filter((q) => q.roundType === t);
  const kinds = (['technical', 'behavioural'] as const).filter((t) => byType(t).length > 0 || o.rounds.some((r) => r.type === t));
  if (!o.rounds.length && !o.competencies.length) {
    return <EmptyState testId="interviews-kit-empty" title="No kit yet" description="The recruiter adds the rounds, the competencies they judge and the questions to choose from." />;
  }
  return (
    <Stack gap="lg" className="pb-6" data-testid="interviews-kit-view">
      <DetailSection title="Rounds" as="h2" hint={String(o.rounds.length)} first>
        <DataTable narrow aria-label="Rounds" data={o.rounds} columns={roundColumns} keyField={(r) => r.id} data-testid="interviews-kit-rounds" />
      </DetailSection>
      <DetailSection title="Competencies" as="h2" hint={String(o.competencies.length)}>
        <DataTable narrow aria-label="Competencies" data={o.competencies} columns={competencyColumns} keyField={(c) => c.id} data-testid="interviews-kit-competencies" />
      </DetailSection>
      {kinds.map((t) => {
        const qs = byType(t);
        const open = qs.find((q) => q.id === openQuestion) ?? null;
        return (
          <DetailSection key={t} title={`${ROUND_TYPE_LABELS[t]} questions`} as="h2" hint={String(qs.length)}>
            <Stack gap="sm">
              <DataTable narrow aria-label={`${ROUND_TYPE_LABELS[t]} questions`} data={qs} columns={questionColumns} keyField={(q) => q.id}
                data-testid={`interviews-kit-${t}-questions`} selectedKey={open?.id ?? null}
                onRowClick={(q) => setOpenQuestion(openQuestion === q.id ? null : q.id)}
                emptyMessage={`No ${t} questions yet.`} />
              {open && <QuestionDetail q={open} competency={names.get(open.competencyId) ?? ''} />}
            </Stack>
          </DetailSection>
        );
      })}
    </Stack>
  );
}

/** A question opened from the read-only kit: the words, the follow-ups and any starter code. */
function QuestionDetail({ q, competency }: { q: KitQuestion; competency: string }) {
  const langs = PAD_LANGUAGES.filter((l) => q.starter?.[l] !== undefined);
  return (
    <Stack gap="sm" className="rounded-md border border-border p-3" data-testid="interviews-question-detail">
      <T size="sm" weight="medium">{q.prompt}</T>
      <MetaLine size="sm" items={[`${ROUND_TYPE_LABELS[q.roundType]} round`, `Gathers evidence for ${competency}`]} />
      {q.followUps.length > 0 && (
        <Stack gap="xs">
          <T size="xs" weight="semibold" tone="secondary">Follow-ups</T>
          {q.followUps.map((f, i) => <T key={i} size="sm">{`${i + 1}. ${f}`}</T>)}
        </Stack>
      )}
      {langs.map((l) => (
        <Stack key={l} gap="xs">
          <T size="xs" weight="semibold" tone="secondary">{`${PAD_LANGUAGE_LABELS[l]} starter code`}</T>
          <CodeEditor value={q.starter![l]!} onChange={() => undefined} readOnly language="plain" minLines={3} maxLines={12} aria-label={`${PAD_LANGUAGE_LABELS[l]} starter code`} />
        </Stack>
      ))}
    </Stack>
  );
}

function Pipeline({ o }: { o: OpeningRecord }) {
  const columns: DataTableColumn<PipelineEntry>[] = [
    { key: 'candidate', header: 'Candidate', render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline}`} /> },
    { key: 'stage', header: 'Stage', width: '152px', render: (r) => <StageChip stage={r.stage} /> },
    { key: 'next', header: 'Next interview', render: (r) => (r.nextInterview ? <T size="sm" className="block max-w-[16rem] truncate">{nextInterviewLine(r.nextInterview)}</T> : <Dash />) },
    { key: 'result', header: 'Last result', width: '176px', render: (r) => <ResultChip result={r.lastResult} due={r.scorecardDue} /> },
  ];
  return (
    <Stack gap="sm" className="pb-6">
      {o.candidates > 0 && <T size="xs" tone="secondary">{byStageLine(o.byStage)}</T>}
      <DataTable narrow aria-label="Candidates" data={o.pipeline} columns={columns} keyField={(r) => r.applicationId}
        data-testid="interviews-opening-pipeline" emptyMessage="No candidates on this opening yet." />
    </Stack>
  );
}

// ── editing (the recruiter) ──────────────────────────────────────────────────

type Ask = { kind: 'save' | 'discard' | 'close'; n: number };

function OpeningEditor({ opening, money, trail, onSaved }: { opening: OpeningRecord; money: OpeningMoney | null; trail: BreadcrumbItem[] | undefined; onSaved: () => void }) {
  const navigate = useNavigate();
  // The record the draft was started from: its revision is what a save is made against, whatever a refresh reads later.
  const [base, setBase] = useState(opening);
  const [kit, setKit] = useState<OpeningKit>(() => kitOf(opening));
  // The cap per interview the draft was started from: the record does not carry it, the opening's money does.
  const [baseCap, setBaseCap] = useState<number | null>(money?.interviewCapUsd ?? null);
  const [details, setDetails] = useState<OpeningDetails>(() => detailsOf(opening, money?.interviewCapUsd ?? null));
  const [problems, setProblems] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState<OpenRow | null>(null);
  const [tab, setTab] = useState('kit');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [asked, setAsked] = useState(0);
  const view = `/interviews/openings/${encodeURIComponent(base.id)}`;

  const kitDiff = kitChanges(kitOf(base), kit);
  const detailsDiff = detailsChanged(detailsOf(base, baseCap), details);
  const changes = changesLine(kitDiff, detailsDiff);
  const raise = (kind: Ask['kind']) => { setAsk({ kind, n: asked + 1 }); setAsked(asked + 1); };

  /** Put the server's problems on their fields, and open the tab and the row the first one is on. */
  const showProblems = (fields: Array<{ path: string; message: string }>, where: 'kit' | 'details') => {
    setProblems(problemsByPath(fields));
    setTab(where);
    const first = fields.map((f) => /^(competencies|questions)\.(\d+)\./.exec(f.path)).find(Boolean);
    if (first) {
      const list = first[1] as OpenRow['list'];
      const item = kit[list][Number(first[2])];
      if (item) setOpen({ list, id: item.id });
    }
  };

  const save = async (): Promise<{ error: string } | { receipt: string }> => {
    let latest = base;
    if (detailsDiff) {
      const r = await saveDetails(base.id, latest.revision, details);
      if (!r.ok) { showProblems(r.fields, 'details'); return { error: r.error }; }
      latest = r.opening;
      setBase(latest);
      setBaseCap(details.interviewCapUsd);
    }
    if (kitDiff.length) {
      const r = await saveKit(base.id, latest.revision, kit);
      if (!r.ok) { showProblems(r.fields, 'kit'); return { error: detailsDiff ? `The details were saved. ${r.error}` : r.error }; }
      latest = r.opening;
    }
    setBase(latest);
    setKit(kitOf(latest));
    setDetails(detailsOf(latest, detailsDiff ? details.interviewCapUsd : baseCap));
    setProblems(new Map());
    setAsk(null);
    onSaved();
    return { receipt: 'Saved. Everyone who reads this opening sees the new kit now.' };
  };

  const discard = (thenClose: boolean) => {
    setKit(kitOf(base));
    setDetails(detailsOf(base, baseCap));
    setProblems(new Map());
    setOpen(null);
    setAsk(null);
    if (thenClose) void navigate(view);
  };

  const prompts = useMemo<ComposerPrompt[]>(() => {
    if (!ask) return [];
    const scope = `interviews-opening:${base.id}`;
    const fields = changes ? [{ label: 'Changes', value: changes }] : [];
    if (ask.kind === 'save') {
      return [{
        id: `${scope}:save-${ask.n}`, scope, kind: 'choice', eyebrow: 'Save the kit', title: base.title, fields,
        question: 'Save these changes? Interviews already arranged keep the questions chosen for them.',
        options: [{ id: 'save', label: 'Save', emphasis: 'primary' }, { id: 'keep', label: 'Keep editing' }],
        onAnswer: async (a) => {
          if (!('optionId' in a) || a.optionId !== 'save') { setAsk(null); return { receipt: 'Still editing. Nothing was saved.' }; }
          return save();
        },
      }];
    }
    const closing = ask.kind === 'close';
    return [{
      id: `${scope}:discard-${ask.n}`, scope, kind: 'choice', eyebrow: closing ? 'Leave the editor' : 'Discard changes', title: base.title, fields,
      question: closing ? 'Leave without saving? Your changes to this opening will be lost.' : 'Discard your changes? The kit goes back to how it was last saved.',
      options: [
        { id: 'discard', label: closing ? 'Leave and discard' : 'Discard changes', emphasis: 'danger' },
        { id: 'keep', label: 'Keep editing', emphasis: 'primary' },
      ],
      onAnswer: async (a) => {
        if (!('optionId' in a) || a.optionId !== 'discard') { setAsk(null); return { receipt: 'Still editing.' }; }
        discard(closing);
        return { receipt: 'Changes discarded.' };
      },
    }];
  }, [ask, base, kit, details, changes]);

  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'opening' }, {
    id: 'interviews-opening-commands', label: 'Opening', placeholder: 'Refresh this opening…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: onSaved,
    scopeNote: 'Refresh reloads the saved opening. Saving and discarding the kit are asked here and never done by a typed command.',
  }), [onSaved]);

  return (
    <>
      <DetailPage data-testid="interviews-opening-editor" title={base.title} breadcrumbs={trail}
        badge={<Chip tone={changes ? 'caution' : 'neutral'} size="xs">{changes ? 'Unsaved changes' : 'Saved'}</Chip>}
        meta={<OpeningMeta o={base} money={money} />}
        actions={(
          <Inline gap="xs" wrap={false}>
            <Button size="sm" variant="ghost" data-testid="interviews-opening-close" onClick={() => (changes ? raise('close') : void navigate(view))}>Close</Button>
            <Button size="sm" variant="secondary" data-testid="interviews-opening-discard" disabled={!changes} onClick={() => raise('discard')}>Discard…</Button>
            <Button size="sm" variant="primary" data-testid="interviews-opening-save" disabled={!changes} onClick={() => raise('save')}>Save…</Button>
          </Inline>
        )}
        activeTab={tab} onTabChange={setTab}
        tabs={[
          { id: 'kit', label: 'Kit', testId: 'interviews-opening-tab-kit', badge: kitDiff.length ? '•' : undefined,
            content: <KitEditor kit={kit} onChange={setKit} problems={problems} open={open} onOpen={setOpen} /> },
          { id: 'details', label: 'Details', testId: 'interviews-opening-tab-details', badge: detailsDiff ? '•' : undefined,
            content: <OpeningDetailsForm details={details} onChange={setDetails} problems={problems} defaultInterviewCapUsd={money?.defaultInterviewCapUsd} /> },
        ]} />
      <CollectionCommandHost adapter={adapter} prompts={prompts} />
    </>
  );
}
