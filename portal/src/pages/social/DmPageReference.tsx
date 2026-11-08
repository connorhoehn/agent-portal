import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Button, Stack } from '@connorhoehn/ui-components/shared';
import { PageReferenceCard } from '../../components/chat/PageReferenceCard';
import { useSession } from '../../lib/auth';
import { CHOOSER } from '../../lib/tenantHome';
import { DmReferenceSession, createDmReferenceReader, dmReferenceKey, type DmReferenceScope } from '../../lib/dmPageReferences';
import type { CallPageDescriptor } from '../../lib/callPages';

export function DmPageReference({ channel, messageId, page }: { channel: string; messageId: string; page: CallPageDescriptor }) {
  const { session } = useSession(); const navigate = useNavigate();
  const [controller] = useState(() => new DmReferenceSession(createDmReferenceReader()));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const identity = session ? JSON.stringify([session.sub, session.tenant, session.role, session.masquerading]) : '';
  const scope = useMemo<DmReferenceScope | null>(() => identity ? { identity, channel, messageId, page } : null,
    [identity, channel, messageId, page.kind, page.id]);
  const key = dmReferenceKey(scope);
  useEffect(() => {
    controller.setScope(scope); if (scope) void controller.refresh();
    const restore = () => { if (document.visibilityState === 'visible') void controller.refresh(); };
    const timer = window.setInterval(restore, 30_000);
    window.addEventListener('focus', restore); document.addEventListener('visibilitychange', restore);
    return () => { controller.setScope(null); clearInterval(timer); window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', restore); };
  }, [controller, scope]);
  const reference = state.key === key ? state.reference : null;
  const open = async () => {
    const current = await controller.refresh();
    if (current?.status !== 'available' || controller.getSnapshot().key !== key) return;
    // A workspace change remains an explicit chooser action. The chooser
    // accepts only canonical initiative/work return destinations.
    navigate(session?.tenant === 'orgiq' || session?.role === 'admin' ? current.href
      : `${CHOOSER}?to=${encodeURIComponent(current.href)}`);
  };
  // The shared card (components/chat/PageReferenceCard): title + trail, from
  // the reference this reader resolved, never the sender's.
  return <Stack gap="none" data-testid="dm-page-reference">
    <PageReferenceCard reference={reference} loading={state.loading} onOpen={() => void open()}
      openTestId="dm-page-reference-open" unavailableTestId="dm-page-reference-unavailable"
      action={state.error ? <Button variant="link" size="sm" className="text-xs" onClick={() => void controller.refresh()}
        data-testid="dm-page-reference-retry">Retry</Button> : undefined} />
  </Stack>;
}
