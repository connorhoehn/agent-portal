// /social/rooms — standing rooms you can drop into (docs/social-tenant-design.md
// §4.5, lane S2). The page is the social chat workspace (SocialChatWorkspace.tsx)
// opened on a room: the rail's Rooms section lists them (SocialRoomsSection.tsx,
// the library's hook-bound rooms list), `?room=<slug>` opens one in the pane
// (RoomPane.tsx), where Join call binds the shell's call host to
// `social:room:<slug>`.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function RoomsPage() {
  return <SocialChatWorkspace route="rooms" />;
}
