surface: footer-social
role: org-leader
user: u-vera
url: /iq/projects (footer Social, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-08 06:52–06:54 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-vera, tenant orgiq, role member; grants orgiq: org-leader, member; social: participant
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; text "Social 2 online 3 No huddle here Huddle Message" on /iq/projects; Social button 80×26px at x=16; buttons shell-social-open=Social; shell-social-workspace=; shell-social-activity-button=3; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=
keyboard: pass — 4 distinct Tab stops against 4 visible interactive controls (first stops: shell-social-open, shell-social-workspace, shell-social-activity-button); Enter on the focused Social button landed on /iq/communication/channels/auth-migration (expected /iq/communication…)
empty-state: n/a — the footer has no list; a session with no Social grant is walked in no-grant/footer-social.md
realtime: n/a — the footer's online count is the shell roster (read on load: "2 online")
role-gating: every Social participant gets the Social button; inside Social (/social/channels, after switching this session to the social tenant, and back after) the Social button left the user on /social/channels
notes: From /iq/projects the Social button landed on /iq/communication/channels/auth-migration. The huddle strip read "Social 2 online 3 No huddle here Huddle Message"; no call was live. The session was switched back to orgiq afterwards.
