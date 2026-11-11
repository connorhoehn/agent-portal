// "Propose restoring" on a retired runbook: a person says why it should come back and files a restore
// proposal. It goes through review like any other; the runbook stays retired until someone who owns it accepts.
import { useState } from 'react';
import { Banner, Button, FormField, Inline, Stack, Textarea } from '@connorhoehn/ui-components/shared';
import { writeJson } from '../../lib/writeJson';
import { proposalHref, refusalMessage } from './runbooksModel';

export function RestoreRunbook({ runbookId, onOpen, onChanged }: { runbookId: string; onOpen: (href: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const res = await writeJson<{ proposal: { id: string }; code?: string }>('/api/runbooks/proposals', 'POST', { kind: 'restore', runbook_id: runbookId, rationale });
    setBusy(false);
    if (!res.ok) { setError(refusalMessage(res.status, res.data?.code, res.error)); return; }
    setFiled(res.data!.proposal.id);
    onChanged();
  };

  if (filed) {
    return (
      <Banner variant="success" layout="callout" icon title="Your request to restore it is with the reviewers" data-testid="restore-filed"
        action={<Button variant="link" size="sm" onClick={() => onOpen(proposalHref(filed))}>Open the proposal</Button>}>
        It stays retired until someone who owns this runbook accepts.
      </Banner>
    );
  }
  if (!open) return <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="restore-open">Propose restoring it</Button>;
  return (
    <Stack gap="sm" data-testid="restore-form">
      <FormField label="Why it should come back" required {...(error ? { error } : {})}>
        {({ labelId: _l, ...w }) => (
          <Textarea {...w} rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="The cutover is happening again next quarter…" />
        )}
      </FormField>
      <Inline gap="sm" align="center">
        <Button variant="primary" size="sm" disabled={busy || !rationale.trim()} onClick={() => { void submit(); }} data-testid="restore-submit">{busy ? 'Sending…' : 'Send for review'}</Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </Inline>
    </Stack>
  );
}
