# Branding journey protocol

One log per tenant × theme — `orgiq-light.md`, `orgiq-dark.md`,
`assessment-light.md`, `assessment-dark.md` — with a screenshot beside it.
`scripts/validate-branding.sh` greps the fields below.

## Sign in

Org: `/select` → Sign in as → Theo Chang (member) → Org tile. Assessment:
`/select` → Sign in as → Asha Nair → Assessment tile. Confirm with
`fetch('/api/session/me')`. Theme: Settings → Appearance (or run
`localStorage` pref + `document.documentElement.dataset.theme`), then
reload; confirm `document.documentElement.getAttribute('data-theme')` is
`dark` for the dark cells and null/absent for light.

## Measure (javascript_tool), on the tenant's home list page

```
const bg = el => getComputedStyle(el).backgroundColor;
layers: body → bg(document.body); nav → bg(document.querySelector('[data-shell-nav] aside'));
        header → bg(document.querySelector('.shell-header'));
        card → bg(the first Card in the content column);
        panel → bg(a surface-panel element: the initiative page's right rail, or the nested SubNavLayout aside)
contrast: WCAG ratio of text-primary on bg and on surface (compute from the resolved rgb values)
brand: getComputedStyle(document.documentElement).getPropertyValue('--color-brand') as observed on the tenant root
       AND the active nav item's border-left colour
```

## Rhythm (same session, ≥ 6 surfaces incl. one detail page)

On each surface: `slot = the shell's content column` (the `div.bg-bg` inside `[data-shell-nav] main`; the breadcrumb trail renders on every route with a section and a page — 2+ crumbs — as the slot's first child, so every title sits 16px under the trail's rule), `t = the page title` (the `PageSection`/`PageHeader` heading — the first `h1`/`h2` in the content column). Record `<surface>=<Math.round(t.getBoundingClientRect().top - (trail ? trail.getBoundingClientRect().bottom : slot.getBoundingClientRect().top))>px` per surface and, once, `title <font-size>px <font-weight>` from `getComputedStyle(t)`. All offsets must agree within 2px and there must be one title size — a page whose title sits lower, or renders smaller, is a defect: file it and fail the log.

## Log format

```
tenant: orgiq
theme: light
user: u-theo
url: /iq/projects
audited: <time>, Chrome <width>px, middleware dev:mock
screenshot: orgiq-light.jpg
verdict: pass
console errors: 0
layers: body rgb(238,241,246) · nav rgb(244,246,250) · header rgb(255,255,255) · card rgb(255,255,255) · panel rgb(244,246,250)
contrast: text on bg 15.2:1 · text on surface 17.4:1
brand: #6366f1 (active nav border-left rgb(99,102,241))
rhythm: initiatives=24px library=24px promotions=24px designs=24px budgets=24px automate=24px initiative-detail=24px · title 20px 600
notes: what a person sees — do the layers read as layers, does anything look unpainted, any hard-coded colour that ignores the theme
```

A card and the header share `surface`; a panel and the nav share
`surface-panel`. The validator requires at least THREE distinct colour
values on the `layers:` line — ground, panel and surface must each be their
own tone — and fails a log where any two of body / nav / card are equal.

## Freshness and sealing

Freshness and sealing follow [docs/journeys.md](../journeys.md): a cell is
stale when the rendered contract of the route its `url:` names changed since
its walk was sealed, or when the theme files (`portal/src/app.css`,
`components/shell/Layout.tsx`) changed — the tokens are what a branding walk
proves, and no sweep measures colour yet. Only
`scripts/journeys/seal.sh docs/branding-journeys`, after a walk, seals.
