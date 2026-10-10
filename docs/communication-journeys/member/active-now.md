surface: active-now
role: participant
user: u-theo
url: /iq/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:51–06:52 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-theo, tenant orgiq, role member; grants orgiq: member; social: participant
screenshot: active-now.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; Active now grid: 8 tiles (Jonas; Lena; Mia; ; Mira; Vera; ; ); 6 before the other contexts opened
keyboard: pass — 7 distinct Tab stops against 7 visible interactive controls (first stops: rail-section-header-toggle, social-active-now-person-u-jonas, social-active-now-person-u-lena); Enter on u-mira's tile opened /iq/communication/dms/social%3Adm%3Au-mira%3Au-theo
empty-state: pass — ?person=u-nobody-here rendered the not-found state "No such person here Nobody with that id is in your Social directory. Pick someone from Active now or a conversation." (plane-person-missing), and the raw id appears 0 times in the body
realtime: pass — opening u-lena's page made her tile appear 0.246s after her page finished loading (her load took 0.081s), no reload
role-gating: same for every Social participant: tiles open a DM, the shared-work mark opens that person's shared work; nothing role-specific
notes: The tile for u-mira opens /iq/communication/dms/social%3Adm%3Au-mira%3Au-theo. In-call state: limited — the call log is per person, so a live call is known only to a viewer in it, and no call was live.
