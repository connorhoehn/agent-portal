// /interviews/candidates/new — the recruiter adds a candidate to an opening (UI round 2, contract U13). Same shape as New
// opening: the details, then a confirm in the composer's prompt deck (never a dialog); the server checks each field and
// answers a sentence on it, and the same email twice on one opening is refused plainly. Then the candidate's profile,
// where the résumé is uploaded.

import { Button, FormField, Inline, Input, PageFrame, Select, Stack } from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { useFetch } from '../../hooks/useFetch';
import { INTERVIEWS_API, candidateHref, type ItemsResponse, type OpeningRow } from '../../lib/interviews';
import { BLANK_CANDIDATE, candidateChanged, createCandidate, type NewCandidate } from '../../lib/interviewsCandidates';
import { problemsByPath } from '../../lib/interviewsKit';

const LIST = '/interviews/candidates';

export default function NewCandidatePage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const base = useFlushTrailItems();
  const at = base ? base.findIndex((i) => i.label === 'Candidates') : -1;
  const trail = base && at >= 0 ? [...base.slice(0, at), { ...base[at]!, href: LIST }, { label: 'Add a candidate' }] : base;
  const openings = useFetch<ItemsResponse<OpeningRow>>(`${INTERVIEWS_API}/openings`);
  const [form, setForm] = useState<NewCandidate>({ ...BLANK_CANDIDATE, openingId: search.get('opening') ?? '' });
  const [problems, setProblems] = useState<Map<string, string>>(new Map());
  const [asked, setAsked] = useState(0);
  const [asking, setAsking] = useState<'create' | 'cancel' | null>(null);
  const dirty = candidateChanged({ ...form, openingId: '' });
  const set = (patch: Partial<NewCandidate>) => setForm({ ...form, ...patch });
  const openingTitle = (openings.data?.items ?? []).find((o) => o.id === form.openingId)?.title;

  const text = (key: 'name' | 'email' | 'headline' | 'location' | 'source', label: string, required: boolean, hint?: string) => (
    <FormField label={label} required={required} hint={hint} error={problems.get(key)} className="min-w-[16rem] flex-1">
      {(w) => <Input {...w} size="sm" value={form[key]} onChange={(e) => set({ [key]: e.target.value })} data-testid={`interviews-candidate-${key}`} />}
    </FormField>
  );

  const prompts = useMemo<ComposerPrompt[]>(() => (asking === 'cancel' ? [{
    id: `interviews-new-candidate:cancel-${asked}`, scope: 'interviews-new-candidate', kind: 'choice', eyebrow: 'Leave without adding',
    title: form.name.trim() || 'New candidate',
    question: 'Leave without adding the candidate? What you typed here will be lost.',
    options: [{ id: 'leave', label: 'Leave and discard', emphasis: 'danger' }, { id: 'keep', label: 'Keep editing', emphasis: 'primary' }],
    onAnswer: async (a) => {
      setAsking(null);
      if (!('optionId' in a) || a.optionId !== 'leave') return { receipt: 'Still editing.' };
      void navigate(LIST);
      return { receipt: 'Discarded.' };
    },
  }] : asking === 'create' ? [{
    id: `interviews-new-candidate:create-${asked}`, scope: 'interviews-new-candidate', kind: 'choice', eyebrow: 'Add the candidate',
    title: form.name.trim() || 'New candidate',
    question: `Add ${form.name.trim() || 'this person'} as a candidate${openingTitle ? ` for ${openingTitle}` : ''}? They start at the first stage; you add their résumé next.`,
    options: [{ id: 'create', label: 'Add candidate', emphasis: 'primary' }, { id: 'keep', label: 'Keep editing' }],
    onAnswer: async (a) => {
      if (!('optionId' in a) || a.optionId !== 'create') { setAsking(null); return { receipt: 'Still editing. Nobody was added.' }; }
      const r = await createCandidate(form);
      if (!r.ok) {
        setProblems(r.duplicate ? new Map([['email', r.error]]) : problemsByPath(r.fields));
        setAsking(null);
        return { error: r.error };
      }
      setAsking(null);
      void navigate(candidateHref(r.candidateId));
      return { receipt: 'Candidate added. Add their résumé next.' };
    },
  }] : []), [asking, asked, form, openingTitle, navigate]);

  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'candidate' }, {
    id: 'interviews-new-candidate-commands', label: 'Add a candidate', placeholder: 'Fill in the details above…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: () => undefined,
    scopeNote: 'Adding the candidate is asked here and never done by a typed command.',
  }), []);

  return (
    <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
      <PageFrame title="Add a candidate" description="Name the person and the opening they are applying to. You add their résumé on their profile next."
        breadcrumbs={trail} data-testid="interviews-new-candidate-page"
        actions={(
          <Inline gap="xs" wrap={false}>
            <Button size="sm" variant="ghost" data-testid="interviews-new-candidate-cancel"
              onClick={() => { if (!dirty) { void navigate(LIST); return; } setAsked(asked + 1); setAsking('cancel'); }}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!dirty} data-testid="interviews-new-candidate-create"
              onClick={() => { setProblems(new Map()); setAsked(asked + 1); setAsking('create'); }}>Add…</Button>
          </Inline>
        )}>
        <Stack gap="md" className="max-w-[56rem] pb-6" data-testid="interviews-new-candidate-form">
          <Inline gap="sm" align="start">
            {text('name', 'Name', true)}
            {text('email', 'Email', true, 'Where the interview invitation goes.')}
          </Inline>
          <Inline gap="sm" align="start">
            <FormField label="Opening" required error={problems.get('openingId')} className="min-w-[16rem] flex-1">
              {(w) => <Select {...w} size="sm" value={form.openingId} data-testid="interviews-candidate-opening"
                options={[{ value: '', label: 'Choose an opening' }, ...(openings.data?.items ?? []).filter((o) => o.state !== 'closed').map((o) => ({ value: o.id, label: `${o.title} · ${o.team}` }))]}
                onChange={(e) => set({ openingId: e.target.value })} />}
            </FormField>
            {text('source', 'Where they came from', false, 'For example Referral or Careers page.')}
          </Inline>
          <Inline gap="sm" align="start">
            {text('headline', 'Current role', false, 'For example Senior engineer, payments.')}
            {text('location', 'Where they are', false)}
          </Inline>
        </Stack>
      </PageFrame>
      <CollectionCommandHost adapter={adapter} prompts={prompts} />
    </Stack>
  );
}
