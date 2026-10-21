surface: groups
role: author
user: u-tomas
url: /pipelines/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-21 10:04–10:06 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-tomas (u-tomas-clone-ee1aa51f) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-tomas-clone-ee1aa51f (a clone of u-tomas), tenant pipelines, role author; grants pipelines: author; social: participant
screenshot: groups.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; section label "MY PIPELINES"; rows: # Obs nightly maintenance Pipeline discussion
keyboard: pass — 2 distinct Tab stops against 2 visible interactive controls (first stops: rail-section-header-toggle, conversation-row); Enter on the first row: unbound row opened the page discussion in the plane (/pipelines/communication?group=definition%3Abot%3A32970d0a-e28e-5100-8fb0-a5cbb87dac99)
empty-state: pass — an unknown group id (?group=definition:bot:no-such-pipeline) rendered "Not one of your groups This plane lists your own pipelines. Open the page itself to read its discussion. Open page"
realtime: n/a — a page discussion's unread arrives through GET /api/discussions/unread (and a bound channel is the chat surface walked in rail.md); nothing live changed on this surface
role-gating: the binding strip is not in the DOM (0 elements, so 0 Bind controls); Bind a Social channel is a ManageChannels holder's, which this role does not hold
open: pass — unbound row opened the page discussion in the plane (/pipelines/communication?group=definition%3Abot%3A32970d0a-e28e-5100-8fb0-a5cbb87dac99): group pane true, discussion thread true, Open page link true, no binding strip is drawn (nothing is bound and this role holds no ManageChannels)
notes: Rows: # Obs nightly maintenance Pipeline discussion. Live-call dots: 0 (no call was live). 'Link your account to a person' row present: false. The walker is a clone and keeps its persona's person link.
