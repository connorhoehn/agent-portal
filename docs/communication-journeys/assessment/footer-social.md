surface: footer-social
role: assessor
user: u-asha
url: /assessment/teams (footer Social, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-21 10:00–10:03 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-4ca4b34b) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-asha-clone-4ca4b34b (a clone of u-asha), tenant assessment, role assessor; grants assessment: assessor; social: participant
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; text "Social AN 2 online Huddle Message" on /assessment/teams; Social button 80×28px at x=16; buttons shell-social-open=Social; shell-social-workspace=Open the Social tenant; shell-social-activity-button=Social activity; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=Device settings
keyboard: pass — 4 distinct Tab stops against 4 visible interactive controls (first stops: shell-social-open, shell-social-workspace, shell-social-activity-button); Enter on the focused Social button landed on /assessment/communication/channels/general (expected /assessment/communication…)
empty-state: n/a — the footer has no list; a session with no Social grant is walked in no-grant/footer-social.md
realtime: n/a — the footer's online count is the shell roster (read on load: "2 online")
role-gating: every Social participant gets the Social button; inside Social (/social/channels, after switching this clone's session to the social tenant as participant/social, and back after) the Social button left the user on /social/channels
notes: From /assessment/teams the Social button landed on /assessment/communication/channels/general. The huddle strip read "Social AN 2 online Huddle Message"; no call was live. The clone's session was switched back to assessment/assessor afterwards.
