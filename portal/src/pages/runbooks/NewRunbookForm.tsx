// "New runbook": a person writes a procedure by hand and files it as a proposal. It goes through review like
// any other (a reviewer accepts it from the proposal's page); nothing a box receives changes until then.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Banner, Button, FormField, FormRow, Inline, Input, Select, Stack, T, Textarea } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { writeJson } from '../../lib/writeJson';
import { LintList, ProposalFields } from './RunbookProposalFields';
import { NEW_RUNBOOK_BODY_STARTER, newRunbookRequest, proposalHref, refusalMessage, type NewRunbookDraft } from './runbooksModel';
import type { LintFinding } from './types';

const EMPTY: NewRunbookDraft = { name: '', description: '', scopeKind: 'initiative', scopeRef: '', body: NEW_RUNBOOK_BODY_STARTER, rationale: '' };

/** The form, in the Library's content column (a page, never a modal). */
export function NewRunbookForm({ onClose, initial }: { onClose: () => void; initial?: Partial<NewRunbookDraft> | null }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<NewRunbookDraft>({ ...EMPTY, ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [filed, setFiled] = useState<{ id: string; lint: LintFinding[] } | null>(null);
  const initiatives = useFetch<Array<{ id: string; name: string }>>('/api/graph/projects?limit=200');
  const set = (patch: Partial<NewRunbookDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async () => {
    const req = newRunbookRequest(draft);
    if (!req.ok) { setError(req.error); setProblems([]); return; }
    setBusy(true); setError(null); setProblems([]);
    const res = await writeJson<{ proposal: { id: string; lint: LintFinding[] }; code?: string; problems?: string[] }>('/api/runbooks/proposals', 'POST', req.body);
    setBusy(false);
    if (!res.ok) {
      setError(refusalMessage(res.status, res.data?.code, res.error));
      setProblems(res.data?.problems ?? []);
      return;
    }
    const { id, lint } = res.data!.proposal;
    // Lint errors stay in view beside a link to the proposal; a clean filing goes straight to the review page.
    if (lint.some((f) => f.severity === 'error')) { setFiled({ id, lint }); return; }
    onClose();
    navigate(proposalHref(id));
  };

  const actions = (
    <Inline gap="sm" justify="end">
      <Button variant="ghost" onClick={onClose} disabled={busy}>{filed ? 'Close' : 'Cancel'}</Button>
      {filed
        ? <Button variant="primary" onClick={() => { onClose(); navigate(proposalHref(filed.id)); }} data-testid="new-runbook-open">Open the proposal</Button>
        : <Button variant="primary" onClick={() => { void submit(); }} disabled={busy} data-testid="new-runbook-submit">{busy ? 'Sending…' : 'Send for review'}</Button>}
    </Inline>
  );

  return (
    <Stack gap="md" className="w-full max-w-3xl px-6 pb-6" data-testid="new-runbook">
      <T size="lg" weight="semibold">New runbook</T>
      {filed ? (
        <Stack gap="md" data-testid="new-runbook-filed">
          <Banner variant="warning" layout="callout" icon title="Filed, with lint errors">The proposal is with the reviewers. It cannot be accepted until these are fixed, so suggest a corrected version from its page.</Banner>
          <LintList findings={filed.lint} />
        </Stack>
      ) : (
        <Stack gap="md" data-testid="new-runbook-form">
          <FormField label="Name" required>
            {({ id }) => <Input id={id} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Rerun a flaky test against its own diff" data-testid="new-runbook-name" />}
          </FormField>
          <FormField label="What it is for" required hint="One sentence. A box reads it to decide whether the runbook applies.">
            {({ id }) => <Textarea id={id} value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={2} data-testid="new-runbook-description" />}
          </FormField>
          <FormRow>
            <FormField label="Applies to" required>
              {({ id }) => (
                <Select id={id} value={draft.scopeKind} onChange={(e) => set({ scopeKind: e.target.value as NewRunbookDraft['scopeKind'], scopeRef: '' })}
                  options={[{ value: 'initiative', label: 'An initiative' }, { value: 'repo', label: 'A repository' }]} data-testid="new-runbook-scope-kind" />
              )}
            </FormField>
            <FormField label={draft.scopeKind === 'repo' ? 'Repository' : 'Initiative'} required>
              {({ id }) => draft.scopeKind === 'repo'
                ? <Input id={id} value={draft.scopeRef} onChange={(e) => set({ scopeRef: e.target.value })} placeholder="owner/repository" data-testid="new-runbook-scope-ref" />
                : (
                  <Select id={id} value={draft.scopeRef} onChange={(e) => set({ scopeRef: e.target.value })} data-testid="new-runbook-scope-ref"
                    options={[{ value: '', label: 'Choose an initiative…' }, ...(Array.isArray(initiatives.data) ? initiatives.data : []).map((p) => ({ value: p.id, label: p.name }))]} />
                )}
            </FormField>
          </FormRow>
          <ProposalFields
            markdown={draft.body} onMarkdown={(body) => set({ body })}
            markdownLabel="Body" markdownHint="Use when, the numbered steps with a command under each and what to expect, and how to verify." markdownRows={14}
            rationale={draft.rationale} onRationale={(rationale) => set({ rationale })}
            rationaleLabel="Why keep this" rationalePlaceholder="Every pilot cutover needs it and nobody has written it down."
            error={error} problems={problems}
          />
        </Stack>
      )}
      {actions}
    </Stack>
  );
}
