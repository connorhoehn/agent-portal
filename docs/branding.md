# Branding and surface layers

The portal paints from tokens in `portal/src/app.css`. Pages never choose a
colour; they use a token's utility (`bg-surface-panel`, `text-brand`,
`border-border`) on a ui-components composite, and the composites read the
same tokens through `var(--color-…)`.

## The four surface layers

| token | utility | what sits on it | light | dark |
|---|---|---|---|---|
| `--color-bg` | `bg-bg` | the page ground under everything | `#eef1f6` | `#0b1220` |
| `--color-surface-panel` | `bg-surface-panel` | the nav rail, context rails, side panels | `#f4f6fa` | `#111a2e` |
| `--color-surface` | `bg-surface` | cards, tables, the header | `#ffffff` | `#172033` |
| `--color-surface-inset` | `bg-surface-inset` | a well inside a card: code, empty states | `#f8fafc` | `#0f172a` |

`--color-surface-hover` is the row-hover tone one step off `surface`. The
four layers are distinct on purpose: a card on the ground, a rail beside a
card and a well inside a card each read as their own plane. Before this
sheet the ground, the rail and every card were three near-whites within
`#f8fafc`–`#ffffff` and the whole screen compressed into one sheet.

## The brand family

Set per tenant on `[data-tenant]`; `--color-primary` aliases
`--color-brand` so every existing consumer follows it.

| token | utility | use |
|---|---|---|
| `--color-brand` | `bg-brand` / `text-brand` / `border-brand` | the accent: primary buttons, links, the active nav item's edge |
| `--color-brand-hover` | `bg-brand-hover` | pressed / hover accent |
| `--color-brand-ink` | `text-brand-ink` | a deep shade for the tenant mark and emphasis |
| `--color-brand-soft` | `bg-brand-soft` | tinted fill: selected rows, the active nav item |
| `--background-image-brand-gradient` | `bg-brand-gradient` | the header hairline and the tenant mark |

| tenant | brand | gradient |
|---|---|---|
| Org (`orgiq`) | indigo `#6366f1` | indigo → violet → pink |
| Assessment (`assessment`) | teal `#0d9488` | teal → cyan → blue |

## Where the shell applies them

`components/shell/Layout.tsx` marks its regions and `app.css` paints them,
because the library's `SubNavLayout` and `ChannelHeader` take no colour
props:

- the nav host carries `data-shell-nav`; its `<aside>` paints
  `surface-panel`, and the active item is a `brand` left edge on a
  `brand-soft` fill;
- the header carries `className="shell-header"`: `surface` with a 3px
  `brand-gradient` hairline along its top;
- the content column paints `bg`; every `Card` lifts off it in `surface`.

A page's own context rail (a nested section rail such as Automate's) is a
`surface-panel` panel, so it reads as chrome beside the `surface` cards.

**Flush workspace pages.** A page that brings its own header and panes marks
its root `data-shell-flush`; `app.css` then drops the shell's 24px content
padding and hides the shell's breadcrumb row for it, because the page's
header prints the same trail (`useShellBreadcrumbItems`). The initiative
page (`/iq/projects/:id`, the Work four-pane view) is the first: its
ui-components `ScopeHeader` sets its own rhythm — the trail about 6px above
a 22px/600 title, as the Work mockup draws it — so the branding journeys'
16px trail→title rule is judged on pages in the shell's padded column, and
the detail surface in that rule is the Automate job page. Mark a page flush
only when it is a full workspace; a list or record page keeps the shell's
padding and title rhythm.

## Dark

`html[data-theme="dark"]` redefines every colour token `@theme` declares
(`scripts/validate-branding.sh` fails on a light-only token). The theme
attribute is set by `lib/preferences.ts` from the user's device pref.

## Adding a tenant

Add `[data-tenant="<id>"]` and `html[data-theme="dark"] [data-tenant="<id>"]`
blocks with the five brand tokens. Nothing else: the layers are shared.

## Rules

- No raw Tailwind palette classes (`bg-slate-500`, `bg-red-500`) in pages —
  the validator counts them.
- No hex literals in pages: chart series take `var(--color-…)`; the budget
  in `scripts/branding-hex-budget.txt` only goes down.
