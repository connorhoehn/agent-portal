// /social/teams — teams and the channels that belong to them
// (docs/social-tenant-design.md §4.3, §4.5 — lane S2).
//
// Teams are platform-api's (a team's channel is a room carrying its teamId),
// read and written through the BFF: `GET /api/social/teams` (your teams, each
// with its channels), `GET /api/social/teams/:teamId` (members), and the
// ManageTeams writes — create, add, remove — Cedar-gated there. platform-api's
// own rule stands on top: only a team's OWNER adds or removes other people.
//
// The page is the social chat workspace (SocialChatWorkspace.tsx) opened on a
// team: the library's `TeamChannelTree` sits in the chat rail above the DMs and
// channels; `?channel=` opens a team channel as the social conversation pair on
// `social:team:<team>:<channel>`, `?team=` the team's roster (`MembersPanel`).
// Adding people has no library dialog yet (queued in
// docs/ui-components-queue.md): a Modal over the roster's DataTable.

import SocialChatWorkspace from './SocialChatWorkspace';

export default function TeamsPage() {
  return <SocialChatWorkspace route="teams" />;
}
