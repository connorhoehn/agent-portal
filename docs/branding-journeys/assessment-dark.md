tenant: assessment
theme: dark
user: u-asha
url: /assessment/teams
audited: 2026-10-08 07:51 local, headless Chromium 1680x940 (Playwright), Tilt BFF :3001 dev:mock via Vite :5183, theme set through the app's saved preference (orgiq:preferences:v1 theme=dark, written before load); no mock reset
screenshot: assessment-dark.jpg
verdict: pass
console errors: 0 on every rhythm surface (0 console.error, 0 pageerror)
layers: body rgb(10, 61, 61) · nav rgb(10, 66, 66) · header rgb(13, 74, 74) · card rgb(13, 74, 74) · panel rgb(10, 66, 66)
contrast: text on bg 11.12:1 · text on surface 9.27:1
brand: #2dd4bf (active nav Dashboard, border-left rgb(45, 212, 191) 3px; --color-brand #2dd4bf, --color-primary #2dd4bf; html data-tenant=assessment)
rhythm: dashboard=16px submissions=16px reports=16px feedback=16px runs=16px configuration=16px team-detail=16px · title 20px 600
notes: Fresh headless walk 2026-10-08 07:51. GET /api/session/me = u-asha (assessment/assessor); data-theme "dark" on every surface. The layers line comes from dashboard; the card value is the header/--color-surface token (the first bg-surface element in <main> was a control, not a Card). Title under trail is measured as h1 top minus the visible breadcrumb trail's bottom; 7 surfaces including the detail page (dashboard, submissions, reports, feedback, runs, configuration, team-detail); no horizontal scroll on any.  The accessibility numbers in DEFECTS.md Open 2 (primary button contrast) were not re-measured here. Not run: the same walk at 1280px.
