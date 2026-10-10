surface: shared-work
role: author
user: u-tomas
url: /pipelines/communication/channels/general?view=shared
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SharedWorkView.tsx
audited: 2026-10-08 06:55–06:56 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-tomas, tenant pipelines, role author; grants pipelines: author; social: participant
screenshot: shared-work.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; the person view: graph section 818px high, -195px below the view's top, shared-items list 659–711px below the view's top (graph bottom at 623); the element under the first row's point is the row (true)
keyboard: pass — 17 distinct Tab stops against 17 visible interactive controls (first stops: Interval duration, 1 events at 12:00 AM, 1 events at 6:15 AM) in the conversation view; person view 8 distinct Tab stops against 8 visible interactive controls (first stops: plane-person-message, rf__node-work:wi-auth-e1, work-node-work:wi-auth-e1); a MOUSE click on the first item row opened the far-right pane (true: "Cognito consolidation task task This item has no page of its")
empty-state: pass — as this user the person view of an outsider (u-sana) answers viewer=none with 0 item rows; the conversation view's text read "Shared in #general Conversation · Today, Thu, Oct 8 · Live · refreshes on change ▱ Project 1 ▤ Document 1 ◌ Conversation" (1 item rows before the walk shared anything)
realtime: limited — viewer states were read on load, not pushed (person view of u-vera: data-viewer=audience, 1 item rows, "VG Vera Green’s shared work  What Vera Green has shared with you, and the work referenced in convers"); the share the walk created was stopped at the end of the walk (grant row gone)
role-gating: a viewer sees only what the owner shared into a conversation the viewer is in; an outsider sees viewer=none; this user holds no sharing controls on another person's view (the share form appears only on 'Your work')
notes: Person view of u-vera: data-viewer=audience, 1 shared items, graph error elements 0. u-vera shared "Cognito consolidation" into #general for this walk and stopped at the end of the walk (grant row gone). The DM social:dm:u-mira:u-tomas Shared work view listed 0 row(s) (no page reference posted in this walk: limited). Screenshots: shared-work.jpg is the DM (or #general) Shared work view, shared-work-person.jpg is the person view.
