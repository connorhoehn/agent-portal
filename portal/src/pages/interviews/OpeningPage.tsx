// /interviews/openings/:id and /interviews/openings/:id/edit — one opening (docs/interviews-tenant-plan.md
// "Pages", rows I1.3 and I1.8): its details, its kit (rounds, competencies, questions) and its candidates.
// Everyone who may read the opening (the recruiter, its hiring manager, an interviewer with a round on it)
// reads it here; only the recruiter edits, on /edit. The recruiter, the hiring manager and the admin also see the
// opening's money in one line under its details (row I0.6); an interviewer sees none. Saving and discarding are asked in the composer's
// prompt deck, never a dialog; the server checks the kit and answers each problem on its field, and a save
// made against an older revision is refused rather than overwriting someone else's (409).

import {
  Button, Chip, CodeEditor, DataTable, DetailPage, DetailSection, EmptyState, Inline, MetaLine, Stack, T, Tabs, type BreadcrumbItem, type DataTableColumn, type DetailPageTab,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { openingRail } from '../../lib/interviewsOpenings';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { INTERVIEWS_API, ROUND_TYPE_LABELS, byStageLine, candidateHref, type ItemsResponse, nextInterviewLine, type PipelineEntry, type RoundType } from '../../lib/interviews';
import {
  OPENING_STATE_LABELS, PAD_LANGUAGES, PAD_LANGUAGE_LABELS, changesLine, detailsChanged, detailsOf, kitChanges, kitOf, padLine, problemsByPath,
  moneyLine, openingMoneyPath, readsOpeningMoney, saveDetails, saveKit, starterLine, type OpeningMoney, type KitCompetency, type KitQuestion, type KitRound, type OpeningDetails, type OpeningKit, type OpeningRecord, type OpeningListRow,
} from '../../lib/interviewsKit';
import { Dash, NoHiringManagerAlert, PersonCell, ResultChip, StageChip } from './interviewsCells';
import { KitEditor, type OpenRow } from './KitEditor';
import { OpeningDetailsForm } from './OpeningDetailsForm';

const stateTone = (s: OpeningRecord['state']) => (s === 'open' ? 'success' : s === 'paused' ? 'caution' : 'neutral');

interface RailModel { rows: OpeningListRow[]; query: string; setQuery: (q: string) => void; loading: boolean; error: string | null; retry: () => void }
/** The openings the viewer may see, as the list rail beside an open opening; null for an interviewer, who has no Openings list. */
const RailContext = createContext<RailModel | null>(null);

/**
 * The opening as a record: beside the list rail the frame's header carries the opening's name, its state and its
 * actions as the page's one title (the list's name and tagline are in the rail and the trail), so what is left here is
 * its facts and its tabs; on its own it is the library's DetailPage.
 */
function OpeningHeadTabs({ testId, title, badge, meta, actions, trail, tabs, activeTab, onTabChange }: {
  testId: string; title: string; badge: ReactNode; meta: ReactNode; actions: ReactNode; trail: BreadcrumbItem[] | undefined;
  tabs: DetailPageTab[]; activeTab?: string; onTabChange?: (id: string) => void;
}) {
  const framed = useContext(RailContext) !== null;
  const [own, setOwn] = useState(tabs[0]!.id);
  const current = activeTab ?? own;
  if (!framed) {
    return <DetailPage data-testid={testId} title={title} breadcrumbs={trail} badge={badge} meta={meta} actions={actions}
      {...(onTabChange ? { activeTab: current, onTabChange } : {})} tabs={tabs} />;
  }
  return (
    <Stack gap="md" data-testid={testId}>
      {meta}
      <Tabs idPrefix={testId} aria-label={`${title} sections`} variant="underline" size="sm" value={current}
        onValueChange={(v) => (onTabChange ?? setOwn)(v)} getItemTestId={(i) => tabs.find((t) => t.id === i.id)?.testId ?? `${testId}-tab-${i.id}`}
        items={tabs.map(({ id, label, badge: b }) => ({ id, label, ...(b !== undefined ? { badge: b } : {}) }))} />
      {tabs.find((t) => t.id === current)?.content}
    </Stack>
  );
}

export default function OpeningPage({ editing = false }: { editing?: boolean }) {
  const { id = '' } = useParams();
  const { session } = useSession();
  const lists = (session?.role as string | undefined) !== 'interviewer';
  const list = useFetch<ItemsResponse<OpeningListRow>>(lists ? `${INTERVIEWS_API}/openings` : null, 30_000);
  const [query, setQuery] = useState('');
  const rail = useMemo<RailModel | null>(() => (lists
    ? { rows: list.data?.items ?? [], query, setQuery, loading: list.isLoading && !list.data, error: list.error ? String(list.error) : null, retry: list.refresh }
    : null), [lists, list.data, list.isLoading, list.error, list.refresh, query]);
  return (
    <RailContext.Provider value={rail}>
      {rail ? <OpeningWorkspace key={`${id}:${session?.sub}:${session?.role}:${editing}`} id={id} editing={editing} />
        // An interviewer keeps the page alone: Flush, the page's own header draws the one trail (Breadcrumbs.tsx).
        : <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
          <OpeningWorkspace key={`${id}:${session?.sub}:${session?.role}:${editing}`} id={id} editing={editing} />
        </Stack>}
    </RailContext.Provider>
  );
}

/** The opening inside the Openings list rail (the frame draws the one trail); without a rail, the page and its footer as they were. */
function OpeningFrame({ id, title, head, guard, footer, children }: { id: string; title: string | null; head?: { badge?: ReactNode; actions?: ReactNode }; guard?: (to: string) => boolean; footer?: ReactNode; children: ReactNode }) {
  const rail = useContext(RailContext);
  const navigate = useNavigate();
  useCrumbLabel(rail ? id : undefined, title);
  if (!rail) return <>{children}{footer}</>;
  const model = openingRail(rail.rows, rail.query);
  return (
    <CollectionRecordFrame title={title ?? 'Openings'} {...(head?.badge ? { badge: head.badge } : {})} {...(head?.actions ? { actions: head.actions } : {})} listTitle="Openings" listLabel="openings" data-testid="interviews-opening-frame"
      {...(rail.loading ? {} : { count: rail.rows.length })}
      search={{ value: rail.query, onChange: rail.setQuery, placeholder: 'Find an opening' }}
      groups={model.groups} rows={model.rows} currentId={id}
      onOpen={(to) => { const href = `/interviews/openings/${encodeURIComponent(to)}`; if (!guard?.(href)) void navigate(href); }}
      loading={rail.loading} error={rail.error} onRetry={rail.retry} footer={footer} railType="app">
      {children}
    </CollectionRecordFrame>
  );
}

/** The shell's trail (Hire › Openings) with the opening, and "Edit kit" on the editor, after it. */
function useOpeningTrail(o: OpeningRecord | null, editing: boolean): BreadcrumbItem[] | undefined {
  const flush = useFlushTrailItems();
  // Beside the Openings rail the frame draws the one trail, with the opening's title registered under its id.
  const base = useContext(RailContext) ? undefined : flush;
  const navigate = useNavigate();
  return useMemo(() => {
    if (!base || !o) return base;
    const link = (label: string, href: string): BreadcrumbItem => ({
      label, href, onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); void navigate(href); },
    });
    const head = base.slice(0, 1);
    const openings = link('Openings', '/interviews/openings');
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
    return <OpeningFrame id={id} title={null}><EmptyState testId="interviews-opening-missing" title="There is no opening here that you can open"
      description="It may have been removed, or it belongs to someone else's hiring." /></OpeningFrame>;
  }
  if (error && !o) return <OpeningFrame id={id} title={null}><UnavailableNotice error={error} what="this opening" source="Openings are read from the interviews tenant" onRetry={refresh} /></OpeningFrame>;
  // The editor starts its draft from the money too (the cap per interview), so it waits for it.
  if (!o || (editing && seesMoney && !spend && !money.error)) return <OpeningFrame id={id} title={null}><DetailPage title="Opening" breadcrumbs={trail}><T size="sm" tone="tertiary">Loading the opening…</T></DetailPage></OpeningFrame>;
  const refreshAll = () => { refresh(); money.refresh(); };
  return editing
    ? <OpeningEditor opening={o} money={spend} trail={trail} onSaved={refreshAll} />
    : <OpeningView opening={o} money={spend} trail={trail} />;
}

