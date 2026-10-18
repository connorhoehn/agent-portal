tenant: assessment
theme: dark
user: u-asha
url: /assessment/teams /assessment/submissions /assessment/reports /assessment/feedback /assessment/runs /assessment/configuration /assessment/teams/TEAM-001 /settings
audited: 2026-10-17 22:16 EDT, headless Chromium 1680x940 (Playwright), shared Tilt portal :5183 and BFF :3001 dev:mock, ui-components 2.480.3; isolated clone of u-asha
screenshot: assessment-dark.jpg
verdict: pass
console errors: 0 on all eight surfaces (0 console.error, 0 pageerror)
layers: body rgb(10, 61, 61) · nav rgb(10, 66, 66) · header rgb(13, 74, 74) · card rgb(13, 74, 74) · panel rgb(10, 66, 66)
contrast: text on bg 11.12:1 · text on surface 9.27:1
brand: #2dd4bf (active nav Dashboard, border-left rgb(45, 212, 191) 3px; --color-primary #2dd4bf)
rhythm: dashboard=16px submissions=16px reports=16px feedback=16px runs=16px configuration=16px team-detail=16px settings=16px · title 20px 600
button contrast: 9.59:1; + New team, foreground rgb(15, 23, 42), background rgb(45, 212, 191)
notes: Computed body/nav/header and active border on /assessment/teams; actual Profile Card on /settings (see assessment-dark-cards.jpg); actual Dimensions panel on /assessment/teams/TEAM-001. Contrast uses resolved text-primary and measured backgrounds. Title top minus visible breadcrumb bottom measured on every named route, including the detail page. Theme and tenant confirmed after each navigation and /api/session/me confirmed the clone grants. No horizontal page overflow. Theme persisted with orgiq:preferences:v1 before load. Screenshots visually reviewed. No business writes or mock reset; own clone removed after closing the page. Local measurements: .scratch/branding-validation-accepted/assessment-dark.json. Source digest: 528fa8dcdf79dfd11163ba5b712b40f016fa50799bef8451962a1f3fdd53c03d.
