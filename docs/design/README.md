# Design reference sheet

A picture of the real product for anyone, person or image model, drawing a mock-up of the voice navigator (`docs/voice-navigator-spec.md` §5). Every tile on the sheet is a live component from `@connorhoehn/ui-components` 2.510.1 rendered with fixture data from the middleware's mock org, so a mock-up built from it uses the components, tokens and layout the portal already has.

## Files

| File | What it is |
|---|---|
| `reference-sheet.png` | The whole sheet, light theme, 1600 CSS px wide at 2x |
| `reference-sheet-<section>.png` | One section each: `layout`, `navigation`, `inputs`, `data`, `social`, `voice`, `tokens` |
| `reference-sheet-voice-dark.png`, `reference-sheet-layout-dark.png` | The voice and layout sections in the dark theme |
| `layout-projects.png`, `layout-search.png`, `layout-computer-lab.png`, `layout-social.png` | The real portal pages at 1440×900 (`/iq/projects`, `/iq/search`, `/iq/local-compute`, `/iq/communication/channels`) |
| `layout-social-dark.png` | The communication page in the dark theme |
| `reference-sheet.json` | Every tile's id, section, component, subpath, state and pixel box on the full sheet |
| `voice-dock-codex-prompt.md` | A ready-to-paste prompt for an image model |

Boxes in the JSON are CSS pixels on the full sheet; multiply by 2 for pixels in `reference-sheet.png`.

## Re-rendering

The sheet is a dev-only route, `/dev/reference-sheet` (`portal/src/dev/ReferenceSheet.tsx`, fixtures in `referenceSheetData.ts`). `App.tsx` registers it only when `import.meta.env.DEV` is true, so production builds do not have it.

1. Run the portal dev server (`cd portal && npm run dev`, port 5183) with the middleware behind it. The demo session works without cookies under `INSECURE_DEV_MODE`.
2. Run `node scripts/design/render-reference-sheet.mjs` from the repository root (`--base <url>` or `PORTAL_URL` for another port).

The script uses the portal's own Playwright in headless chromium. If the chromium revision Playwright expects is not in `~/Library/Caches/ms-playwright`, it uses the newest headless shell already there rather than downloading one. It renders with reduced motion, so the ring's rotation and pulse show as a still frame. It never signs in, switches persona or writes data.

The real-page shots show whatever the demo session sees. Today that is an orgiq member with no Social grant, so the communication page shows the access notice and the footer's Social entry reads "Messages" with the today strip beside it. With a Social grant the entry reads "Social" with presence avatars and the activity bell (sheet tiles A-3 and E-11).

## Layout rules (the house style)

The shell is a fixed frame. A header row runs across the top. Below it, from left to right: the primary rail, which holds the tenant's doors in groups (Plan, Design, Build, Engage, System) and folds once you are three levels deep; the section rail, which lists the facets of the area you opened; the page's own list as a flush list rail, never a floating box; then the content column. The content column starts with the full breadcrumb, then the title band with the badge and the one primary action, then the page.

Conversations open in the far-right pane beside the page, not over it. Social lives in the bottom bar: one non-shrinking footer row with the Social entry, presence, activity, the today strip and the huddle half. Nothing social floats at the top of another tenant's page. The voice dock belongs in that footer row, beside the huddle half (spec §5, tile A-4).

List pages are table-first: the table sits above the fold with one compact filter row over it, and no stack of status cards pushes it down. Text goes through the library's `T` and its size, weight and tone tokens; colours come from the tokens in tiles G-1 to G-4, never raw hex.

## Legend

### A. Layout (4 tiles, `reference-sheet-layout.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| A-1 | SubNavLayout + SectionLayout + footer row | `/shared, /video` | orgiq initiative page |
| A-2 | Layout legend | n/a | regions 1-8 |
| A-3 | Footer row | `/shared, /video` | today: idle, no call |
| A-4 | Footer row + VoiceDock | `/shared, /video, /voice` | spec §5 placement: listening, beside the huddle half |

### B. Navigation and shells (8 tiles, `reference-sheet-navigation.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| B-1 | PageHeader | `/shared` | breadcrumbs, badge, actions |
| B-2 | PageHeader | `/shared` | tabs, back link |
| B-3 | Breadcrumbs | `/shared` | md and sm |
| B-4 | ChannelHeader | `/shared` | md, members, actions |
| B-5 | ChannelHeader | `/shared` | sm, tabs |
| B-6 | Tabs | `/shared` | underline, pill, segmented |
| B-7 | PaneHeader | `/shared` | tabs, trailing |
| B-8 | SectionLayout | `/shared` | section rail + header, no list |

### C. Inputs (10 tiles, `reference-sheet-inputs.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| C-1 | Button | `/shared` | all variants, size sm |
| C-2 | Button | `/shared` | all variants, size md |
| C-3 | Button | `/shared` | all variants, size lg |
| C-4 | IconButton | `/shared` | ghost, primary, danger, outline |
| C-5 | Input + FormField | `/shared` | default, prefix, invalid, disabled |
| C-6 | Select + SearchInput + Textarea | `/shared` | default |
| C-7 | SegmentedControl + Switch + Checkbox | `/shared` | neutral, accent; on, off |
| C-8 | ContextComposer | `/social/rich-composer` | empty |
| C-9 | ContextComposer | `/social/rich-composer` | typing |
| C-10 | ContextComposer | `/social/rich-composer` | sending (working) |

