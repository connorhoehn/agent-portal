import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  FormField,
  FormWizard,
  Inline,
  LockIcon,
  Modal,
  RadioGroup,
  Stack,
  T,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { writeJson } from '../../lib/writeJson';
import { toastSuccess } from '../../lib/toastStore';
import { DURATION_LABELS, type AccessDuration, type AccessRequest } from '../../lib/accessRequests';
import {
  DEFAULT_QUICK_DURATION,
  JUSTIFICATION_MIN,
  QUICK_DURATIONS,
  QUICK_REQUEST_API,
  mineUrl,
  openStatusText,
  quickRequestProblem,
  quickRequestState,
  requestHref,
} from './budgetAccessModel';
import type { BudgetAccessLocked } from './types';

// The budgets read tier on the Initiatives page (decided 2026-10-13): a locked
// figure, and the one quick request that unlocks it from here. Composed from
// library primitives only (LockIcon, T, Inline, Modal, FormWizard, FormField,
// Textarea, RadioGroup, Button); the request is the ordinary access request the
// middleware files through routes/access-requests-quick.ts.

/** A withheld dollar figure: a lock and "Locked", with the server's reason as its title. Never a zero. */
export function LockedFigure({ lock, testId }: { lock: BudgetAccessLocked; testId?: string }) {
  return (
    <Inline gap="xs" align="center" data-testid={testId ?? 'budget-locked'}>
      <LockIcon size={12} aria-hidden />
      <T size="xs" tone="tertiary" title={lock.reason}>Locked</T>
    </Inline>
  );
}

/**
 * The header action: "Request budget access" (opening the form), or — while a
 * request is open — its status and who it waits on, with the Access record
 * linked when the reader can open Access (otherwise the bell carries the
 * decision). `autoOpen` opens the form on arrival (a locked budget answer links
 * here with ?request=budget-access); `onClosed` lets the page drop that query.
 */
export function BudgetAccessRequest({ lock, autoOpen = false, onClosed }: {
  lock: BudgetAccessLocked;
  autoOpen?: boolean;
  onClosed?: () => void;
}) {
  const navigate = useNavigate();
  const { session } = useSession();
  const mine = useFetch<{ items: AccessRequest[] }>(mineUrl(lock.requestItemId));
  const state = quickRequestState(mine.data?.items);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpen && mine.data && state.kind === 'none') setOpen(true);
  }, [autoOpen, mine.data, state.kind]);

  const close = () => { setOpen(false); onClosed?.(); };

  if (mine.data == null) return null;

  if (state.kind === 'none') {
    return (
      <>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="budget-access-request">
          Request budget access
        </Button>
        <BudgetAccessForm
          open={open}
          itemId={lock.requestItemId}
          reason={lock.reason}
          onClose={close}
          onFiled={() => { mine.refresh(); close(); }}
        />
      </>
    );
  }

  const href = requestHref(state.request.id, session?.grants);
  const text = state.kind === 'open' ? openStatusText(state)
    : state.kind === 'approved' ? 'Approved — being provisioned'
    : 'Granted — the figures appear within two minutes';
  return (
    <Inline gap="sm" align="center" data-testid="budget-access-status">
      <LockIcon size={12} aria-hidden />
      <T size="sm" tone="secondary">{text}</T>
      {href ? (
        <Button size="sm" variant="ghost" onClick={() => navigate(href)}>View request</Button>
      ) : (
        <T size="xs" tone="tertiary">The bell tells you when it is decided</T>
      )}
    </Inline>
  );
}

function BudgetAccessForm({ open, itemId, reason, onClose, onFiled }: {
  open: boolean;
  itemId: string;
  reason: string;
  onClose: () => void;
  onFiled: () => void;
}) {
  const [justification, setJustification] = useState('');
  const [duration, setDuration] = useState<AccessDuration>(DEFAULT_QUICK_DURATION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = quickRequestProblem(justification, duration);

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const res = await writeJson<AccessRequest & { requestId?: string }>(`${QUICK_REQUEST_API}/quick`, 'POST',
      { itemId, justification: justification.trim(), duration });
    setBusy(false);
    // A 409 naming an open request is the same outcome: there is a request to wait on.
    if (res.ok || (res.status === 409 && res.data?.requestId)) {
      toastSuccess(null, 'Budget access requested', 'Your approvers have been notified.');
      setJustification('');
      onFiled();
      return;
    }
    setError(res.error);
  };

  const n = justification.trim().length;
  return (
    <Modal open={open} onClose={onClose} title="Request budget access" maxWidth={520}>
      <Stack gap="md">
        <T as="p" size="sm" tone="secondary">
          {reason} Your manager, then the budget owner, decide it in Access; once it is granted the figures appear here without signing out.
        </T>
        <FormWizard
          aria-label="Request budget access"
          data-testid="budget-access"
          onSubmit={submit}
          submitLabel="Send request"
          submittingLabel="Requesting…"
          submitting={busy}
          submitError={error}
          onDismissError={() => setError(null)}
          secondaryActions={<Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>}
          sections={[
            {
              key: 'why', title: 'Why do you need it?', error: n >= JUSTIFICATION_MIN ? null : problem,
              content: (
                <FormField label="Justification" hint={`${n} of at least ${JUSTIFICATION_MIN} characters`} required>
                  {(wiring) => (
                    <Textarea {...wiring} rows={4} value={justification} onChange={(e) => setJustification(e.target.value)}
                      data-testid="budget-access-justification" />
                  )}
                </FormField>
              ),
            },
            {
              key: 'how-long', title: 'For how long?', description: 'Access ends on its own when the time is up.',
              content: (
                <RadioGroup<AccessDuration> name="budget-access-duration" aria-label="Duration" value={duration} onChange={setDuration} orientation="horizontal"
                  options={QUICK_DURATIONS.map((d) => ({ value: d, label: DURATION_LABELS[d] }))} />
              ),
            },
          ]}
        />
      </Stack>
    </Modal>
  );
}
