tenant: orgiq
theme: dark
user: u-theo
url: /iq/projects
audited: 2026-10-08 07:51 local, headless Chromium 1680x940 (Playwright), Tilt BFF :3001 dev:mock via Vite :5183, theme set through the app's saved preference (orgiq:preferences:v1 theme=dark, written before load); no mock reset
screenshot: orgiq-dark.jpg
verdict: pass
console errors: 0 on every rhythm surface (0 console.error, 0 pageerror)
layers: body rgb(11, 18, 32) · nav rgb(17, 26, 46) · header rgb(23, 32, 51) · card rgb(23, 32, 51) · panel rgb(17, 26, 46)
contrast: text on bg 17.09:1 · text on surface 14.85:1
brand: #8b91ff (active nav Initiatives, border-left rgb(139, 145, 255) 3px; --color-brand #8b91ff, --color-primary #8b91ff; html data-tenant=orgiq)
rhythm: initiatives=16px library=16px designs=16px automate=16px session-config=16px local-compute=16px initiative-detail=16px · title 20px 600
notes: Fresh headless walk 2026-10-08 07:51. GET /api/session/me = u-theo (orgiq/member); data-theme "dark" on every surface. The layers line comes from initiatives; the card value is the header/--color-surface token (the first bg-surface element in <main> was a control, not a Card). Title under trail is measured as h1 top minus the visible breadcrumb trail's bottom; 7 surfaces including the detail page (initiatives, library, designs, automate, session-config, local-compute, initiative-detail); no horizontal scroll on any. NOT counted above: /iq/promotions now redirects to /iq/distillation/review?view=promotions where the title "Asset promotions" sits 8px under the trail (an H2 "Candidates" sits at the top of the list rail), against 16px everywhere else; filed in DEFECTS.md. The accessibility numbers in DEFECTS.md Open 2 (primary button contrast) were not re-measured here. Not run: the same walk at 1280px.
