// The kit editor (docs/interviews-tenant-plan.md row I1.3; row I1.8 for behavioural rounds): rounds edited in
// their table, competencies and questions as tables whose open row's form sits under the table. Adding,
// editing, removing and moving each item; a technical question's starter code per pad language in the
// library's code field (the collaborative pad lands later, I4.1). Controlled: the opening page holds the
// draft, the problems the server answered (one sentence per field path) and which row is open, and asks
// before saving or discarding (OpeningPage.tsx).

import {
  Button, ChevronIcon, Chip, CodeEditor, DataTable, DetailSection, EditIcon, FormField, IconButton, Inline, Input, NumberInput, Select,
  Stack, T, Textarea, TrashIcon, type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import type { ReactNode } from 'react';
import { ROUND_TYPE_LABELS, type RoundType } from '../../lib/interviews';
import {
  PAD_LANGUAGES, PAD_LANGUAGE_LABELS, blankCompetency, blankQuestion, blankRound, moved, newId, padLine, roundHasPad, rowsWithProblems, starterLine,
  type KitCompetency, type KitQuestion, type KitRound, type OpeningKit, type PadLanguage,
} from '../../lib/interviewsKit';

export type KitList = 'competencies' | 'questions';
export interface OpenRow { list: KitList; id: string }

interface Props {
  kit: OpeningKit;
  onChange: (kit: OpeningKit) => void;
  problems: ReadonlyMap<string, string>;
  open: OpenRow | null;
  onOpen: (row: OpenRow | null) => void;
}

const allIds = (kit: OpeningKit) => new Set([...kit.rounds, ...kit.competencies, ...kit.questions].map((x) => x.id));
const ROUND_OPTIONS = (['technical', 'behavioural'] as const).map((t) => ({ value: t, label: ROUND_TYPE_LABELS[t] }));

/** Move, open and remove: the row's own controls, labelled for the row. */
function RowControls({ what, index, count, onMove, onEdit, onRemove, removeBlocked }: {
  what: string; index: number; count: number; onMove: (delta: -1 | 1) => void; onEdit?: () => void; onRemove: () => void; removeBlocked?: string;
}) {
  return (
    <Inline gap="xs" wrap={false} justify="end">
      {onEdit && <IconButton size="sm" variant="ghost" aria-label={`Edit ${what}`} icon={<EditIcon size={14} />} onClick={(e) => { e.stopPropagation(); onEdit(); }} />}
      <IconButton size="sm" variant="ghost" aria-label={`Move ${what} up`} icon={<ChevronIcon dir="up" size={14} />} disabled={index === 0}
        onClick={(e) => { e.stopPropagation(); onMove(-1); }} />
      <IconButton size="sm" variant="ghost" aria-label={`Move ${what} down`} icon={<ChevronIcon dir="down" size={14} />} disabled={index === count - 1}
        onClick={(e) => { e.stopPropagation(); onMove(1); }} />
      <IconButton size="sm" variant="ghost" aria-label={`Remove ${what}`} title={removeBlocked} icon={<TrashIcon size={14} />} disabled={!!removeBlocked}
        onClick={(e) => { e.stopPropagation(); onRemove(); }} />
    </Inline>
  );
}

/** The list's own problems (too many, a removal refused), one line each. */
function ListProblems({ problems, list }: { problems: ReadonlyMap<string, string>; list: string }) {
  const lines = [...problems.entries()].filter(([p]) => p === list || (list === 'rounds' && p.startsWith('rounds.')));
  if (!lines.length) return null;
  return <Stack gap="xs" data-testid={`interviews-kit-${list}-problems`}>{lines.map(([p, m]) => <T key={p} size="xs" tone="danger">{m}</T>)}</Stack>;
}

const NeedsFixing = () => <Chip tone="danger" size="xs">Needs fixing</Chip>;

export function KitEditor({ kit, onChange, problems, open, onOpen }: Props) {
  const set = (patch: Partial<OpeningKit>) => onChange({ ...kit, ...patch });
  const competencyName = new Map(kit.competencies.map((c) => [c.id, c.name || 'Unnamed competency']));
  const probes = (id: string) => kit.questions.filter((q) => q.competencyId === id).length;
  const kinds = [...new Set(kit.rounds.map((r) => r.type))];

  // ── rounds: edited in the table ─────────────────────────────────────────
  const setRound = (i: number, patch: Partial<KitRound>) => set({ rounds: kit.rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const roundColumns: DataTableColumn<KitRound>[] = [
    { key: 'name', header: 'Round', render: (r, i) => (
      <Input size="sm" aria-label={`Round ${i + 1} name`} value={r.name} placeholder="Name the round" invalid={problems.has(`rounds.${i}.name`)}
        onChange={(e) => setRound(i, { name: e.target.value })} data-testid="interviews-kit-round-name" />
    ) },
    { key: 'type', header: 'Type', width: '168px', render: (r, i) => (
      <Select size="sm" aria-label={`Round ${i + 1} type`} value={r.type} options={ROUND_OPTIONS} invalid={problems.has(`rounds.${i}.type`)}
        onChange={(e) => setRound(i, { type: e.target.value as RoundType })} />
    ) },
    { key: 'minutes', header: 'Length', width: '148px', render: (r, i) => (
      <NumberInput size="sm" aria-label={`Round ${i + 1} length in minutes`} value={r.minutes} min={15} max={180} step={5} unit="min"
        invalid={problems.has(`rounds.${i}.minutes`)} onChange={(v) => setRound(i, { minutes: v })} />
    ) },
    { key: 'pad', header: 'Code pad', width: '120px', render: (r) => <T size="sm" tone={roundHasPad(r.type) ? 'primary' : 'tertiary'}>{padLine(r.type)}</T> },
  ];

  // ── competencies ────────────────────────────────────────────────────────
  const badCompetencies = rowsWithProblems(problems, 'competencies');
  const competencyColumns: DataTableColumn<KitCompetency>[] = [
    { key: 'name', header: 'Competency', render: (c, i) => (
      <Inline gap="xs" wrap={false}>
        <T size="sm" weight="medium" tone={c.name ? 'primary' : 'tertiary'} className="block max-w-[14rem] truncate" data-testid="interviews-kit-competency-name">{c.name || 'Unnamed competency'}</T>
        {badCompetencies.has(i) && <NeedsFixing />}
      </Inline>
    ) },
    { key: 'lookFor', header: 'What good looks like', render: (c) => <T size="sm" tone={c.lookFor ? 'secondary' : 'tertiary'} className="block max-w-[28rem] truncate">{c.lookFor || 'Not written yet'}</T> },
    { key: 'questions', header: 'Questions', numeric: true, width: '96px', render: (c) => <T size="sm">{probes(c.id)}</T> },
  ];
  const addCompetency = () => {
    const c = blankCompetency(newId('c', allIds(kit)));
    set({ competencies: [...kit.competencies, c] });
    onOpen({ list: 'competencies', id: c.id });
  };

  // ── questions ───────────────────────────────────────────────────────────
  const badQuestions = rowsWithProblems(problems, 'questions');
  const questionColumns: DataTableColumn<KitQuestion>[] = [
    { key: 'prompt', header: 'Question', render: (q, i) => (
      <Inline gap="xs" wrap={false}>
        <T size="sm" tone={q.prompt ? 'primary' : 'tertiary'} className="block max-w-[26rem] truncate" data-testid="interviews-kit-question-prompt">{q.prompt || 'Not written yet'}</T>
        {badQuestions.has(i) && <NeedsFixing />}
      </Inline>
    ) },
    { key: 'round', header: 'Round', width: '120px', render: (q) => <T size="sm">{ROUND_TYPE_LABELS[q.roundType]}</T> },
    { key: 'competency', header: 'Competency', render: (q) => <T size="sm" className="block max-w-[12rem] truncate">{competencyName.get(q.competencyId) ?? 'Choose one'}</T> },
    { key: 'followUps', header: 'Follow-ups', numeric: true, width: '96px', render: (q) => <T size="sm">{q.followUps.length}</T> },
    { key: 'starter', header: 'Starter code', render: (q) => <T size="sm" tone={starterLine(q) ? 'primary' : 'tertiary'}>{starterLine(q) || '—'}</T> },
  ];
  const addQuestion = () => {
    const type = kinds[0] ?? 'technical';
    const q = blankQuestion(newId('q', allIds(kit)), type, kit.competencies[0]?.id ?? '');
    set({ questions: [...kit.questions, q] });
    onOpen({ list: 'questions', id: q.id });
  };

  const openCompetency = open?.list === 'competencies' ? kit.competencies.findIndex((c) => c.id === open.id) : -1;
  const openQuestion = open?.list === 'questions' ? kit.questions.findIndex((q) => q.id === open.id) : -1;
  const toggle = (list: KitList, id: string) => onOpen(open?.list === list && open.id === id ? null : { list, id });

  return (
    <Stack gap="lg" className="pb-6" data-testid="interviews-kit-editor">
      <DetailSection title="Rounds" as="h2" hint={String(kit.rounds.length)} first
        actions={<Button size="sm" variant="ghost" data-testid="interviews-kit-add-round"
          onClick={() => set({ rounds: [...kit.rounds, blankRound(newId('rd', allIds(kit)), kinds.includes('technical') ? 'behavioural' : 'technical')] })}>Add round</Button>}>
        <Stack gap="xs">
          <DataTable narrow aria-label="Rounds" data={kit.rounds} columns={roundColumns} keyField={(r) => r.id}
            emptyMessage="No rounds yet. Add the first one."
            rowActions={(r) => {
              const i = kit.rounds.indexOf(r);
              return <RowControls what={`round ${i + 1}`} index={i} count={kit.rounds.length}
                onMove={(d) => set({ rounds: moved(kit.rounds, i, d) })} onRemove={() => set({ rounds: kit.rounds.filter((x) => x.id !== r.id) })} />;
            }} />
          <ListProblems problems={problems} list="rounds" />
        </Stack>
      </DetailSection>

      <DetailSection title="Competencies" as="h2" hint={String(kit.competencies.length)}
        actions={<Button size="sm" variant="ghost" data-testid="interviews-kit-add-competency" onClick={addCompetency}>Add competency</Button>}>
        <Stack gap="sm">
          <DataTable narrow aria-label="Competencies" data={kit.competencies} columns={competencyColumns} keyField={(c) => c.id}
            data-testid="interviews-kit-competencies" emptyMessage="No competencies yet. Add what the rounds should judge."
            selectedKey={openCompetency >= 0 ? kit.competencies[openCompetency]!.id : null}
            onRowClick={(c) => toggle('competencies', c.id)}
            rowActions={(c) => {
              const i = kit.competencies.indexOf(c);
              const n = probes(c.id);
              return <RowControls what={`competency ${i + 1}`} index={i} count={kit.competencies.length}
                onEdit={() => toggle('competencies', c.id)} onMove={(d) => set({ competencies: moved(kit.competencies, i, d) })}
                removeBlocked={n ? `${n === 1 ? 'A question probes' : `${n} questions probe`} this competency; move ${n === 1 ? 'it' : 'them'} to another first.` : undefined}
                onRemove={() => { set({ competencies: kit.competencies.filter((x) => x.id !== c.id) }); if (open?.id === c.id) onOpen(null); }} />;
            }} />
          <ListProblems problems={problems} list="competencies" />
          {openCompetency >= 0 && (
            <CompetencyForm index={openCompetency} competency={kit.competencies[openCompetency]!} problems={problems}
              onChange={(c) => set({ competencies: kit.competencies.map((x, j) => (j === openCompetency ? c : x)) })} onDone={() => onOpen(null)} />
          )}
        </Stack>
      </DetailSection>

      <DetailSection title="Questions" as="h2" hint={String(kit.questions.length)}
        actions={<Button size="sm" variant="ghost" data-testid="interviews-kit-add-question" disabled={!kit.rounds.length || !kit.competencies.length}
          title={!kit.rounds.length || !kit.competencies.length ? 'Add a round and a competency first.' : undefined} onClick={addQuestion}>Add question</Button>}>
        <Stack gap="sm">
          <DataTable narrow aria-label="Questions" data={kit.questions} columns={questionColumns} keyField={(q) => q.id}
            data-testid="interviews-kit-questions" emptyMessage="No questions yet. Add the ones interviewers choose from."
            selectedKey={openQuestion >= 0 ? kit.questions[openQuestion]!.id : null}
            onRowClick={(q) => toggle('questions', q.id)}
            rowActions={(q) => {
              const i = kit.questions.indexOf(q);
              return <RowControls what={`question ${i + 1}`} index={i} count={kit.questions.length}
                onEdit={() => toggle('questions', q.id)} onMove={(d) => set({ questions: moved(kit.questions, i, d) })}
                onRemove={() => { set({ questions: kit.questions.filter((x) => x.id !== q.id) }); if (open?.id === q.id) onOpen(null); }} />;
            }} />
          <ListProblems problems={problems} list="questions" />
          {openQuestion >= 0 && (
            <QuestionForm index={openQuestion} question={kit.questions[openQuestion]!} kit={kit} problems={problems}
              onChange={(q) => set({ questions: kit.questions.map((x, j) => (j === openQuestion ? q : x)) })} onDone={() => onOpen(null)} />
          )}
        </Stack>
      </DetailSection>
    </Stack>
  );
}

/** The open row's form, under its table. */
function RowForm({ title, onDone, children, testId }: { title: string; onDone: () => void; children: ReactNode; testId: string }) {
  return (
    <Stack gap="sm" className="rounded-md border border-border p-3" data-testid={testId}>
      <Inline justify="between" align="center">
        <T size="sm" weight="semibold">{title}</T>
        <Button size="sm" variant="ghost" onClick={onDone}>Done</Button>
      </Inline>
      {children}
    </Stack>
  );
}

function CompetencyForm({ index, competency: c, problems, onChange, onDone }: {
  index: number; competency: KitCompetency; problems: ReadonlyMap<string, string>; onChange: (c: KitCompetency) => void; onDone: () => void;
}) {
  const at = `competencies.${index}`;
  return (
    <RowForm title={`Competency ${index + 1}`} onDone={onDone} testId="interviews-kit-competency-form">
      <FormField label="Name" required error={problems.get(`${at}.name`)}>
        {(w) => <Input {...w} size="sm" value={c.name} onChange={(e) => onChange({ ...c, name: e.target.value })} data-testid="interviews-kit-competency-name-input" />}
      </FormField>
      <FormField label="What good looks like" required error={problems.get(`${at}.lookFor`)} hint="One or two sentences the interviewer and Milo read before the call.">
        {(w) => <Textarea {...w} rows={2} value={c.lookFor} onChange={(e) => onChange({ ...c, lookFor: e.target.value })} data-testid="interviews-kit-competency-lookfor" />}
      </FormField>
      <Inline gap="sm" align="start">
        {([1, 2, 3, 4] as const).map((k) => (
          <FormField key={k} label={`A rating of ${k}`} required error={problems.get(`${at}.anchors.${k}`)} className="min-w-[14rem] flex-1">
            {(w) => <Input {...w} size="sm" value={c.anchors[k]} onChange={(e) => onChange({ ...c, anchors: { ...c.anchors, [k]: e.target.value } })} />}
          </FormField>
        ))}
      </Inline>
    </RowForm>
  );
}

function QuestionForm({ index, question: q, kit, problems, onChange, onDone }: {
  index: number; question: KitQuestion; kit: OpeningKit; problems: ReadonlyMap<string, string>; onChange: (q: KitQuestion) => void; onDone: () => void;
}) {
  const at = `questions.${index}`;
  const kinds = [...new Set([...kit.rounds.map((r) => r.type), q.roundType])];
  const starters = PAD_LANGUAGES.filter((l) => q.starter?.[l] !== undefined);
  const unused = PAD_LANGUAGES.filter((l) => q.starter?.[l] === undefined);
  const setStarter = (next: Partial<Record<PadLanguage, string>>) => {
    const { starter: _drop, ...rest } = q;
    onChange(Object.keys(next).length ? { ...rest, starter: next } : rest);
  };
  const setType = (roundType: RoundType) => {
    // A behavioural round has no code pad, so its questions carry no starter code (row I1.8).
    const { starter: _drop, ...rest } = q;
    onChange(roundHasPad(roundType) ? { ...q, roundType } : { ...rest, roundType });
  };
  return (
    <RowForm title={`Question ${index + 1}`} onDone={onDone} testId="interviews-kit-question-form">
      <FormField label="Question" required error={problems.get(`${at}.prompt`)} hint="The words the interviewer asks.">
        {(w) => <Textarea {...w} rows={3} value={q.prompt} onChange={(e) => onChange({ ...q, prompt: e.target.value })} data-testid="interviews-kit-question-prompt-input" />}
      </FormField>
      <Inline gap="sm" align="start">
        <FormField label="Round" required error={problems.get(`${at}.roundType`)} className="min-w-[12rem] flex-1">
          {(w) => <Select {...w} size="sm" value={q.roundType} options={kinds.map((t) => ({ value: t, label: ROUND_TYPE_LABELS[t] }))}
            onChange={(e) => setType(e.target.value as RoundType)} data-testid="interviews-kit-question-round" />}
        </FormField>
        <FormField label="Competency it gathers evidence for" required error={problems.get(`${at}.competencyId`)} className="min-w-[16rem] flex-1">
          {(w) => <Select {...w} size="sm" value={q.competencyId} placeholder="Choose a competency"
            options={kit.competencies.map((c) => ({ value: c.id, label: c.name || 'Unnamed competency' }))}
            onChange={(e) => onChange({ ...q, competencyId: e.target.value })} data-testid="interviews-kit-question-competency" />}
        </FormField>
      </Inline>

      <Stack gap="xs">
        <Inline justify="between" align="center">
          <T size="sm" weight="medium">Follow-ups</T>
          <Button size="sm" variant="ghost" disabled={q.followUps.length >= 5} onClick={() => onChange({ ...q, followUps: [...q.followUps, ''] })}
            data-testid="interviews-kit-add-followup">Add follow-up</Button>
        </Inline>
        {q.followUps.length === 0 && <T size="xs" tone="tertiary">None yet. Follow-ups are what to ask next when an answer stays general.</T>}
        {problems.get(`${at}.followUps`) && <T size="xs" tone="danger">{problems.get(`${at}.followUps`)}</T>}
        {q.followUps.map((f, j) => (
          <Inline key={j} gap="xs" wrap={false} align="start">
            <FormField label={`Follow-up ${j + 1}`} error={problems.get(`${at}.followUps.${j}`)} className="flex-1">
              {(w) => <Input {...w} size="sm" value={f} onChange={(e) => onChange({ ...q, followUps: q.followUps.map((x, k) => (k === j ? e.target.value : x)) })} />}
            </FormField>
            <IconButton size="sm" variant="ghost" aria-label={`Remove follow-up ${j + 1}`} icon={<TrashIcon size={14} />} className="mt-6"
              onClick={() => onChange({ ...q, followUps: q.followUps.filter((_, k) => k !== j) })} />
          </Inline>
        ))}
      </Stack>

      <Stack gap="xs">
        <Inline justify="between" align="center">
          <T size="sm" weight="medium">Starter code</T>
          {roundHasPad(q.roundType) && (
            <Button size="sm" variant="ghost" disabled={!unused.length} data-testid="interviews-kit-add-starter"
              onClick={() => setStarter({ ...q.starter, [unused[0]!]: '' })}>Add starter code</Button>
          )}
        </Inline>
        {!roundHasPad(q.roundType) && <T size="xs" tone="tertiary">A behavioural round has no code pad, so this question carries no starter code.</T>}
        {roundHasPad(q.roundType) && starters.length === 0 && <T size="xs" tone="tertiary">None. The pad opens empty, or with code in each language you add here.</T>}
        {problems.get(`${at}.starter`) && <T size="xs" tone="danger">{problems.get(`${at}.starter`)}</T>}
        {starters.map((lang) => (
          <Stack key={lang} gap="xs">
            <Inline gap="xs" align="center" wrap={false}>
              <Select size="sm" aria-label="Starter code language" value={lang} className="w-40"
                options={[lang, ...unused].map((l) => ({ value: l, label: PAD_LANGUAGE_LABELS[l] }))}
                onChange={(e) => {
                  const next = e.target.value as PadLanguage;
                  setStarter(Object.fromEntries(starters.map((l) => [l === lang ? next : l, q.starter![l]!])));
                }} />
              <IconButton size="sm" variant="ghost" aria-label={`Remove the ${PAD_LANGUAGE_LABELS[lang]} starter code`} icon={<TrashIcon size={14} />}
                onClick={() => setStarter(Object.fromEntries(starters.filter((l) => l !== lang).map((l) => [l, q.starter![l]!])))} />
            </Inline>
            <CodeEditor value={q.starter![lang] ?? ''} language="plain" minLines={4} maxLines={14} aria-label={`${PAD_LANGUAGE_LABELS[lang]} starter code`}
              onChange={(code) => setStarter({ ...q.starter, [lang]: code })} />
            {problems.get(`${at}.starter.${lang}`) && <T size="xs" tone="danger">{problems.get(`${at}.starter.${lang}`)}</T>}
          </Stack>
        ))}
      </Stack>
    </RowForm>
  );
}
