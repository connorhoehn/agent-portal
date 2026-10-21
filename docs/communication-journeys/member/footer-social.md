surface: footer-social
role: member
user: u-theo
url: /iq/projects (footer Social, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-21 10:08–10:12 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-theo (u-theo-clone-dd00efb5) with seed persona u-mira as the second context, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-theo-clone-dd00efb5 (a clone of u-theo), tenant orgiq, role member; grants orgiq: member; social: participant
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; text "Social 2 online Needs review · 1 agent question waiting for an answer Arrow Up opens the controls. Automatic rotation pauses while focused. " on /iq/projects; Social button 80×28px at x=16; buttons shell-social-open=Social; shell-social-workspace=Open the Social tenant; shell-social-activity-button=Social activity; BUTTON=Needs review · 1 agent question waiting for an answer; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=Device settings
keyboard: pass — 5 distinct Tab stops against 5 visible interactive controls (first stops: shell-social-open, shell-social-workspace, shell-social-activity-button); Enter on the focused Social button landed on /iq/communication/channels/general (expected /iq/communication…)
empty-state: n/a — the footer has no list; a session with no Social grant is walked in no-grant/footer-social.md
realtime: n/a — the footer's online count is the shell roster (read on load: "2 online")
role-gating: every Social participant gets the Social button; inside Social (/social/channels, after switching this clone's session to the social tenant as participant/social, and back after) the Social button left the user on /social/channels
notes: From /iq/projects the Social button landed on /iq/communication/channels/general. The huddle strip read "Social 2 online Needs review · 1 agent question waiting for an answer Arrow Up opens the controls. Automatic rotation pauses while focused. "; no call was live. The clone's session was switched back to orgiq/member afterwards.
