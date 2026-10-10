tenant: assessment
theme: light
user: u-asha
url: /assessment/teams
audited: 2026-10-08 07:51 local, headless Chromium 1680x940 (Playwright), Tilt BFF :3001 dev:mock via Vite :5183, theme set through the app's saved preference (orgiq:preferences:v1 theme=light, written before load); no mock reset
screenshot: assessment-light.jpg
verdict: pass
console errors: 0 on every rhythm surface (0 console.error, 0 pageerror)
layers: body rgb(241, 246, 245) · nav rgb(231, 238, 235) · header rgb(255, 255, 255) · card rgb(255, 255, 255) · panel rgb(231, 238, 235)
contrast: text on bg 13.20:1 · text on surface 14.41:1
brand: #0B6666 (active nav Dashboard, border-left rgb(11, 102, 102) 3px; --color-brand #0B6666, --color-primary #0B6666; html data-tenant=assessment)
rhythm: dashboard=16px submissions=16px reports=16px feedback=16px runs=16px configuration=16px team-detail=16px · title 20px 600
notes: Fresh headless walk 2026-10-08 07:51. GET /api/session/me = u-asha (assessment/assessor); data-theme absent on every surface. The layers line comes from dashboard; the card value is the header/--color-surface token (the first bg-surface element in <main> was a control, not a Card). Title under trail is measured as h1 top minus the visible breadcrumb trail's bottom; 7 surfaces including the detail page (dashboard, submissions, reports, feedback, runs, configuration, team-detail); no horizontal scroll on any.  The accessibility numbers in DEFECTS.md Open 2 (primary button contrast) were not re-measured here. Not run: the same walk at 1280px.
