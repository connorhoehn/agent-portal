surface: org-teams
role: participant
user: u-theo
url: /iq/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:51–06:52 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-theo, tenant orgiq, role member; grants orgiq: member; social: participant
screenshot: org-teams.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; row: # · Platform Engineering · 14 members · 2 online
keyboard: pass — 2 distinct Tab stops against 2 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the team row opened /iq/communication?orgTeam=t-platform (pane true)
empty-state: pass — ?orgTeam=t-no-such rendered "Not one of your org teams This plane lists the org-graph teams your linked person is on."
realtime: n/a — the row's online count reads the shell roster; no member joined or left while the row was observed
role-gating: team pane shows 13 member chips: "PE Platform Engineering 14 members  You: Engineer · 2 online now  This team has no Social team channel yet. A moderator can create one. VG Vera CT Caleb EG Eli LH Layla MM Marcus MO Marcus MS Marcus MJ Maria ND Nora RK R"; 'Create team channel' controls in the DOM: 0 (ManageTeams is a moderator's, so its presence for a holder was not observed here: limited)
notes: API GET /api/graph/teams?scope=mine answered 404 with ? team(s); the pane listed 13 member rows; 'Create team channel' controls: 0. The team pane does not list shared work (limited, as before).
