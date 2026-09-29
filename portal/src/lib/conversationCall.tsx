// The conversation-call pair — the call dock and the incoming-call toast —
// from ui-components 2.407.22's scope-agnostic `integrations/realtime` entry,
// bound once to this portal's realtime-modules video hooks. Composed locally
// until that release (2026-09-29); the local body carried the library's exact
// props and test ids so this swap changed nothing on the page.
import * as video from '@connorhoehnslalom/realtime-modules/client/video';
import { createConversationCallDock } from '@connorhoehnslalom/ui-components/integrations/realtime';

export const ConversationCallDock = createConversationCallDock(video);
export { IncomingCallToast } from '@connorhoehnslalom/ui-components/integrations/realtime';
export type { ConversationCallDockProps, IncomingCallToastProps } from '@connorhoehnslalom/ui-components/integrations/realtime';
