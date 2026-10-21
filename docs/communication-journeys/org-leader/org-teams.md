surface: org-teams
role: org-leader
user: u-vera
url: /iq/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-21 10:14–10:16 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-vera (u-vera-clone-d65fa066) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-vera-clone-d65fa066 (a clone of u-vera), tenant orgiq, role member; grants orgiq: org-leader, member; social: participant; access: approver
screenshot: org-teams.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; rows: # Platform Engineering 14 members
keyboard: pass — 2 distinct Tab stops against 2 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the team row opened /iq/communication?orgTeam=t-platform (pane true)
empty-state: pass — ?orgTeam=t-no-such rendered "Not one of your org teams This plane lists the org-graph teams your linked person is on."
realtime: n/a — the row's online count reads the shell roster; no member joined or left while the row was observed
role-gating: team pane: "Engage › Communication Communication Your work PE Platform Engineering 14 members You: Principal Engineer · Nobody online now This team has no Social team channel yet. A moderator can create one. AS Arjun CT Caleb EG Eli"; 'Create team channel' controls: 0 (ManageTeams is a moderator's; neither Work role here holds it, so a holder's control was not observed: limited)
notes: Rows: # Platform Engineering 14 members. The pane drew 0 avatar elements. The team pane does not list shared work (limited, as before). The walker is a clone and keeps its persona's person link, so its org teams are its persona's.
