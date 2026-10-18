surface: active-now
role: assessor
user: u-asha
url: /assessment/communication
pages: portal/src/pages/communication/CommunicationPlane.tsx,portal/src/pages/social/SocialChatWorkspace.tsx,portal/src/lib/communicationPlane.ts
audited: 2026-10-17 21:54–21:54 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-17ed1a18) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-asha-clone-17ed1a18 (a clone of u-asha), tenant assessment, role assessor; grants assessment: assessor; social: participant
screenshot: active-now.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; Active now grid: 1 tiles (mira); 0 before u-mira's context opened
keyboard: pass — 1 distinct Tab stops against 1 visible interactive controls (first stops: social-active-now-person-u-mira); Enter on u-mira's tile opened /assessment/communication/dms/social%3Adm%3Au-asha-clone-17ed1a18%3Au-mira (conversation drawn: true)
empty-state: pass — ?person=u-nobody-here rendered the not-found state "No such person here Nobody with that id is in your Social directory. Pick someone from Active now or a conversation." (plane-person-missing), and the raw id appears 0 times in the body
realtime: pass — u-mira's tile appeared 0.257s after her page navigation started (her page finished loading within that time), no reload
role-gating: same for every Social participant: tiles open a DM, the shared-work mark opens that person's shared work; nothing role-specific
notes: The DM uses the clone's own channel; the clone is deleted after the walk. Shared mock fixtures were not reset. The tile for u-mira (label "Mira Okafor, online") opens /assessment/communication/dms/social%3Adm%3Au-asha-clone-17ed1a18%3Au-mira. Section text: "Mira". In-call state: limited — the call log is per person, so a live call is known only to a viewer in it, and no call was live. The walker is a clone; the second context is the seed persona u-mira (a clone's presence is not in any viewer's roster).
