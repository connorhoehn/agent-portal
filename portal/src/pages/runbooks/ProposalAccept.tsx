// Accepting a proposal is a confirmation, never one click. It says in words who the runbook will be given to;
// when the proposal carries scripts it lists each by path with a tick and sends the hash of what was shown
// (`scripts_read`); giving a run's runbook a wider scope than its run needs is a second, separate confirmation
// (`widen_scope`). A refusal for unread scripts re-shows the ones still unticked.
import { useEffect, useState } from 'react';
import { Checkbox, ConfirmDialog, FormField, Stack, T } from '@connorhoehn/ui-components/shared';

export interface ScriptToRead { path: string; sha256: string }

export function ProposalAccept({ open, title, scopeSentence, scripts, widening, unread, onCancel, onAccept }: {
  open: boolean;
  /** "Accept this runbook?" / "Retire this runbook?". */
  title: string;
  /** The scope in words. */
  scopeSentence: string;
  scripts: readonly ScriptToRead[];
  /** Set when the reviewer chose a wider scope than the run's own: what it was and what it would become. */
  widening: { from: string; to: string } | null;
  /** Paths the server said were still unread on the last try. */
  unread: readonly string[];
  onCancel: () => void;
  onAccept: (scriptsRead: ScriptToRead[], widen: boolean) => void | Promise<void>;
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [stage, setStage] = useState<'confirm' | 'widen'>('confirm');
  useEffect(() => { if (open) setStage('confirm'); }, [open]);
  useEffect(() => { if (unread.length) setTicks((t) => { const next = { ...t }; for (const p of unread) next[p] = false; return next; }); }, [unread]);
  const allTicked = scripts.every((s) => ticks[s.path]);
  const read = () => scripts.filter((s) => ticks[s.path]);

  if (stage === 'widen' && widening) {
    return (
      <ConfirmDialog
        open={open} title="Give it a wider scope?" tone="caution" confirmLabel="Widen and accept"
        body={`This runbook came from a run, so it was scoped to ${widening.from}. You are giving it to ${widening.to} instead: runs its own run never touched will be given it.`}
        onCancel={onCancel} onConfirm={() => { void onAccept(read(), true); }}
      />
    );
  }
  return (
    <ConfirmDialog
      open={open} title={title} body={scopeSentence} confirmLabel="Accept"
      confirmDisabled={!allTicked}
      onCancel={onCancel}
      onConfirm={() => { if (widening) setStage('widen'); else void onAccept(read(), false); }}
    >
      {scripts.length > 0 && (
        <Stack gap="sm" data-testid="accept-scripts">
          <T size="sm" tone="secondary" wrap>{`This runbook carries ${scripts.length === 1 ? 'a script' : `${scripts.length} scripts`}, and scripts run on future computers. Tick each one to say you read it.`}</T>
          {scripts.map((s) => (
            <FormField key={s.path} label={`I read ${s.path}`} layout="inline" hint={<T size="xs" tone="tertiary" className="break-all">{`Hash of what you read: ${s.sha256}`}</T>}>
              {({ labelId, id }) => (
                <Checkbox id={id} aria-labelledby={labelId} checked={ticks[s.path] === true} onChange={(v) => setTicks((t) => ({ ...t, [s.path]: v }))} data-testid={`script-tick-${s.path}`} />
              )}
            </FormField>
          ))}
          {unread.length > 0 && <T size="xs" tone="secondary" wrap data-testid="scripts-unread">{`Still unticked: ${unread.join(', ')}`}</T>}
        </Stack>
      )}
    </ConfirmDialog>
  );
}