### D. Data (11 tiles, `reference-sheet-data.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| D-1 | CollectionPage + DataTable | `/shared` | filter row, 6 rows |
| D-2 | StatusPill | `/shared` | every tone, pill and text |
| D-3 | Chip + Badge | `/shared` | tones, solid, outline, dot |
| D-4 | StatCard in KPIGrid | `/shared` | 4 columns, delta, sparkline |
| D-5 | Card + CardHeader | `/shared` | title, subtitle, action |
| D-6 | ExpertCard | `/shared` | matched skills, evidence |
| D-7 | DotMeter + AudioLevelMeter | `/shared, /video` | budget 20%, 80% (warn); mic 0, 0.3, 0.8 |
| D-8 | EmptyState | `/shared` | block, with action |
| D-9 | EmptyState | `/shared` | line |
| D-10 | LoadingState | `/shared` | loading |
| D-11 | ErrorState | `/shared` | error with retry |

### E. Social (13 tiles, `reference-sheet-social.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| E-1 | PresenceAvatars + PresenceDot + Avatar | `/shared` | sizes 20, 28; online, away, busy, offline |
| E-2 | NotificationCenter | `/shared` | 2 unread, 1 read |
| E-3 | ChatPanel | `/social` | 3 messages, composer |
| E-4 | HuddleBar | `/video` | idle |
| E-5 | HuddleBar | `/video` | joinable |
| E-6 | HuddleBar | `/video` | ringing |
| E-7 | HuddleBar | `/video` | connecting |
| E-8 | HuddleBar | `/video` | live |
| E-9 | HuddleBar | `/video` | reconnecting |
| E-10 | HuddleBar | `/video` | ended |
| E-11 | FooterRow (Social entry + HuddleBar) | `/shared, /video` | in a call: live |
| E-12 | ParticipantTile | `/video` | speaking, muted, hand raised, local |
| E-13 | CallTileRow | `/video` | dock variant, active speaker |

### F. Voice (30 tiles, `reference-sheet-voice.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| F-1 | VoiceActivityRing | `/voice` | off: sm and md at levels 0, 0.3, 0.8 |
| F-2 | VoiceActivityRing | `/voice` | connecting: sm and md at levels 0, 0.3, 0.8 |
| F-3 | VoiceActivityRing | `/voice` | listening: sm and md at levels 0, 0.3, 0.8 |
| F-4 | VoiceActivityRing | `/voice` | thinking: sm and md at levels 0, 0.3, 0.8 |
| F-5 | VoiceActivityRing | `/voice` | executing: sm and md at levels 0, 0.3, 0.8 |
| F-6 | VoiceActivityRing | `/voice` | speaking: sm and md at levels 0, 0.3, 0.8 |
| F-7 | VoiceActivityRing | `/voice` | confirming: sm and md at levels 0, 0.3, 0.8 |
| F-8 | VoiceActivityRing | `/voice` | ended: sm and md at levels 0, 0.3, 0.8 |
| F-9 | VoiceActivityRing | `/voice` | unavailable: sm and md at levels 0, 0.3, 0.8 |
| F-10 | VoiceDock | `/voice` | off, full |
| F-11 | VoiceDock | `/voice` | connecting, full |
| F-12 | VoiceDock | `/voice` | listening, full |
| F-13 | VoiceDock | `/voice` | thinking, full |
| F-14 | VoiceDock | `/voice` | executing, full |
| F-15 | VoiceDock | `/voice` | speaking, full |
| F-16 | VoiceDock | `/voice` | confirming, full |
| F-17 | VoiceDock | `/voice` | ended, full |
| F-18 | VoiceDock | `/voice` | unavailable, full |
| F-19 | VoiceDock | `/voice` | off, compact |
| F-20 | VoiceDock | `/voice` | connecting, compact |
| F-21 | VoiceDock | `/voice` | listening, compact |
| F-22 | VoiceDock | `/voice` | thinking, compact |
| F-23 | VoiceDock | `/voice` | executing, compact |
| F-24 | VoiceDock | `/voice` | speaking, compact |
| F-25 | VoiceDock | `/voice` | confirming, compact (its card is F-16) |
| F-26 | VoiceDock | `/voice` | ended, compact |
| F-27 | VoiceDock | `/voice` | unavailable, compact |
| F-28 | VoiceConfirmCard | `/voice` | Start a computer in 3 projects |
| F-29 | VoiceTurnStrip | `/voice` | 4 turns: done, running, refused |
| F-30 | VoiceTurnStrip | `/voice` | failed tool call; empty |

### G. Tokens (6 tiles, `reference-sheet-tokens.png`)

| Tile | Component | Subpath | State |
|---|---|---|---|
| G-1 | Colour tokens | `portal/src/app.css` | Brand and text |
| G-2 | Colour tokens | `portal/src/app.css` | Surfaces and borders |
| G-3 | Colour tokens | `portal/src/app.css` | Status |
| G-4 | Colour tokens | `portal/src/app.css` | Run states and tenants |
| G-5 | T (type scale) | `/shared` | sizes xs, sm, base, lg × weights |
| G-6 | Stack / Inline gap | `/shared` | none, xs, sm, md, lg, xl |

## What the sheet leaves out

The library's index lists 977 components across 21 entry points. The sheet covers the shells, inputs, data, social, call and voice components a footer mock-up needs. It leaves out, on purpose: the document editor and slides (`/doc-editor`, `/doc-types`), diagrams, graphs and pipelines (`/diagram`, `/graph`, `/pipelines`), identity admin pages (`/identity`), ingest and observability pages, agents and the Computer Lab internals (`/agents`, `/compute`; `layout-computer-lab.png` shows the real page), and the `Wrapped*` realtime adapters, which need a live gateway and render the same components shown here. The library ships no story fixtures in `dist`, so the content comes from the middleware's mock data instead.
