surface: footer-social
role: author
user: u-tomas
url: /pipelines/runs (footer Social, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-21 10:04–10:07 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-tomas (u-tomas-clone-ee1aa51f) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-tomas-clone-ee1aa51f (a clone of u-tomas), tenant pipelines, role author; grants pipelines: author; social: participant
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; text "Social TF 3 online Huddle Message" on /pipelines/runs; Social button 80×28px at x=16; buttons shell-social-open=Social; shell-social-workspace=Open the Social tenant; shell-social-activity-button=Social activity; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=Device settings
keyboard: pass — 4 distinct Tab stops against 4 visible interactive controls (first stops: shell-social-open, shell-social-workspace, shell-social-activity-button); Enter on the focused Social button landed on /pipelines/communication/channels/general (expected /pipelines/communication…)
empty-state: n/a — the footer has no list; a session with no Social grant is walked in no-grant/footer-social.md
realtime: n/a — the footer's online count is the shell roster (read on load: "3 online")
role-gating: every Social participant gets the Social button; inside Social (/social/channels, after switching this clone's session to the social tenant as participant/social, and back after) the Social button left the user on /social/channels
notes: From /pipelines/runs the Social button landed on /pipelines/communication/channels/general. The huddle strip read "Social TF 3 online Huddle Message"; no call was live. The clone's session was switched back to pipelines/author afterwards.
