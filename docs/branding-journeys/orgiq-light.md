tenant: orgiq
theme: light
user: u-theo
url: /iq/projects /iq/library /iq/designs /iq/runbooks /iq/local-compute/configuration /iq/local-compute /iq/projects/p-auth-migration /settings
audited: 2026-10-17 22:15 EDT, headless Chromium 1680x940 (Playwright), shared Tilt portal :5183 and BFF :3001 dev:mock, ui-components 2.480.3; isolated clone of u-theo
screenshot: orgiq-light.jpg
verdict: pass
console errors: 0 on all eight surfaces (0 console.error, 0 pageerror)
layers: body rgb(238, 241, 246) · nav rgb(244, 246, 250) · header rgb(255, 255, 255) · card rgb(255, 255, 255) · panel rgb(244, 246, 250)
contrast: text on bg 15.77:1 · text on surface 17.85:1
brand: #4f46e5 (active nav Initiatives2, border-left rgb(79, 70, 229) 3px; --color-primary #4f46e5)
rhythm: initiatives=16px library=16px designs=16px runbooks=16px session-config=16px local-compute=16px initiative-detail=16px settings=16px · title 20px 600
button contrast: 6.29:1; Pair a machine, foreground rgb(255, 255, 255), background rgb(79, 70, 229)
notes: Computed body/nav/header and active border on /iq/projects; actual Profile Card on /settings (see orgiq-light-cards.jpg); actual Agent library section rail on /iq/library. Contrast uses resolved text-primary and measured backgrounds. Title top minus visible breadcrumb bottom measured on every named route, including the detail page. Theme and tenant confirmed after each navigation and /api/session/me confirmed the clone grants. No horizontal page overflow. Theme persisted with orgiq:preferences:v1 before load. Screenshots visually reviewed. No business writes or mock reset; own clone removed after closing the page. Local measurements: .scratch/branding-validation-accepted/orgiq-light.json. Source digest: 528fa8dcdf79dfd11163ba5b712b40f016fa50799bef8451962a1f3fdd53c03d.
