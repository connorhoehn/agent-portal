// /social/rooms — standing rooms you can drop into (docs/social-tenant-design.md
// §4.5, lane S2). The page is the social chat workspace (SocialChatWorkspace.tsx)
// opened on its directory: RoomDirectory gives the room list the main content
// area, alongside the existing communication rail. `?room=<slug>` opens the pane
// (RoomPane.tsx), where Join call binds the shell's call host to
// `social:room:<slug>`.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function RoomsPage() {
  return <SocialChatWorkspace route="rooms" />;
}
