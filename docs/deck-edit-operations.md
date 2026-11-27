# Deck edit operations, charts from reports, templates

The contract the deck editor page and the voice wiring code against. Code: `middleware/src/lib/deck-shared/operations.ts`, `reports.ts`, `templates.ts`, `template-decks.ts`. The rule served is decision 1 of `docs/deck-builder-plan.md`: only validated deck data is written, and chart numbers come from the app's data, never from a model.

## Routes

`<deck>` is the tenant's deck prefix: `/api/initiative-decks`, `/api/assessment/decks`, `/api/pipelines/decks`, `/api/chat/decks`. `<tenant>` is `/api/initiative-decks`, `/api/assessment`, `/api/pipelines` or `/api/chat`.

| Method and path | Who | Answer |
| --- | --- | --- |
| `POST <deck>/:id/operations` | the deck's save rule (`deckWriteAuthority`) | 201 `{ revision, touchedSlideIds, findings, summary, exampleSourceSlideIds }` |
| `GET <deck>/:id/chart-reports` | whoever may read the deck | `{ reports: [{ id, description, params, money }] }` |
| `GET <tenant>/deck-templates` | the tenant's deck readers | `{ templates: [{ id, title, description, audience, slideCount, layouts, preview: [{ id, title, svg }] x3 }] }` |
| `GET <tenant>/deck-templates/:templateId` | the same | `{ id, ..., spec, preview: { slides, warnings, findings } }`; 404 unknown |
| `GET <tenant>/deck-layouts` | the same | `{ layouts: [{ layout, useFor, capacity, example: { templateId, slideId, svg } }] }` |
| create from a template | the tenant's build rule | 201 `{ deckId, revisionId, revision, templateId, exampleSourceSlideIds }` |

Create from a template uses each tenant's existing create path with `{ templateId, title? }` in the body: `POST /api/initiative-decks/projects/:projectId`, `POST /api/assessment/teams/:teamId/decks`, `POST /api/pipelines/runs/:id/decks`, and for Social, which had no direct create, `POST /api/chat/decks` with `{ channel, templateId, title? }`. The deck takes the tenant's theme (`{ ref: '<tenant>' }`), revision 1 is produced by `template:<id>`, and an initiative deck made this way never carries budget figures.

## Operations

Body: `{ baseRevisionId, operations: [...], label? }`. At most 10 operations; they apply in order to the head revision, all or none. A stale `baseRevisionId` answers 409 `{ error, activeRevisionId }`, as a save does. An operation that names a locked slide (`lockedSlideIds`) answers 409. A failing operation answers with its number: `"operation 5 (set_title): no slide nope in this deck"` (400, or 404 for an unknown slide id), with `errors` when the format's validator said why. The result is validated and laid out; `findings` are the layout findings of the touched slides only. The revision's `producedBy` is `operations:<sub>`, its label `Edited by operations` unless `label` is given, and its summary one sentence built from the operations.

| op | fields | notes |
| --- | --- | --- |
| `add_slide` | `layout`, `after?` (slide id, or `'end'`; absent is the end), `title?`, `fields?`, `sources?` | id minted by the server (`s-xxxxxxxx`). Without `fields` the layout gets placeholder words, never numbers; a `chart` slide needs `fields.chart` or a later `set_chart`. Without `sources` it cites `example:unsourced`. |
| `remove_slide` | `slideId` | a deck keeps one slide |
| `move_slide` | `slideId`, and `after` (slide id) or `to: 'start'` | |
| `set_title` | `slideId`, `title` | |
| `set_fields` | `slideId`, `fields` | only the slide's own fields: `eyebrow`, `bullets`, and its layout's payload (`columns`, `chart`, `quote`, `image`, `figures`, `table`, `comparison`, `timeline`, `agenda`, `closing`). Each field is validated alone; `null` removes an optional field. |
| `change_layout` | `slideId`, `layout`, `fields?` | carries what fits (bullets to agenda items or closing steps and back, two columns to the two sides of a comparison and back), drops the rest and says so in the summary |
| `set_notes` | `slideId`, `notes` (string, or `null` to clear) | |
| `set_theme` | `theme`: `'product'`, `'engineering'`, `'plain'` or `{ ref: '<this tenant>' }` | deck level, touches no slide |
| `set_chart` | `slideId`, `kind` (`bar`, `line`, `stacked-bar`, `pie`), and `data: { labels, series }` or `report: { report, params? }` | turns the slide into a `chart` slide. Explicit data past the limits (24 labels, 6 series, a pie's 6 slices and one series) is refused. |

## Reports

A report reads through the provider its own route calls, under the caller's own session, and a refusal has that route's status. Every report belongs to the orgiq tenant: decks of the other tenants are offered none (`{ reports: [] }`).

| id | params | reads | who |
| --- | --- | --- | --- |
| `spend-by-initiative` | `period?`: `month`, `7d`, `30d` | `getSpendReport` grouped by initiative, known USD | budget read tier only; below it 403, never charted without dollars |
| `spend-by-model` | `period?` | the same, grouped by model | budget read tier only |
| `runs-by-outcome` | `initiativeId?` (default: the deck's own), `period?` | the initiative block's run outcomes | any signed-in orgiq session |
| `findings-by-severity` | none | open findings from `findingStats` | any signed-in orgiq session |
| `jobs-by-status` | none | `queueStats` | any signed-in orgiq session |

Values are never invented. A report with nothing to chart answers 409. Past the kind's limit the tail folds into one `Other` value (a pie keeps the top 5; the others keep 23) and the summary says `top 5 and Other`. The slide cites `{ documentId: 'report:<id>', anchor: <period>, title: '<report> (<period>)' }`, and the speaker notes gain `Chart data read from the <id> report at <ISO time>.`

## Templates and example sources

Template ids: `status-update`, `proposal`, `review`, `interview-debrief`, `run-report`. They are about one invented organisation and between them show all 13 layouts. Every template slide cites `{ documentId: 'example:template:<id>', title: 'Example content from the <Title> template' }`. The format's rule is only that each slide cites at least one source, and that rule is unchanged, so a deck made from a template saves as it is. The server names the gap instead: a preview's `warnings` has one sentence per slide that cites only an `example:` source, and the operations and create answers list those slides in `exampleSourceSlideIds`. Replacing the sources with `set_fields` is not possible (sources are not a field); a page replaces them with a save.

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
      "summary": "Set a pie chart on work-status from spend-by-initiative (2026-10-28 to 2026-11-27, top 5 and Other).",
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
