tenant: orgiq
theme: light
user: u-theo
url: /iq/projects
audited: 2026-10-08 07:51 local, headless Chromium 1680x940 (Playwright), Tilt BFF :3001 dev:mock via Vite :5183, theme set through the app's saved preference (orgiq:preferences:v1 theme=light, written before load); no mock reset
screenshot: orgiq-light.jpg
verdict: pass
console errors: 0 on every rhythm surface (0 console.error, 0 pageerror)
layers: body rgb(238, 241, 246) · nav rgb(244, 246, 250) · header rgb(255, 255, 255) · card rgb(255, 255, 255) · panel rgb(244, 246, 250)
contrast: text on bg 15.77:1 · text on surface 17.85:1
brand: #6366f1 (active nav Initiatives, border-left rgb(99, 102, 241) 3px; --color-brand #6366f1, --color-primary #6366f1; html data-tenant=orgiq)
rhythm: initiatives=16px library=16px designs=16px automate=16px session-config=16px local-compute=16px initiative-detail=16px · title 20px 600
notes: Fresh headless walk 2026-10-08 07:51. GET /api/session/me = u-theo (orgiq/member); data-theme absent on every surface. The layers line comes from initiatives; the card value is the header/--color-surface token (the first bg-surface element in <main> was a control, not a Card). Title under trail is measured as h1 top minus the visible breadcrumb trail's bottom; 7 surfaces including the detail page (initiatives, library, designs, automate, session-config, local-compute, initiative-detail); no horizontal scroll on any. NOT counted above: /iq/promotions now redirects to /iq/distillation/review?view=promotions where the title "Asset promotions" sits 8px under the trail (an H2 "Candidates" sits at the top of the list rail), against 16px everywhere else; filed in DEFECTS.md. The accessibility numbers in DEFECTS.md Open 2 (primary button contrast) were not re-measured here. Not run: the same walk at 1280px.
