surface: footer-social
role: hr-admin
user: u-hr
url: /iq (footer, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-08 06:56–06:57 local, Chromium 1680×940 headless (Playwright), a fresh signed-in context per identity, Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-hr, tenant orgiq, role hr-admin; grants orgiq: hr-admin
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=894–940; text "Messages 0 online No huddle here Huddle Message" on /iq/projects; buttons shell-tenant-open=Messages; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=
keyboard: pass — Enter on Messages (shell-tenant-open) opened the tenant direct-messages panel in place (tenant-dm-panel: true), URL stayed /iq/projects
empty-state: pass — the footer offers no Social button at all (shell-social-open count 0); the panel reads "Messages Messages + New chat  No conversations yet — start a new chat  Choose a direct message Open a conversation, or c"
realtime: n/a — no Social presence for a session without a grant (the footer reads "0 online")
role-gating: Social button absent from the DOM (0); the page made 0 /api/social requests while the footer rendered, across a 2.5s wait and after clicking Messages
notes: No-grant counterpart of the footer rule: no Social entry is drawn, so there is nothing to land on. Opening Messages shows a tenant-scoped panel, not the Social tenant.
