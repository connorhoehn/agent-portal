# Deck edit operations, charts from reports, templates

The contract the deck editor page and the voice wiring code against. Code: `middleware/src/lib/deck-shared/operations.ts`, `reports.ts`, `templates.ts`, `template-decks.ts`. The rule served is decision 1 of `docs/deck-builder-plan.md`: only validated deck data is written, and chart numbers come from the app's data, never from a model.

## Routes

`<deck>` is the tenant's deck prefix: `/api/initiative-decks`, `/api/assessment/decks`, `/api/pipelines/decks`, `/api/chat/decks`. `<tenant>` is `/api/initiative-decks`, `/api/assessment`, `/api/pipelines` or `/api/chat`.

| Method and path | Who | Answer |
| --- | --- | --- |
| `POST <deck>/:id/operations` | the deck's save rule (`deckWriteAuthority`) | 201 `{ revision, touchedSlideIds, findings, summary, exampleSourceSlideIds }` |
| `POST <deck>/:id/operations/proposal` | the same save rule | 200 `{ reply, baseRevisionId, operations, lines, destructive, touchedSlideIds, findings, refusal?, engine, reason? }`; nothing is saved |
| `GET <deck>/:id/chart-reports` | whoever may read the deck | `{ reports: [{ id, description, params, money }] }` |
| `GET <tenant>/deck-templates` | the tenant's deck readers | `{ templates: [{ id, title, description, audience, style, slideCount, layouts, preview: [{ id, title, svg }] x3 }] }` |
| `GET <tenant>/deck-templates/:templateId` | the same | `{ id, ..., spec, preview: { slides, warnings, findings } }`; 404 unknown |
| `GET <tenant>/deck-layouts` | the same | `{ layouts: [{ layout, useFor, capacity, example: { templateId, slideId, svg } }] }` |
| create from a template | the tenant's build rule | 201 `{ deckId, revisionId, revision, templateId, exampleSourceSlideIds }` |

Create from a template uses each tenant's existing create path with `{ templateId, title? }` in the body: `POST /api/initiative-decks/projects/:projectId`, `POST /api/assessment/teams/:teamId/decks`, `POST /api/pipelines/runs/:id/decks`, and for Social, which had no direct create, `POST /api/chat/decks` with `{ channel, templateId, title? }`. The deck takes the tenant's theme in the template's style (`{ ref: '<tenant>-<style>' }`), revision 1 is produced by `template:<id>`, and an initiative deck made this way never carries budget figures.

## Operations

Body: `{ baseRevisionId, operations: [...], label? }`. At most 10 operations; they apply in order to the head revision, all or none. A stale `baseRevisionId` answers 409 `{ error, activeRevisionId }`, as a save does. An operation that names a locked slide (`lockedSlideIds`) answers 409. A failing operation answers with its number: `"operation 5 (set_title): no slide nope in this deck"` (400, or 404 for an unknown slide id), with `errors` when the format's validator said why. The result is validated and laid out; `findings` are the layout findings of the touched slides only. The revision's `producedBy` is `operations:<sub>`, its label `Edited by operations` unless `label` is given, and its summary one sentence built from the operations.

