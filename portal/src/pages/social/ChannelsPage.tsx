// /social/channels and /social/channels/:slug — the tenant's channels
// (docs/social-tenant-design.md §4.5). The page is the social chat workspace
// (SocialChatWorkspace.tsx: the ConversationRail flush against the shell rail,
// the open conversation beside it) opened on a channel; the route only picks
// what the pane shows. The open channel is a SocialConversation once you are a
// member, and a Join prompt before — the gateway refuses a non-member's
// subscribe, so nothing realtime mounts until the join lands.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function ChannelsPage() {
  return <SocialChatWorkspace route="channels" />;
}
