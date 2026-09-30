// /social/recordings — call recordings you were in (docs/social-tenant-design.md
// §4.5, lane S2). The page is the social chat workspace (SocialChatWorkspace.tsx)
// with the shelf's Recordings destination open: the library's RecordingList +
// RecordingPlayer in RecordingsPane.tsx; `?recording=<id>` picks one.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function RecordingsPage() {
  return <SocialChatWorkspace route="recordings" />;
}
