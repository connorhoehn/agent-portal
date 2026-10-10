surface: groups
role: author
user: u-tomas
url: /pipelines/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:55–06:56 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-tomas, tenant pipelines, role author; grants pipelines: author; social: participant
screenshot: groups.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; section label "MY PIPELINES"; rows: # · obs-nightly-maintenance · Page discussion · no Social channel
keyboard: pass — 2 distinct Tab stops against 2 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the first row: unbound row opened the page discussion in the plane (/pipelines/communication?group=definition
empty-state: pass — an unknown group id rendered "Not one of your groups This plane lists your own pipelines. Open the page itself to read its discussion. Open page"
realtime: n/a — a page discussion's unread arrives through GET /api/discussions/unread (and a bound channel is the chat surface walked in rail.md); nothing live changed on this surface
role-gating: binding strip only (0 buttons in it); Bind a Social channel is a ManageChannels holder's, which this role does not hold
open: pass — unbound row opened the page discussion in the plane (/pipelines/communication?group=definition:bot:32970d0a-e28e-5100-8fb0-a5cbb87dac99): group pane true, discussion thread true, Open page link true, binding strip says "Social channel No Social channel bound"
notes: Rows: # · obs-nightly-maintenance · Page discussion · no Social channel. No live-call dot: no call was live. 'Link your account to a person' row present: false.
