// The conversation composer, bound once to this portal's realtime-modules
// `useFileUpload` (ui-components 2.439 `createConversationComposer`), and the
// thread side of attachments: `srcFor` resolves a bearer-authenticated download
// to an <img>-usable object URL (the library sends the bearer only to a
// same-origin `/api/uploads/<id>`); `prepare` lands files first and returns the
// message text plus the metadata citing only what the gateway confirmed, by
// upload id (a card's Post — a deck file, a diagram — goes through the same path).
import * as client from '@connorhoehn/realtime-modules/client';
import { ComposerSurface } from '@connorhoehnslalom/ui-components/shared';
import { attachmentOnlyText, createConversationComposer, useConversationUploads } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { createElement, useCallback, type ComponentProps } from 'react';
import { useMentionCandidates } from '../components/chat/useMentionCandidates';
import { CallBlock, callDrawn, useCallHost } from './conversationCall';
import { attachmentMetadata } from './shareToSocial';

const BoundConversationComposer = createConversationComposer(client);
/** Every tenant's composer shares the same branded particle backdrop. Agent
 * is a mode, not a theme: the editor still inherits the app's surface. */
export function ConversationComposer(props: ComponentProps<typeof BoundConversationComposer>) {
  const host = useCallHost();
  const activeCall = !!host?.lobby && callDrawn(host.call.phase, true);
  const carriesCall = activeCall && props.callBlock !== null;
  // A Social channel can be embedded in Work or Assessment; its partition
  // is not the signed-in workspace. The endpoint owns that directory scope.
  const mentions = useMentionCandidates(!props.onSearchPeople, { userId: props.identity?.userId,
    key: props.channel ?? props.context.id });
  return createElement(ComposerSurface, null, createElement(BoundConversationComposer, { ...props, console: false,
    // A central/external input needs the same directory as a thread's input.
    // Social's explicit member-only lookup keeps its existing membership flow.
    onSearchPeople: props.onSearchPeople ?? mentions,
    // A call remains its original huddle while the page changes. Its one media
    // sink follows the visible composer, including another initiative's page.
    callBlock: carriesCall ? createElement(CallBlock, { placement: 'composer', compact: true }) : props.callBlock,
    className: [props.className, carriesCall && 'conversation-call-composer'].filter(Boolean).join(' '),
  }));
}

/** Resolves a bearer-authenticated attachment download to an <img>-usable source (a thread's images). */
export function useAttachmentSource() {
  const gateway = client.useGatewayOptional();
  return client.useAttachmentSrc({ getToken: () => gateway?.authToken }).srcFor;
}

/** `channel` null: no attachments are accepted (`prepare` with files rejects). */
export function useChatAttachmentSend(channel: string | null, displayName: string) {
  const gateway = client.useGatewayOptional();
  const uploadAll = useConversationUploads(client, channel, displayName);
  const { srcFor } = client.useAttachmentSrc({ getToken: () => gateway?.authToken });
  const prepare = useCallback(async (text: string, files: readonly File[] = []) => {
    const uploaded = files.length ? await uploadAll(files) : [];
    return { text: text.trim() ? text : attachmentOnlyText(uploaded), metadata: attachmentMetadata(uploaded), uploaded };
  }, [uploadAll]);
  return { srcFor, prepare };
}
