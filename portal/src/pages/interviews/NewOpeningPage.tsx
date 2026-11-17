// /interviews/openings/new — the recruiter starts an opening (docs/interviews-tenant-plan.md row I1.3): its
// details, then its kit on the opening's editor. Creating is asked in the composer's prompt deck, never a
// dialog; the server checks the details and answers each problem on its field.

import { Button, Inline, PageFrame } from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { BLANK_DETAILS, createOpening, detailsChanged, problemsByPath, type OpeningDetails } from '../../lib/interviewsKit';
import { OpeningDetailsForm } from './OpeningDetailsForm';

export default function NewOpeningPage() {
  const navigate = useNavigate();
  const base = useFlushTrailItems();
  const trail = base ? [...base.slice(0, -1), { label: base[base.length - 1]?.label ?? 'Openings', href: '/interviews/openings' }, { label: 'New opening' }] : undefined;
  const [details, setDetails] = useState<OpeningDetails>(BLANK_DETAILS);
  const [problems, setProblems] = useState<Map<string, string>>(new Map());
  const [asked, setAsked] = useState(0);
  const [asking, setAsking] = useState<'create' | 'cancel' | null>(null);
  const dirty = detailsChanged(BLANK_DETAILS, details);

  const prompts = useMemo<ComposerPrompt[]>(() => (asking === 'cancel' ? [{
    id: `interviews-new-opening:cancel-${asked}`, scope: 'interviews-new-opening', kind: 'choice', eyebrow: 'Leave without creating',
    title: details.title.trim() || 'New opening',
    question: 'Leave without creating the opening? What you typed here will be lost.',
    options: [{ id: 'leave', label: 'Leave and discard', emphasis: 'danger' }, { id: 'keep', label: 'Keep editing', emphasis: 'primary' }],
    onAnswer: async (a) => {
      setAsking(null);
      if (!('optionId' in a) || a.optionId !== 'leave') return { receipt: 'Still editing.' };
      void navigate('/interviews/openings');
      return { receipt: 'Discarded.' };
    },
  }] : asking === 'create' ? [{
    id: `interviews-new-opening:create-${asked}`, scope: 'interviews-new-opening', kind: 'choice', eyebrow: 'Create the opening',
    title: details.title.trim() || 'New opening',
    question: 'Create this opening? It starts with an empty kit, which you fill next.',
    options: [{ id: 'create', label: 'Create opening', emphasis: 'primary' }, { id: 'keep', label: 'Keep editing' }],
    onAnswer: async (a) => {
      if (!('optionId' in a) || a.optionId !== 'create') { setAsking(null); return { receipt: 'Still editing. Nothing was created.' }; }
      const r = await createOpening(details);
      if (!r.ok) { setProblems(problemsByPath(r.fields)); return { error: r.error }; }
      setAsking(null);
      void navigate(`/interviews/openings/${encodeURIComponent(r.opening.id)}/edit`);
      return { receipt: 'Opening created. Add its kit next.' };
    },
  }] : []), [asking, asked, details, navigate]);

  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'opening' }, {
    id: 'interviews-new-opening-commands', label: 'New opening', placeholder: 'Fill in the details above…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: () => undefined,
    scopeNote: 'Creating the opening is asked here and never done by a typed command.',
  }), []);

  return (
    <>
      <PageFrame title="New opening" description="Name the opening and who decides it. You add the rounds, competencies and questions next."
        breadcrumbs={trail} data-testid="interviews-new-opening-page"
        actions={(
          <Inline gap="xs" wrap={false}>
            <Button size="sm" variant="ghost" data-testid="interviews-new-opening-cancel"
              onClick={() => { if (!dirty) { void navigate('/interviews/openings'); return; } setAsked(asked + 1); setAsking('cancel'); }}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!dirty} data-testid="interviews-new-opening-create"
              onClick={() => { setAsked(asked + 1); setAsking('create'); }}>Create…</Button>
          </Inline>
        )}>
        <OpeningDetailsForm details={details} onChange={setDetails} problems={problems} />
      </PageFrame>
      <CollectionCommandHost adapter={adapter} prompts={prompts} />
    </>
  );
}