| op | fields | notes |
| --- | --- | --- |
| `add_slide` | `layout`, `after?` (slide id, or `'end'`; absent is the end), `title?`, `fields?`, `sources?` | id minted by the server (`s-xxxxxxxx`). Without `fields` the layout gets placeholder words, never numbers; a `chart` slide needs `fields.chart` or a later `set_chart`. Without `sources` it cites `example:unsourced`, or on an initiative's deck the initiative record (`initiative:<projectId>`, the deck's own copy when a slide already cites it). `title` takes a string or text runs. |
| `remove_slide` | `slideId` | a deck keeps one slide |
| `move_slide` | `slideId`, and `after` (slide id) or `to: 'start'` | |
| `set_title` | `slideId`, `title` (a string or `[{ text, emphasis? }]` runs) | |
| `set_fields` | `slideId`, `fields` | only the slide's own fields: `eyebrow`, `bullets`, and its layout's payload (see the layouts below). Bullets only on the layouts that draw them. Icons inside `items`, `figures`, a comparison's sides and a matrix's quadrants must be catalogue names, checked by the engine. Each field is validated alone; `null` removes an optional field. |
| `change_layout` | `slideId`, `layout`, `fields?` | carries what fits (bullets to agenda items, closing steps, cards or process steps and back, two columns to the two sides of a comparison and back), drops the rest, including bullets on a layout that does not draw them, and says so in the summary |
| `set_notes` | `slideId`, `notes` (string, or `null` to clear) | |
| `set_theme` | `theme`: `'product'`, `'engineering'`, `'plain'` or `{ ref: '<this tenant>' }` | deck level, touches no slide; keeps the deck's style |
| `set_chart` | `slideId`, `kind` (`bar`, `line`, `stacked-bar`, `pie`), `data: { labels, series }` or `report: { report, params? }`, and `title?` | a slide that cannot hold a chart becomes a `chart` slide, and what a chart slide does not draw (old bullets, another payload) is dropped and named in the summary (`(it was a bullets slide; dropped bullets)`); a `kpi` slide keeps its layout and takes the chart beside its figures. Explicit data past the limits (24 labels, 6 series, a pie's 6 slices and one series) is refused. With `title` the slide takes it. Filled from a report without `title`, the slide takes the report's title ("Spend by initiative, the last 30 days") whatever it was called before, and the summary names the old and the new title (`and renamed it from "Depots live by week" to "…"`); the voice's confirm card and the report panel say the rename before it is made. |
| `set_style` | `style`: `bold`, `editorial`, `minimal`, `playful`, `corporate` | deck level |
| `set_decoration` | `slideId`, `decoration`: `{ graphic, placement? }`, `'none'`, or `null` | `graphic` is a catalogue name (blob, waves, dots, badge-seal, timeline, rocket, …); `placement` is `corner`, `background` or `title`. `'none'` removes the style's own decoration from the slide; `null` gives it back. |
| `set_emphasis` | `slideId`, `target`: `'title'` or `{ bullet: n }`, `from`, `to?`, `emphasis` (`highlight`, `accent`, `bold`, `underline`, `outline`, `gradient`) or `null` | words counted from 1, `to` defaults to `from`; the other runs keep their emphasis; `null` clears; a space between two marked words joins the run before it |

### Layouts

23 layouts, each with the fields it owns: `title`, `section`, `bullets` (bullets only); `two-column` (`columns`), `chart` (`chart`), `quote` and `big-quote` (`quote`), `key-figures` and `big-number` (`figures`), `table`, `comparison`, `timeline`, `agenda`, `closing`; `process` and `cards` (`items: [{ title, text?, icon? }]`), `matrix` (`{ x, y, quadrants: 4 items }`), `people` (`[{ name, role, detail?, assetId? }]`), `funnel` (`[{ label, value, detail? }]`), `kpi` (`figures` and `chart`); and the image layouts `image`, `image-text`, `image-full` (`image`). Bullets are drawn by `title`, `section`, `bullets`, `two-column`, `big-number`, `image-text` and `image-full`. A layout added without its payload gets starter words.

### Style rides on the theme reference

`DeckSpec` has no style key, and a style must survive revisions, diffs and the two stores without a new column. So the style is stored in the theme reference: `{ ref: '<base>-<style>' }`, where the base is a built-in theme or this tenant (`{ ref: 'orgiq-editorial' }`, `{ ref: 'plain-minimal' }`). `themeChoice` splits it, `withDeckStyle` writes it, `deckStyleOf` reads it (a reference without a style uses the theme's own, bold, or minimal for `plain`), and `resolveDeckTheme` applies the engine's `styledTheme` over the tenant brand, which is never changed by a style. `set_theme` keeps the style; `set_style` keeps the base.

### Pictures

The server never fetches an arbitrary address. An image `url` is refused, in operations and in a person's save alike (`host-rules.ts`); an image is an `assetId`. The painters are given no images yet, so an asset draws as the engine's placeholder and the image-missing finding shows. The templates and sample decks use no image layouts.

## Proposals

The deck editor's composer (Edit) asks for a proposal when the request changes the deck's structure, a slide's layout, the style or theme, a decoration, an emphasis or a chart (`portal/src/components/decks/deckEditIntent.ts`). Rewording goes to `/revise`, which keeps the slide list and the theme by design.

`POST <deck>/:id/operations/proposal` takes `{ instruction, baseRevisionId, slideId? }`. The drafter agent is sent the deck's outline (positions, slide ids, layouts, titles and bullets as plain text) and this schema, in the tenant's operations mode (`operate-review-deck`, `operate-initiative-status-deck`, `operate-pipeline-run-deck`, `operate-social-deck`), and answers with a short reply and at most ten operations. The call is held and booked like a revise (trigger `deck:<tenant>:propose`). The list then gets every check `POST <deck>/:id/operations` makes (`planDeckOperations`), and nothing is saved:

- `lines` has one plain line per operation, in the validator's words ("Change slide 3 from bullets to kpi").
- `refusal: { reason, errors? }` means the validator refused the list; the composer says why and offers no Apply.
- `destructive` is true when the list removes a slide.
- `engine` is `agent`, or `offline` under the local mock, or `fallback` when the agent was unavailable or the spend was refused (`reason` then says why). Both of the last two use a small deterministic proposer.

The composer shows the proposal as the voice's confirm card above its input, with Apply and Discard. Apply sends `{ baseRevisionId, operations }` unchanged to `POST <deck>/:id/operations` as the person, with their own authority. Decision for the first version: every proposal waits for Apply, not only a removal, and a removal also says so on the card.

## Reports

A report reads through the provider its own route calls, under the caller's own session, and a refusal has that route's status. Every report belongs to the orgiq tenant: decks of the other tenants are offered none (`{ reports: [] }`).

| id | params | reads | who |
| --- | --- | --- | --- |
| `spend-by-initiative` | `period?`: `month`, `7d`, `30d` | `getSpendReport` grouped by initiative, known USD | budget read tier only; below it 403, never charted without dollars |
| `spend-by-model` | `period?` | the same, grouped by model | budget read tier only |
| `runs-by-outcome` | `initiativeId?` (default: the deck's own), `period?` | the initiative block's run outcomes | any signed-in orgiq session |
| `findings-by-severity` | none | open findings from `findingStats` | any signed-in orgiq session |
| `jobs-by-status` | none | `queueStats` | any signed-in orgiq session |

Values are never invented. A report with nothing to chart answers 409. Past the kind's limit the tail folds into one `Other` value (a pie keeps the top 5; the others keep 23) and the summary says `top 5 and Other`. The slide cites `{ documentId: 'report:<id>', anchor: <period>, title: '<report> (<period>)' }`, and the speaker notes gain one line a presenter can read, `Figures read 29 November 2026, 14:05 UTC from the report "<report title>".` (with `, the top 5 and Other` when trimmed). Filling the slide again replaces that line, and an older `Chart data read from …` line, rather than adding another.

## Templates and example sources

Template ids: `status-update`, `proposal`, `review`, `interview-debrief`, `run-report`, `quarterly-business-review`, `project-kickoff`, `customer-story`. They are about one invented organisation; each has a `style`, between them they use all five, and they show every layout but the three image ones, with icons, emphasis and a decoration. Every template slide cites `{ documentId: 'example:template:<id>', title: 'Example content from the <Title> template' }`. The format's rule is only that each slide cites at least one source, and that rule is unchanged, so a deck made from a template saves as it is. The server names the gap instead: a preview's `warnings` has one sentence per slide that cites only an `example:` source, and the operations and create answers list those slides in `exampleSourceSlideIds`. Replacing the sources with `set_fields` is not possible (sources are not a field); a page replaces them with a save.

## Examples

Add a timeline after slide `summary`:

```json
POST /api/initiative-decks/idk-1f.../operations
{ "baseRevisionId": "irev-7a...", "operations": [
  { "op": "add_slide", "layout": "timeline", "after": "summary", "title": "Plan",
    "fields": { "timeline": [ { "date": "Jan", "label": "Plan" }, { "date": "Feb", "label": "Build" }, { "date": "Mar", "label": "Ship" } ] } } ] }

201 { "revision": { "id": "irev-9c...", "label": "Edited by operations", "createdAt": "...", "producedBy": "operations:u-sme" },
      "touchedSlideIds": ["s-3f0a91c2"], "findings": [], "summary": "Added a timeline slide at slide 3.",
      "exampleSourceSlideIds": ["s-3f0a91c2"] }
```

A pie of spend by initiative on slide `work-status`:

```json
{ "baseRevisionId": "irev-9c...", "operations": [
  { "op": "set_chart", "slideId": "work-status", "kind": "pie", "report": { "report": "spend-by-initiative", "params": { "period": "30d" } } } ] }

201 { "revision": { "id": "irev-b2...", ... }, "touchedSlideIds": ["work-status"], "findings": [],
      "summary": "Set a pie chart on slide 2 from Spend by initiative, the last 30 days (2026-10-28 to 2026-11-27, top 5 and Other) and renamed it from \"Work status\" to \"Spend by initiative, the last 30 days\".",
      "exampleSourceSlideIds": [] }
```

The slide now holds `chart: { kind: "pie", labels: [5 initiatives..., "Other"], series: [{ name: "Spend (USD)", values: [...] }] }`. Below the budget tier the same request answers 403.

Create from a template, then change its theme:

```json
POST /api/initiative-decks/projects/p-auth-migration
{ "templateId": "status-update", "title": "Auth migration: status" }
201 { "deckId": "idk-44...", "revisionId": "irev-01...", "templateId": "status-update",
      "revision": { "id": "irev-01...", "label": "From the Status update template", "producedBy": "template:status-update", ... },
      "exampleSourceSlideIds": ["title", "agenda", "figures", "chart", "timeline", "floor", "closing"] }

POST /api/initiative-decks/idk-44.../operations
{ "baseRevisionId": "irev-01...", "operations": [ { "op": "set_theme", "theme": "engineering" } ] }
201 { "revision": { ... }, "touchedSlideIds": [], "findings": [], "summary": "Set the theme to engineering.", "exampleSourceSlideIds": [ ...7 ids ] }
```
