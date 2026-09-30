// /social/calls — your call log (docs/social-tenant-design.md §4.5, lane S2).
// The page is the social chat workspace (SocialChatWorkspace.tsx) with the
// shelf's Calls destination open: the log is CallLogPane.tsx.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function CallsPage() {
  return <SocialChatWorkspace route="calls" />;
}
