surface: footer-social
role: assessor
user: u-asha
url: /assessment/teams (footer Social, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-08 06:54–06:55 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-asha, tenant assessment, role assessor; grants assessment: assessor; social: participant
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; text "Social +1 5 online 5 No huddle here Huddle Message" on /assessment/teams; Social button 80×26px at x=16; buttons shell-social-open=Social; shell-social-workspace=; BUTTON=+1; shell-social-activity-button=5; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=
keyboard: pass — 4 distinct Tab stops against 4 visible interactive controls (first stops: shell-social-open, shell-social-workspace, shell-social-activity-button); Enter on the focused Social button landed on /assessment/communication/channels/general (expected /assessment/communication…)
empty-state: n/a — the footer has no list; a session with no Social grant is walked in no-grant/footer-social.md
realtime: n/a — the footer's online count is the shell roster (read on load: "5 online")
role-gating: every Social participant gets the Social button; inside Social (/social/channels, after switching this session to the social tenant, and back after) the Social button left the user on /social/channels
notes: From /assessment/teams the Social button landed on /assessment/communication/channels/general. The huddle strip read "Social +1 5 online 5 No huddle here Huddle Message"; no call was live. The session was switched back to assessment afterwards.
