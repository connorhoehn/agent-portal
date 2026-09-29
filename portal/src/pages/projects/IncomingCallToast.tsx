// "<caller> is calling" with Accept / Decline, pinned to the viewport corner
// on every /iq page (InitiativeCallHost). The library has no
// IncomingCallToast yet — realtime-examples keeps its own as app code and the
// port left it app-side (docs/social-calls-plan.md step 4) — so it is
// composed here from library primitives only: FloatingCard for the placement,
// Banner for the notice, Inline + Button for the two answers. Queued in
// docs/ui-components-queue.md.
//
// `CallStartedBanner` (ui-components/video) is close but not usable as-is:
// its answers are "Join" / "Dismiss", and its 30 s auto-expire calls the
// dismiss handler — which here is a decline, so a ring left alone would be
// refused on the caller's screen instead of aging out as a missed call
// (useIncomingConversationCalls' TTL does that silently).

import { FloatingCard } from '@connorhoehnslalom/ui-components';
import { Banner, Button, Inline, PhoneIcon } from '@connorhoehnslalom/ui-components/shared';
import type { IncomingConversationCall } from '@connorhoehnslalom/realtime-modules/client/video';

export interface IncomingCallToastProps {
  ring: IncomingConversationCall;
  onAccept(): void;
  onDecline(): void;
}

export function IncomingCallToast({ ring, onAccept, onDecline }: IncomingCallToastProps) {
  return (
    <FloatingCard corner="top-right" width={360} data-testid="incoming-call-toast">
      <Banner
        variant="info"
        layout="stacked"
        icon={<PhoneIcon size={16} />}
        title={`${ring.callerName} is calling`}
        action={(
          <Inline gap="sm">
            <Button size="sm" variant="secondary" onClick={onDecline} data-testid="incoming-call-decline">Decline</Button>
            <Button size="sm" variant="success" onClick={onAccept} data-testid="incoming-call-accept">Accept</Button>
          </Inline>
        )}
      >
        {ring.audioOnly ? 'Audio call' : 'Video call'}
      </Banner>
    </FloatingCard>
  );
}
