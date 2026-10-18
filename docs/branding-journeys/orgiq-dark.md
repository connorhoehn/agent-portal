tenant: orgiq
theme: dark
user: u-theo
url: /iq/projects /iq/library /iq/designs /iq/runbooks /iq/local-compute/configuration /iq/local-compute /iq/projects/p-auth-migration /settings
audited: 2026-10-17 22:16 EDT, headless Chromium 1680x940 (Playwright), shared Tilt portal :5183 and BFF :3001 dev:mock, ui-components 2.480.3; isolated clone of u-theo
screenshot: orgiq-dark.jpg
verdict: pass
console errors: 0 on all eight surfaces (0 console.error, 0 pageerror)
layers: body rgb(11, 18, 32) · nav rgb(17, 26, 46) · header rgb(23, 32, 51) · card rgb(23, 32, 51) · panel rgb(17, 26, 46)
contrast: text on bg 17.09:1 · text on surface 14.85:1
brand: #8b91ff (active nav Initiatives2, border-left rgb(139, 145, 255) 3px; --color-primary #8b91ff)
rhythm: initiatives=16px library=16px designs=16px runbooks=16px session-config=16px local-compute=16px initiative-detail=16px settings=16px · title 20px 600
button contrast: 6.45:1; Pair a machine, foreground rgb(15, 23, 42), background rgb(139, 145, 255)
notes: Computed body/nav/header and active border on /iq/projects; actual Profile Card on /settings (see orgiq-dark-cards.jpg); actual Agent library section rail on /iq/library. Contrast uses resolved text-primary and measured backgrounds. Title top minus visible breadcrumb bottom measured on every named route, including the detail page. Theme and tenant confirmed after each navigation and /api/session/me confirmed the clone grants. No horizontal page overflow. Theme persisted with orgiq:preferences:v1 before load. Screenshots visually reviewed. No business writes or mock reset; own clone removed after closing the page. Local measurements: .scratch/branding-validation-accepted/orgiq-dark.json. Source digest: 528fa8dcdf79dfd11163ba5b712b40f016fa50799bef8451962a1f3fdd53c03d.
