tenant: assessment
theme: light
user: u-asha
url: /assessment/teams /assessment/submissions /assessment/reports /assessment/feedback /assessment/runs /assessment/configuration /assessment/teams/TEAM-001 /settings
audited: 2026-10-17 22:16 EDT, headless Chromium 1680x940 (Playwright), shared Tilt portal :5183 and BFF :3001 dev:mock, ui-components 2.480.3; isolated clone of u-asha
screenshot: assessment-light.jpg
verdict: pass
console errors: 0 on all eight surfaces (0 console.error, 0 pageerror)
layers: body rgb(241, 246, 245) · nav rgb(231, 238, 235) · header rgb(255, 255, 255) · card rgb(255, 255, 255) · panel rgb(231, 238, 235)
contrast: text on bg 13.20:1 · text on surface 14.41:1
brand: #0B6666 (active nav Dashboard, border-left rgb(11, 102, 102) 3px; --color-primary #0B6666)
rhythm: dashboard=16px submissions=16px reports=16px feedback=16px runs=16px configuration=16px team-detail=16px settings=16px · title 20px 600
button contrast: 6.76:1; + New team, foreground rgb(255, 255, 255), background rgb(11, 102, 102)
notes: Computed body/nav/header and active border on /assessment/teams; actual Profile Card on /settings (see assessment-light-cards.jpg); actual Dimensions panel on /assessment/teams/TEAM-001. Contrast uses resolved text-primary and measured backgrounds. Title top minus visible breadcrumb bottom measured on every named route, including the detail page. Theme and tenant confirmed after each navigation and /api/session/me confirmed the clone grants. No horizontal page overflow. Theme persisted with orgiq:preferences:v1 before load. Screenshots visually reviewed. No business writes or mock reset; own clone removed after closing the page. Local measurements: .scratch/branding-validation-accepted/assessment-light.json. Source digest: 528fa8dcdf79dfd11163ba5b712b40f016fa50799bef8451962a1f3fdd53c03d.
