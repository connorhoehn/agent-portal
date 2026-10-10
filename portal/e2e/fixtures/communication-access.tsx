import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { CommunicationAccessState, type CommunicationAccessStatus } from '../../src/components/communication/CommunicationAccessState';

function Fixture() {
  const [state, setState] = useState<CommunicationAccessStatus>('loading');
  const [signIns, setSignIns] = useState(0), [retries, setRetries] = useState(0);
  return <Stack gap="md" className="min-h-screen bg-surface px-6 py-4">
    <h1><T as="span" size="sm" weight="semibold">Communication</T></h1>
    <Inline gap="xs" wrap>{(['loading', 'invalid', 'signed-out', 'unavailable'] as const).map(value =>
      <Button key={value} size="sm" onClick={() => setState(value)} data-testid={`show-${value}`}>{value}</Button>)}</Inline>
    <CommunicationAccessState state={state} onSignIn={() => setSignIns(value => value + 1)} onRetry={() => setRetries(value => value + 1)} />
    <T size="xs" data-testid="callback-count">Sign ins {signIns}; retries {retries}</T>
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
