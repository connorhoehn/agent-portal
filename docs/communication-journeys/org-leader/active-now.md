surface: active-now
role: org-leader
user: u-vera
url: /iq/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-08 06:52–06:54 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-vera, tenant orgiq, role member; grants orgiq: org-leader, member; social: participant
screenshot: active-now.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=44, y=70, height 823px; content (SectionContent) starts x=344, width 1336px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; Active now grid: 7 tiles (Asha; Lena; Mia; ; Mira; Nora; ); 5 before the other contexts opened
keyboard: pass — 6 distinct Tab stops against 6 visible interactive controls (first stops: rail-section-header-toggle, social-active-now-person-u-asha, social-active-now-person-u-lena); Enter on u-mira's tile opened /iq/communication/dms/social%3Adm%3Au-mira%3Au-vera
empty-state: pass — ?person=u-nobody-here rendered the not-found state "No such person here Nobody with that id is in your Social directory. Pick someone from Active now or a conversation." (plane-person-missing), and the raw id appears 0 times in the body
realtime: pass — opening u-lena's page made her tile appear 0.300s after her page finished loading (her load took 0.153s), no reload
role-gating: same for every Social participant: tiles open a DM, the shared-work mark opens that person's shared work; nothing role-specific
notes: The tile for u-mira opens /iq/communication/dms/social%3Adm%3Au-mira%3Au-vera. In-call state: limited — the call log is per person, so a live call is known only to a viewer in it, and no call was live.
