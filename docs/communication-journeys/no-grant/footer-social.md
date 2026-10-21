surface: footer-social
role: hr-admin
user: u-hr
url: /iq/projects (footer, every route)
pages: portal/src/components/shell/SocialFooter.tsx,portal/src/pages/communication/CommunicationPlane.tsx
audited: 2026-10-21 14:32–14:32 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-hr (u-hr-clone-12e4865b), Tilt stack: Vite :5183 over middleware :3001 (dev:mock), mock NOT reset (shared stack)
session: /api/session/me sub u-hr-clone-12e4865b (a clone of u-hr), tenant orgiq, role hr-admin; grants orgiq: hr-admin
screenshot: footer-social.jpg
verdict: pass
console errors: 0
layout: pass — scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940; text "Messages 0 online Needs review · 1 agent question waiting for an answer Arrow Up opens the controls. Automatic rotation " on /iq/projects; buttons shell-tenant-open=Messages; BUTTON=Needs review · 1 agent question waiting for an answer; shell-footer-context-start=Huddle; shell-footer-context-chat=Message; shell-footer-check-devices=Device settings
keyboard: pass — Enter on Messages (shell-tenant-open) opened the tenant direct-messages panel in place (tenant-dm-panel: true), URL stayed /iq/projects; Escape closed it (true)
empty-state: pass — the footer offers no Social button at all (shell-social-open count 0); the panel reads "Messages Work · Conversation overview Catch up here. Open Social to join the conversation. No recent conversations Your recent conversations will appear here. Use Social to find people and participate"
realtime: n/a — no Social presence for a session without a grant (the footer reads "0 online")
role-gating: Social button absent from the DOM (0); the page made 0 /api/social requests while the footer rendered and after pressing Enter on Messages
notes: No-grant counterpart of the footer rule: no Social entry is drawn, so there is nothing to land on. Opening Messages shows a tenant-scoped panel, not the Social tenant.
