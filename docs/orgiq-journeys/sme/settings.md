surface: settings
role: sme
user: u-nora (Nora DaSilva) — GET /api/session/me on this sign-in: sub u-nora, tenant orgiq, role sme
url: /settings
pages: portal/src/pages/SettingsPage.tsx,portal/src/pages/RangeSliderFrame.tsx,portal/src/pages/settings
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role), mock scenarios touched per fixture and restored to default
screenshot: settings.jpg
verdict: pass
console errors: 0 — and no 4xx response on load (checked with a response listener)
layout: pass — content col left 224px w 1432px (this page sits in the plain System shell with no nested rail), no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Settings" at top 94 under the "System › Settings" trail; sections Profile / Appearance / Keyboard / Security / About / Gateway. Not a list page
keyboard: pass — document-order `.focus()` sweep (headless): 30 of 31 controls accept focus; the refusal is the +N chip. Theme radios, the ⌘K switch and "Sign out other sessions" all focus
empty-state: n/a — no list or filter on this page; the About section reads "Service status ok / Mocks active aurora, agentcore, guardrails, cloudwatch" and the Gateway section says no standalone WebSocket gateway is configured at http://localhost:3001 (BFF-only, live updates over server-sent events)
role-gating: Profile shows Nora DaSilva (u-nora); Security shows "orgiq · sme"; the same sections for every role
notes: Re-walked twice. My first walk logged two console 404s on load (GET http://localhost:3001/cluster and /metrics, the realtime-gateway probes in useGatewayInfo against the BFF, which has neither route). Between the two walks SettingsPage.tsx and useGatewayInfo.ts changed on disk; the second walk, from which every number here comes, shows no 404 and a new Gateway section that states BFF-only mode instead of probing. The pages: line named a Text.tsx that no longer exists; it now names SettingsPage.tsx, RangeSliderFrame.tsx and the settings directory. Screenshot before the keyboard sweep.
