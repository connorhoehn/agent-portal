import { Button, Card, Inline, LockIcon, Spinner, Stack, T } from '@connorhoehn/ui-components/shared';
import './CommunicationAccessState.css';

export type CommunicationAccessStatus = 'loading' | 'invalid' | 'signed-out' | 'unavailable';
export interface CommunicationAccessStateProps {
  state: CommunicationAccessStatus;
  onRetry?: () => void;
  onSignIn?: () => void;
  busy?: boolean;
  /** A narrower read may provide its own subject without exposing raw errors. */
  title?: string;
  detail?: string;
}
const COPY: Record<CommunicationAccessStatus, { title: string; detail: string }> = {
  loading: { title: 'Checking Communication access…', detail: 'Loading your workspace and conversation permissions.' },
  invalid: { title: 'Sign in again', detail: 'Your session is no longer valid. Sign in to reopen your conversations.' },
  'signed-out': { title: 'Sign in to Communication', detail: 'Sign in to see the conversations available to your account.' },
  unavailable: { title: 'Communication is unavailable', detail: 'Your access could not be confirmed. Try again.' },
};

/** Unknown access is never an empty inbox or a request for an admin grant. */
export function CommunicationAccessState({ state, onRetry, onSignIn, busy = false, title, detail }: CommunicationAccessStateProps) {
  const copy = COPY[state];
  const signIn = state === 'invalid' || state === 'signed-out';
  return <Card padding="md" className="communication-access-state" role="status" aria-live="polite"
    data-testid="communication-access-state" data-state={state}>
    <Inline gap="md" align="start" wrap={false}>
      <Stack as="span" gap="none" align="center" justify="center" className="communication-access-icon" aria-hidden="true">
        {state === 'loading' ? <Spinner size="sm" decorative /> : <LockIcon size={18} />}
      </Stack>
      <Stack gap="xs" className="min-w-0 flex-1">
        <h2><T as="span" size="sm" weight="semibold" wrap>{title ?? copy.title}</T></h2>
        <T size="sm" tone="secondary" wrap>{detail ?? copy.detail}</T>
        {state !== 'loading' && <Inline gap="sm" wrap className="communication-access-actions">
          {signIn && onSignIn && <Button size="sm" variant="primary" disabled={busy} onClick={onSignIn}>Sign in</Button>}
          {onRetry && <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>{busy ? 'Checking…' : 'Try again'}</Button>}
        </Inline>}
      </Stack>
    </Inline>
  </Card>;
}
