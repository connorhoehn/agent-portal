// The kit editor's answer key for a board round question (the master template's part C): the provided design on its
// own canvas (BoardScene, editable, apart from the starting board), the numbered design questions with the
// interviewer's answers (the last may be the enhancement that changes the diagram), and the red flags by group. The
// room shows all of it to the lead and the panel only; the scorecard ticks the red flags. Server checks: kit.ts.
import { useCallback, useRef } from 'react';
import { Button, Checkbox, FormField, IconButton, Inline, Input, Select, Stack, T, Textarea, TrashIcon } from '@connorhoehn/ui-components/shared';
import { RowKeys } from '../../lib/rowKeys';
import { boardSceneKey } from '../../lib/interviewsBoard';
import { RED_FLAG_GROUP_LABELS, type KitDesignQuestion, type KitRedFlag, type RedFlagGroup } from '../../lib/interviewsAnswerKey';
import type { KitQuestion } from '../../lib/interviewsKit';
import { BoardScene } from './board/BoardScene';

/** The server's caps (kit.ts KIT_LIMITS). */
const MAX_DESIGN_QUESTIONS = 6;
const MAX_RED_FLAGS = 12;
const GROUP_OPTIONS = (Object.keys(RED_FLAG_GROUP_LABELS) as RedFlagGroup[]).map((g) => ({ value: g, label: RED_FLAG_GROUP_LABELS[g] }));

interface Props { question: KitQuestion; at: string; index: number; problems: ReadonlyMap<string, string>; onChange: (q: KitQuestion) => void }

export function AnswerKeyEditor(props: Props) {
  return (
    <Stack gap="md" data-testid="interviews-kit-answer-key">
      <Stack gap="none">
        <T size="sm" weight="medium">Answer key</T>
        <T size="xs" tone="tertiary">For the interviewers only: the lead and the panel see it in the room; the candidate sees the provided design only if the lead reveals it.</T>
      </Stack>
      <ProvidedDesign {...props} />
      <DesignQuestions {...props} />
      <RedFlags {...props} />
    </Stack>
  );
}

function ProvidedDesign({ question: q, at, problems, onChange }: Props) {
  const design = q.providedDesign;
  const onElements = useCallback((elements: Array<Record<string, unknown>>) => {
    if (!design || boardSceneKey(elements) === boardSceneKey(design.elements)) return;
    onChange({ ...q, providedDesign: { ...design, elements } });
  }, [design, onChange, q]);
  const problem = problems.get(`${at}.providedDesign`);
  return (
    <Stack gap="xs" data-testid="interviews-kit-provided-design">
      <Inline justify="between" align="center">
        <T size="sm" weight="medium">Provided design</T>
        {design
          ? <Button size="sm" variant="ghost" onClick={() => { const { providedDesign: _drop, ...rest } = q; onChange(rest); }} data-testid="interviews-kit-remove-design">Remove the provided design</Button>
          : <Button size="sm" variant="secondary" onClick={() => onChange({ ...q, providedDesign: { name: 'Provided design', elements: [] } })} data-testid="interviews-kit-add-design">Add a provided design</Button>}
      </Inline>
      {!design && <T size="xs" tone="tertiary">None. Draw the reference design here: services, stores, the arrows between them, the API and the data model.</T>}
      {problem && <T size="xs" tone="danger" data-testid="interviews-kit-design-problem">{problem}</T>}
      {design && <BoardScene sceneId={`kit-design-${q.id}`} elements={design.elements} editable onElements={onElements} className="h-[28rem] overflow-hidden" data-testid="interviews-kit-design-canvas" />}
    </Stack>
  );
}