function OpeningMeta({ o, money, canEdit = false, inEditor = false }: { o: OpeningRecord; money?: OpeningMoney | null; canEdit?: boolean; inEditor?: boolean }) {
  const people = <MetaLine size="sm" data-testid="interviews-opening-meta" items={[
    o.team, o.level, o.location, o.hiringManager ? `Hiring manager ${o.hiringManager.name}` : 'No hiring manager named yet', `Recruiter ${o.recruiter.name}`,
  ]} />;
  const warning = o.hiringManager ? null : <NoHiringManagerAlert openingId={o.id} canEdit={canEdit} linked={!inEditor} />;
  if (!money && !warning) return people;
  return (
    <Stack gap="xs">
      {people}
      {money && <MetaLine size="sm" data-testid="interviews-opening-money" items={moneyLine(money)} />}
      {warning}
    </Stack>
  );
}

// ── reading ──────────────────────────────────────────────────────────────────

function OpeningView({ opening: o, money, trail }: { opening: OpeningRecord; money: OpeningMoney | null; trail: BreadcrumbItem[] | undefined }) {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const editable = can('ManageCandidates');
  const badge = <Chip tone={stateTone(o.state)} size="sm">{OPENING_STATE_LABELS[o.state]}</Chip>;
  const actions = editable
    ? <Button size="sm" variant="secondary" data-testid="interviews-opening-edit" onClick={() => void navigate(`/interviews/openings/${encodeURIComponent(o.id)}/edit`)}>Edit kit</Button>
    : <T size="xs" tone="tertiary" data-testid="interviews-opening-readonly">Read only: the recruiter edits this kit.</T>;
  return (
    <OpeningFrame id={o.id} title={o.title} head={{ badge, actions }}>
    <OpeningHeadTabs testId="interviews-opening" title={o.title} trail={trail}
      badge={badge}
      meta={<OpeningMeta o={o} money={money} canEdit={editable} />}
      actions={actions}
      tabs={[
        { id: 'kit', label: 'Kit', testId: 'interviews-opening-tab-kit', content: <KitView o={o} /> },
        { id: 'candidates', label: 'Candidates', badge: o.candidates || undefined, testId: 'interviews-opening-tab-candidates', content: <Pipeline o={o} /> },
      ]} />
    </OpeningFrame>
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
    { key: 'assesses', header: 'Assesses', render: (r) => (
      <T size="sm" wrap data-testid="interviews-round-assesses">{r.competencyIds.map((id) => names.get(id)).filter(Boolean).join(', ') || '—'}</T>
    ) },
    { key: 'pad', header: 'Code pad', render: (r) => <T size="sm" tone={r.type === 'technical' ? 'primary' : 'tertiary'} data-testid="interviews-round-pad">{padLine(r.type)}</T> },
  ];
  const competencyColumns: DataTableColumn<KitCompetency>[] = [
    { key: 'name', header: 'Competency', render: (c) => <T size="sm" weight="medium" className="block max-w-[14rem] truncate">{c.name}</T> },
    { key: 'lookFor', header: 'What good looks like', render: (c) => <T size="sm" tone="secondary" title={c.lookFor} wrap>{c.lookFor}</T> },
    { key: 'questions', header: 'Questions', numeric: true, render: (c) => <T size="sm">{probes(c.id)}</T> },
  ];
  const questionColumns: DataTableColumn<KitQuestion>[] = [
    { key: 'prompt', header: 'Question', render: (q) => <T size="sm" title={q.prompt} wrap data-testid="interviews-question-prompt">{q.prompt}</T> },
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
        <DataTable narrow aria-label="Rounds" data={o.rounds} columns={roundColumns} keyField={(r) => r.id} data-testid="interviews-kit-rounds" staticRows="Each round of the kit, read in place" />
      </DetailSection>
      <DetailSection title="Competencies" as="h2" hint={String(o.competencies.length)}>
        <DataTable narrow rowHeight="content" aria-label="Competencies" data={o.competencies} columns={competencyColumns} keyField={(c) => c.id} data-testid="interviews-kit-competencies" staticRows="Each competency of the kit, read in place" />
      </DetailSection>
      <DetailSection title="Questions" as="h2" hint={String(o.questions.length)}>
        <Stack gap="md">
          {kinds.map((t) => {
            const qs = byType(t);
            const open = qs.find((q) => q.id === openQuestion) ?? null;
            return (
              <DetailSection key={t} title={`${ROUND_TYPE_LABELS[t]} questions`} as="h3" hint={String(qs.length)} first>
                <Stack gap="sm">
                  <DataTable narrow rowHeight="content" aria-label={`${ROUND_TYPE_LABELS[t]} questions`} data={qs} columns={questionColumns} keyField={(q) => q.id}
                    data-testid={`interviews-kit-${t}-questions`} selectedKey={open?.id ?? null}
                    onRowClick={(q) => setOpenQuestion(openQuestion === q.id ? null : q.id)}
                    emptyMessage={`No ${t} questions yet.`} />
                  {open && <QuestionDetail q={open} competency={names.get(open.competencyId) ?? ''} />}
                </Stack>
              </DetailSection>
            );
          })}
        </Stack>
      </DetailSection>
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
    { key: 'candidate', header: 'Candidate', render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline}`} to={candidateHref(r.candidate.id)} /> },
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

  // A click on another opening in the rail asks the same question as Close, then goes where it was pointed.
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const guard = (to: string): boolean => { if (!changes) return false; setLeaveTo(to); raise('close'); return true; };

  const discard = (thenClose: boolean) => {
    setKit(kitOf(base));
    setDetails(detailsOf(base, baseCap));
    setProblems(new Map());
    setOpen(null);
    setAsk(null);
    if (thenClose) void navigate(leaveTo ?? view);
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
        if (!('optionId' in a) || a.optionId !== 'discard') { setAsk(null); setLeaveTo(null); return { receipt: 'Still editing.' }; }
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

  const badge = <Chip tone={changes ? 'caution' : 'neutral'} size="sm">{changes ? 'Unsaved changes' : 'Saved'}</Chip>;
  const actions = (
    <Inline gap="xs" wrap={false}>
      <Button size="sm" variant="ghost" data-testid="interviews-opening-close" onClick={() => (changes ? raise('close') : void navigate(view))}>Close</Button>
      <Button size="sm" variant="secondary" data-testid="interviews-opening-discard" disabled={!changes} onClick={() => raise('discard')}>Discard…</Button>
      <Button size="sm" variant="primary" data-testid="interviews-opening-save" disabled={!changes} onClick={() => raise('save')}>Save…</Button>
    </Inline>
  );
  return (
    <OpeningFrame id={base.id} title={base.title} head={{ badge, actions }} guard={guard} footer={<CollectionCommandHost adapter={adapter} prompts={prompts} />}>
      <OpeningHeadTabs testId="interviews-opening-editor" title={base.title} trail={trail}
        badge={badge}
        meta={<OpeningMeta o={base} money={money} canEdit inEditor />}
        actions={actions}
        activeTab={tab} onTabChange={setTab}
        tabs={[
          { id: 'kit', label: 'Kit', testId: 'interviews-opening-tab-kit', badge: kitDiff.length ? '•' : undefined,
            content: <KitEditor kit={kit} onChange={setKit} problems={problems} open={open} onOpen={setOpen} /> },
          { id: 'details', label: 'Details', testId: 'interviews-opening-tab-details', badge: detailsDiff ? '•' : undefined,
            content: <OpeningDetailsForm details={details} onChange={setDetails} problems={problems} defaultInterviewCapUsd={money?.defaultInterviewCapUsd} /> },
        ]} />
    </OpeningFrame>
  );
}
