// /social/dms and /social/dms/:lobby — direct messages
// (docs/social-tenant-design.md §4.5). The page is the social chat workspace
// (SocialChatWorkspace.tsx) opened on a DM: its rail lists the caller's
// conversations (`GET /api/social/dms`) under Direct messages; New message
// opens the library's NewConversationPanel over the tenant roster
// (`GET /api/social/people`), and picking someone asks the server for the
// lobby (`POST /api/social/dms`) and opens it. The lobby names its members, so
// the gateway admits exactly those people.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function DmsPage() {
  return <SocialChatWorkspace route="dms" />;
}
