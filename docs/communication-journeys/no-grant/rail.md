surface: rail
role: hr-admin
user: u-hr
url: /iq/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-16 13:44–13:44 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-hr (u-hr-clone-67bd453a), Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-hr-clone-67bd453a (a clone of u-hr), tenant orgiq, role hr-admin; grants orgiq: hr-admin
screenshot: rail.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; the rail reads "Chat Calls Social conversations need a Social grant."; crumbs "Engage›Communication"; data-access=no-grant
keyboard: pass — 1 distinct Tab stops against 1 visible interactive controls (first stops: social-chat-rail-shelf-calls); Enter on "Open Calls" landed on /iq/communication/calls and the Calls destination rendered (tenant-calls-empty or tenant-call-log visible: true)
empty-state: pass — data-access=no-grant renders "Chat Calls Social conversations need a Social grant. Engage › Communication Communication Ask an admin for Social access Your account holds no Social grant, so there are no channels or messages to show. The huddles on this workspace’s pages are under Calls. Open Calls"; /iq/communication/channels/general renders the same denied state (true)
realtime: n/a — a session with no Social grant subscribes to nothing
role-gating: the page made 0 /api/social requests before the walker's own direct GET /api/social/plane/active (answered 403). Present: communication-open-calls=1, social-chat-rail-shelf-calls=1. Social controls found in the DOM: none of the Social controls (new message, rail options, find, Active now, groups)
notes: Denied state is the whole surface for this user; the Calls shelf is kept so the tenant's page huddles stay reachable. The walker is a clone of u-hr, so the grants and person link are u-hr's with its own user id.
