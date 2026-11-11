// New initiative: the form the Initiatives list shows in its content area (not a
// modal) to a person who holds CreateInitiative. Name, summary, owner (the caller
// unless another person is chosen), an optional sponsor and an optional repository.
// A refusal is shown on the field it belongs to; a duplicate name links to the
// initiative that already has it. Filing opens the new initiative's page.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button, FormField, InlineAlert, Input, Inline, Link, PersonPicker, Stack, Textarea,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { writeJson } from '../../lib/writeJson';
import { initiativeHref } from './initiativeNavigation';
import {
  EMPTY_DRAFT, NAME_MAX, REPO_MAX, SUMMARY_MAX, createRefusal, newInitiativeBody, newInitiativeProblems,
  type CreateRefusal, type NewInitiativeDraft,
} from './newInitiativeModel';
import type { SessionPerson } from './types';

interface PersonEntity { id: string; name: string; title?: string | null }
interface Created { id: string }

export function NewInitiativeForm({ search, scope, onCancel }: {
  search: URLSearchParams;
  scope: 'all' | 'mine';
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const me = useFetch<SessionPerson>('/api/session/person', undefined, { share: true });
  const entities = useFetch<{ nodes?: PersonEntity[] }>('/api/graph/entities');
  const selfId = me.data?.linked ? me.data.personId : null;
  const people = useMemo(
    () => [...(entities.data?.nodes ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p.id, name: p.name, ...(p.id === selfId ? { tag: 'You' } : {}) })),
    [entities.data, selfId],
  );

  const [draft, setDraft] = useState<NewInitiativeDraft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<CreateRefusal | null>(null);
  const set = (over: Partial<NewInitiativeDraft>) => { setDraft((d) => ({ ...d, ...over })); setRefusal(null); };

  const problems = newInitiativeProblems(draft);
  const ownerId = draft.ownerId || selfId || '';
  // An account with no linked person has no default owner: the form asks for one.
  const needsOwner = !selfId && !draft.ownerId && me.data != null;

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length > 0 || needsOwner || busy) return;
    setBusy(true);
    const res = await writeJson<Created & { code?: string; existingId?: string }>('/api/graph/projects', 'POST', newInitiativeBody(draft, selfId));
    setBusy(false);
    if (res.ok && res.data?.id) {
      navigate(initiativeHref(res.data.id, search, scope));
      return;
    }
    setRefusal(createRefusal(res.status, res.data, res.error));
  };

  const nameError = (tried && problems.name) || (refusal?.field === 'name' ? refusal.message : undefined);
  const existingHref = refusal?.field === 'name' && refusal.existingId ? initiativeHref(refusal.existingId, search, scope) : null;

  return (
    <Stack gap="md" className="max-w-2xl" data-testid="new-initiative-form">
      <FormField label="Name" required {...(nameError ? { error: nameError } : {})} hint={`Up to ${NAME_MAX} characters. Two initiatives cannot share a name.`}>
        {(w) => <Input {...w} value={draft.name} maxLength={NAME_MAX + 20} onChange={(e) => set({ name: e.target.value })} data-testid="new-initiative-name" />}
      </FormField>
      {existingHref && (
        <InlineAlert tone="info">
          <Link href={existingHref}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(existingHref); }}
            data-testid="new-initiative-existing">Open the existing initiative</Link>
        </InlineAlert>
      )}
      <FormField label="Summary" {...(tried && problems.summary ? { error: problems.summary } : {})} hint={`What it is for, in a few sentences. Up to ${SUMMARY_MAX} characters.`}>
        {(w) => <Textarea {...w} rows={4} value={draft.summary} onChange={(e) => set({ summary: e.target.value })} data-testid="new-initiative-summary" />}
      </FormField>
      <FormField label="Owner" required
        {...(refusal?.field === 'owner' ? { error: refusal.message } : needsOwner && tried ? { error: 'Your account is not linked to a person, so choose an owner.' } : {})}
        hint="The person who runs it. They are added as a contributor straight away.">
        {(w) => <PersonPicker {...w} size="sm" value={ownerId} onChange={(v) => set({ ownerId: v })} placeholder="Search people"
          emptyMessage="Nobody matches" people={people} data-testid="new-initiative-owner" />}
      </FormField>
      <FormField label="Sponsor" hint="Optional. The executive who signed off on it.">
        {(w) => <PersonPicker {...w} size="sm" value={draft.sponsorId} onChange={(v) => set({ sponsorId: v })} placeholder="Search people"
          emptyMessage="Nobody matches" people={people} data-testid="new-initiative-sponsor" />}
      </FormField>
      <FormField label="Repository" hint="Optional, as owner/name. It is only recorded; nothing is cloned or checked."
        {...(tried && problems.repo ? { error: problems.repo } : refusal?.field === 'repo' ? { error: refusal.message } : {})}>
        {(w) => <Input {...w} value={draft.repo} maxLength={REPO_MAX + 20} placeholder="acme/billing" onChange={(e) => set({ repo: e.target.value })} data-testid="new-initiative-repo" />}
      </FormField>
      {refusal && refusal.field === null && <InlineAlert tone="error" data-testid="new-initiative-error">{refusal.message}</InlineAlert>}
      <Inline gap="sm">
        <Button size="sm" onClick={() => { void submit(); }} disabled={busy} data-testid="new-initiative-submit">{busy ? 'Creating…' : 'Create initiative'}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </Inline>
    </Stack>
  );
}
