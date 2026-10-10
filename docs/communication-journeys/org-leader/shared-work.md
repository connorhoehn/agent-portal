surface: shared-work
role: org-leader
user: u-vera
url: /iq/communication/channels/general?view=shared
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/pages/social/SharedWorkView.tsx
audited: 2026-10-08 06:52–06:54 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-vera, tenant orgiq, role member; grants orgiq: org-leader, member; social: participant
screenshot: shared-work.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 916px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; the person view: graph section 842px high, -219px below the view's top, shared-items list 659–711px below the view's top (graph bottom at 623); the element under the first row's point is the row (true)
keyboard: pass — 17 distinct Tab stops against 17 visible interactive controls (first stops: Interval duration, 1 events at 12:00 AM, 1 events at 6:15 AM) in the conversation view; person view 10 distinct Tab stops against 10 visible interactive controls (first stops: plane-person-message, 1 visible item around 06:00. Select latest., summary); a MOUSE click on the first item row opened the far-right pane (true: "Typed prop contracts with generated codemods task task This ")
empty-state: pass — as this user the person view of an outsider (u-sana) answers viewer=none with 0 item rows; the conversation view's text read "Shared in #general Conversation · Today, Thu, Oct 8 · Live · refreshes on change ▱ Project 1 ▤ Document 1 ◌ Conversation" (1 item rows before the walk shared anything)
realtime: limited — viewer states were read on load, not pushed (person view of u-theo: data-viewer=audience, 1 item rows, "TC Theo Chang’s shared work  What Theo Chang has shared with you, and the work referenced in convers"); the share the walk created was stopped at the end of the walk (grant row gone)
role-gating: a viewer sees only what the owner shared into a conversation the viewer is in; an outsider sees viewer=none; this user holds no sharing controls on another person's view (the share form appears only on 'Your work')
notes: Person view of u-theo: data-viewer=audience, 1 shared items, graph error elements 0. u-theo shared "Typed prop contracts with generated codemods" into #general for this walk and stopped at the end of the walk (grant row gone). The DM social:dm:u-farah:u-vera Shared work view listed 1 row(s); clicking the first opened the far-right pane (plane-shared-detail true, kind page, Open page true). Screenshots: shared-work.jpg is the DM (or #general) Shared work view, shared-work-person.jpg is the person view.