function DesignQuestions({ question: q, at, index, problems, onChange }: Props) {
  const list = q.designQuestions ?? [];
  const rows = useRef(new RowKeys()).current;
  const keys = rows.for(list.length);
  // Only the last may be the enhancement: setting it on one clears it from the others, and a removal keeps it last.
  const setList = (next: KitDesignQuestion[]) => {
    const { designQuestions: _drop, ...rest } = q;
    const tidy = next.map((d, j) => { const { enhancement: _e, ...plain } = d; return d.enhancement && j === next.length - 1 ? { ...plain, enhancement: true as const } : plain; });
    onChange(tidy.length ? { ...rest, designQuestions: tidy } : rest);
  };
  const put = (j: number, d: KitDesignQuestion) => setList(list.map((x, k) => (k === j ? d : x)));
  return (
    <Stack gap="xs" data-testid="interviews-kit-design-questions">
      <Inline justify="between" align="center">
        <T size="sm" weight="medium">Design questions</T>
        <Button size="sm" variant="ghost" disabled={list.length >= MAX_DESIGN_QUESTIONS} onClick={() => setList([...list, { text: '' }])} data-testid="interviews-kit-add-design-question">Add design question</Button>
      </Inline>
      <T size="xs" tone="tertiary">{list.length === 0
        ? 'None yet. The numbered questions under “Your design”, each with your short answer; the last can be an enhancement that changes the diagram.'
        : 'The answers show only to the interviewers.'}</T>
      {problems.get(`${at}.designQuestions`) && <T size="xs" tone="danger">{problems.get(`${at}.designQuestions`)}</T>}
      {list.map((d, j) => (
        <Stack key={keys[j]} gap="xs" data-testid="interviews-kit-design-question">
          <Inline gap="xs" wrap={false} align="start">
            <FormField label={`Design question ${j + 1}`} error={problems.get(`${at}.designQuestions.${j}.text`)} className="flex-1">
              {(w) => <Input {...w} size="sm" value={d.text} onChange={(e) => put(j, { ...d, text: e.target.value })} />}
            </FormField>
            <IconButton size="sm" variant="ghost" aria-label={`Remove design question ${j + 1} of question ${index + 1}`} icon={<TrashIcon size={14} />} className="mt-6"
              onClick={() => { rows.remove(j); setList(list.filter((_, k) => k !== j)); }} />
          </Inline>
          <FormField label="Answer" hint="What a good answer covers." error={problems.get(`${at}.designQuestions.${j}.answer`)}>
            {({ labelId: _labelId, ...w }) => <Textarea {...w} minRows={2} autoResize value={d.answer ?? ''}
              onChange={(e) => { const { answer: _a, ...plain } = d; put(j, e.target.value ? { ...plain, answer: e.target.value } : plain); }} />}
          </FormField>
          {j === list.length - 1 && <Inline gap="sm" align="center">
            <Checkbox checked={d.enhancement === true} aria-label={`Design question ${j + 1} is the enhancement`}
              onChange={(on) => { const { enhancement: _e, ...plain } = d; put(j, on ? { ...plain, enhancement: true } : plain); }} />
            <T size="sm">The enhancement: it makes the candidate change the diagram</T>
          </Inline>}
          {problems.get(`${at}.designQuestions.${j}.enhancement`) && <T size="xs" tone="danger">{problems.get(`${at}.designQuestions.${j}.enhancement`)}</T>}
        </Stack>
      ))}
    </Stack>
  );
}

function RedFlags({ question: q, at, index, problems, onChange }: Props) {
  const list = q.redFlags ?? [];
  const rows = useRef(new RowKeys()).current;
  const keys = rows.for(list.length);
  const setList = (next: KitRedFlag[]) => { const { redFlags: _drop, ...rest } = q; onChange(next.length ? { ...rest, redFlags: next } : rest); };
  const put = (j: number, f: KitRedFlag) => setList(list.map((x, k) => (k === j ? f : x)));
  return (
    <Stack gap="xs" data-testid="interviews-kit-red-flags">
      <Inline justify="between" align="center">
        <T size="sm" weight="medium">Red flags</T>
        <Button size="sm" variant="ghost" disabled={list.length >= MAX_RED_FLAGS}
          onClick={() => setList([...list, { group: list[list.length - 1]?.group ?? 'over-engineering', text: '' }])} data-testid="interviews-kit-add-red-flag">Add red flag</Button>
      </Inline>
      <T size="xs" tone="tertiary">{list.length === 0
        ? 'None yet. What a weak design shows, grouped: over-engineering, responsibility, naming. The lead ticks the ones seen on the scorecard.'
        : 'The lead ticks the ones seen on the scorecard; they are not scored.'}</T>
      {problems.get(`${at}.redFlags`) && <T size="xs" tone="danger">{problems.get(`${at}.redFlags`)}</T>}
      {list.map((f, j) => (
        <Inline key={keys[j]} gap="xs" wrap={false} align="start" data-testid="interviews-kit-red-flag">
          <FormField label={`Group of red flag ${j + 1}`} className="w-44 shrink-0">
            {(w) => <Select {...w} size="sm" value={f.group} options={GROUP_OPTIONS} onChange={(e) => put(j, { ...f, group: e.target.value as RedFlagGroup })} />}
          </FormField>
          <FormField label={`Red flag ${j + 1}`} error={problems.get(`${at}.redFlags.${j}`)} className="flex-1">
            {(w) => <Input {...w} size="sm" value={f.text} onChange={(e) => put(j, { ...f, text: e.target.value })} />}
          </FormField>
          <IconButton size="sm" variant="ghost" aria-label={`Remove red flag ${j + 1} of question ${index + 1}`} icon={<TrashIcon size={14} />} className="mt-6"
            onClick={() => { rows.remove(j); setList(list.filter((_, k) => k !== j)); }} />
        </Inline>
      ))}
    </Stack>
  );
}
