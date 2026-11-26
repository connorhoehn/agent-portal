# Deck builder: plan

Written 26 November 2026. A plan for building presentations inside the product, with agents doing the drafting, the design system deciding how slides look, a skill in the organisation's skill library describing how a good deck is made, and PowerPoint, PDF and image output from one source.

It was written after reading what already exists in four repositories (this one, platform-api, realtime-modules and ui-components). Nothing here is built yet. Every claim about today's code carries a file reference; things I did not verify are listed at the end.

## The short version

You already have most of a deck product: a typed deck format, a PowerPoint renderer, an SVG preview, an editor with versions and presence, agent revision, and two separate builders. What is missing is everything that makes a deck look designed and travel well: a layout model, real text fitting, themes that come from the design system, images and tables, PDF, a build pipeline with more than one drafting step, and a home for "how we make decks" that agents and people share.

The plan is five moves, in this order:

1. **One engine with one home.** Stop copying the deck code between repositories; make realtime-modules `/deck` the authority.
2. **A layout model with three painters.** Lay a slide out once, with real font metrics, then paint that same result as PowerPoint, SVG and PDF. PNG comes from the SVG.
3. **Themes and kits from the design system.** A theme is data derived from the library's tokens and the tenant's brand. A kit is a theme plus the layouts and story patterns allowed with it.
4. **A staged agent pipeline.** Brief, evidence, storyline (with a human approval), draft, layout repair, critique. Every stage hands over typed data that code checks.
5. **A deck skill.** One published skill holds the procedure, the layout catalogue and the writing rules. The in-app pipeline reads its data; agents on machines follow its procedure through `lab deck` commands.

The one decision everything else hangs on: **agents write the deck format, never the file.** No agent produces PowerPoint XML, HTML or renderer code.

## What exists today

### The format and the engine

- One format, `DeckSpec`: a title, an optional subtitle, a theme name and up to 40 slides. A slide has one of seven layouts (title, section, bullets, two-column, chart, quote, image), a title, and that layout's payload, plus speaker notes and at least one source (platform-api `src/deck/DeckSpec.ts:14-83`).
- The validator is hand-written, rejects unknown keys and collects every error (platform-api `src/deck/DeckSpec.ts:120`, `:209-217`, `:328`).
- The engine lives in platform-api `src/deck/` and is copied into realtime-modules `src/deck/`, which this repo's middleware installs as a vendored tarball (`middleware/package.json:43`). ui-components carries a third copy of the types (ui-components `src/components/doc-editor/presentation/deckSpec.ts:3-6`). The copies are told not to fork, by comment only.
- Two painters share constants and nothing else. PowerPoint goes through `pptxgenjs` 4.0.1 with a custom 16:9 size, one master, native bar and line charts, and speaker notes (platform-api `src/deck/renderPptx.ts:44-58`, `:101-179`). The preview is hand-drawn SVG (platform-api `src/deck/renderSlideSvg.ts:189`).
- Each layout is coded twice and the two already disagree: where the subtitle sits, how long titles are handled, bullet colour (platform-api `renderSlideSvg.ts:242`, `:258`; `renderPptx.ts:207`).
- Text fitting is a guess. The SVG assumes 0.52 of the font size per character (`renderSlideSvg.ts:60`); the PowerPoint file sets `shrinkText` and leaves fitting to whichever program opens it (`renderPptx.ts:76`).
- Themes are three fixed palettes, each with one font that is named and not embedded (platform-api `src/deck/theme.ts:57-88`). Every tenant here hard-codes `plain` (`middleware/src/lib/assessment-deck/facts.ts:265`).
- An image slide is a dashed box with the alt text. There are no tables (`renderPptx.ts:163-176`).
- There is no PDF or PNG output anywhere.

### Two builders

- **This repo's middleware**, for four tenants (assessment, initiative, pipeline run, social). A per-tenant fact builder produces a plan for each slide; one agent on Nova Pro writes the prose; code then accepts the prose only if every quote is verbatim from the evidence and every number appears in the facts (`middleware/src/lib/deck-shared/plan.ts:31-71`, `narrative.ts:103-126`). Decks are stored as append-only revisions with a check-and-set save (`middleware/src/lib/flow-artifacts/store.ts:129-158`). The file is rendered on every download (`deck-shared/service.ts:107-117`).
- **platform-api**, for chat. `/deck <what>` starts a pipeline run (read history, read sources, draft, render) and files the result as document revisions, with a content-keyed cache and chunked storage (platform-api `src/documents/deckGeneratePipeline.ts`, `src/deck/pptxCache.ts`, `chunkedBlobStore.ts:14-33`).

### The editor

- ui-components already ships the editor: `PresentationEditor`, `DeckReader`, `DeckPresentationDialog`, the filmstrip, slide form, sources and speaker notes (ui-components' `COMPONENT_INDEX.md:610-686`, in its docs folder). The portal wraps it in one page for all four tenants (`portal/src/components/decks/DeckEditorPage.tsx:229-252`).
- People can add, remove, reorder and edit slides, save versions, see each other's presence, ask an agent to revise, present in a dialog, download `.pptx`, and share the file into a Social conversation.
- Readers of initiative decks can ask a question about the slide in front of them (`middleware/src/lib/presentation-context.ts:7-41`).

### Skills, agents and money

- Skills are runbooks: a reviewed, versioned record rendered to `SKILL.md` with optional `scripts/` and `data/` text files, capped at 32 KB a file and 80 KB a bundle (`middleware/src/lib/runbooks/files.ts:17-30`, `skill.ts:1-26`). The library is synced to devboxes, microVMs and local workers, and changes go through proposals that nobody can accept for themselves (`middleware/src/routes/runbooks.ts:783-833`).
- Agents on machines have no general shell. They have an allowlist, the `lab` commands, and delivery by branch and pull request (`tools/local-compute-worker.mjs:20-30`, `agents/devbox/managed-settings.json`). A run has no field for a generated file.
- The AgentCore agents return JSON or text on Nova Pro, the registry default (`infra/config/model-registry.json:3-12`).
- Spend goes through `reserveSpend` before the first side effect and `recordSpend` after (`middleware/src/lib/spend-holds.ts:76-118`). **Deck generation takes no hold and writes no ledger row today** (`middleware/src/lib/deck-shared/service.ts:123`, `:188`).

### Design tokens

- ui-components exports its tokens as TypeScript (`src/styles/tokens.ts:16-55`, `src/theme/presets.ts:14`), and `ThemeProvider` accepts tone overrides.
- Tenant brand colours exist only as CSS variables in `portal/src/app.css:12-22`; `tenants/manifest.json` has no brand fields. So a server cannot resolve a tenant's brand today.

### Debts found along the way

- The drafting prompts allow 300-character bullets, the Python side caps at 400, and the middleware rejects anything over 200, so long bullets silently fall back to template text (`agents/assessment-drafter/deck_narrative.py:41`, `document_commands.py:138`, `middleware/src/lib/deck-shared/narrative.ts:107`).
- Adding a layout takes at least nine edits across the validator, both painters and four prompt strings.
- The four tenants repeat the agent id, the revise validation and two different asynchronous revise mechanisms.
- Tests check that a file has the right parts. Nothing checks slide content, the slide size or text overflow (platform-api `src/deck/__tests__/renderPptx.test.ts:57-82`).

## Decisions

Each is decided here with its reason, so work can start. Any can be overruled.

### 1. Agents write the deck format, never the file

The common alternative is to give an agent a code sandbox and let it write HTML or renderer code, which is how general-purpose presentation skills work. It is rejected for the product for four reasons. The output would not open in your editor, so nobody could fix a slide by hand. It could not be versioned, cited or revised slide by slide. It needs arbitrary code execution, which no route in the product allows. And the preview, the PowerPoint file and the PDF would no longer be the same thing.

The cost is expressiveness: an agent can only make what the format can say. The answer is to grow the format (decisions 3 and 5), which every deck then benefits from.

### 2. One engine, and it lives in realtime-modules

Make realtime-modules `src/deck/` the authority. platform-api imports it instead of being the source that gets copied; ui-components imports the types and validator from its peer instead of keeping its own. Three copies become one.

Reasons: both consumers already depend on realtime-modules, the middleware already takes its deck code from there, and a new repository would run against the consolidation you have been doing. The engine is split into subpaths so the browser never loads a painter: `/deck` (types, validator, layout, pure and browser-safe), `/deck/paint-pptx`, `/deck/paint-svg`, `/deck/paint-pdf`.

### 3. Lay out once, paint three times

Add a layout step between the spec and the painters:

```
DeckSpec + theme + font metrics
        │  layout()
        ▼
   slide scenes        positioned text, shapes, images, chart frames, tables,
        │              each with its final size, and a list of findings
        ├── paint-pptx  → .pptx   (native charts and tables, editable text)
        ├── paint-svg   → preview (and PNG by rasterising the SVG)
        └── paint-pdf   → .pdf    (vector, selectable text, embedded fonts)
```

- **Font metrics are bundled**, so text is measured the same way everywhere. Fitting is decided in `layout()`, and the PowerPoint file gets explicit sizes instead of relying on the program that opens it. `shrinkText` stays on as a safety net only.
- **Fonts come in metric-compatible pairs.** A theme names an office font for the PowerPoint file and an open font with identical metrics for measuring, the preview and the PDF: Calibri with Carlito, Arial with Liberation Sans. A deck then looks the same in PowerPoint with the office font and in a PDF with the open one. A brand font can be added when the brand supplies a licensed file; it must name a fallback pair.
- **Layouts become definitions.** A layout is declared once: its regions on a 12-column grid, the payload it accepts and its caps. The validator rules, the editor's form and the text shown to models are all derived from that declaration. Adding a layout becomes one definition, and the prompt and cap mismatch above cannot recur.
- **Findings are a product feature.** `layout()` reports overflow, crowding, orphaned lines and low contrast per slide. The editor shows them, the build pipeline repairs them, and the test judge counts them.

### 4. PDF is painted, not converted

The PDF is a third painter over the same scenes, using a pure JavaScript PDF library. Converting the PowerPoint file with LibreOffice is the usual route and is rejected for the product path: it adds hundreds of megabytes and a second layout engine to the image, it is slow to start, and it would make the PDF disagree with the preview. A painted PDF runs locally with no extra services, matches the preview exactly, and can carry things a conversion cannot: a notes-pages variant, links to sources, a document outline.

LibreOffice still has a job, outside the product image: a conformance check in development and CI that opens the generated PowerPoint file, renders it, and compares it with the preview. That is how painter drift gets caught.

PNG thumbnails and contact sheets come from rasterising the SVG with `sharp`, which platform-api already depends on.

### 5. A theme is data from the design system; a kit packages it

- `DeckTheme` becomes an object: colour roles (background, surface, text, muted, accent, six to eight series colours), a type scale by role, a font pair, a logo asset, rule and corner styles, and the footer.
- Themes are **derived**, not hand-picked: a generator maps ui-components' exported tokens to a deck theme, and the tenant's brand colours override the accent roles. For the server to do that, the brand values move from `portal/src/app.css` into `tenants/manifest.json`, and the CSS is generated from or checked against the manifest.
- The spec carries a theme **reference**, never raw colours. A client or a model chooses among published themes; it cannot inject a palette. The three existing names stay as built-in themes so old decks still open.
- Every theme is checked for text contrast when it is saved.
- A **kit** is a theme, the layouts allowed with it, a few story patterns (status update, proposal, review, debrief, run report) and writing rules. Kits are published through the existing runbook proposal path, as `data/` files of a skill, so they get review, versions and scope for free and reach agents by the same sync. A kit is small JSON and fits the 80 KB bundle cap; its logo is an asset referenced by id.

### 6. New layouts instead of free positioning

Structured layouts cover what people actually put on slides, and they stay editable and well fitted. In order of value: key figures (big numbers with labels), table, comparison, timeline, process steps, agenda, closing with next steps, image with real assets, and more chart kinds (stacked bar, pie, scatter, combined). Charts and tables stay native in the PowerPoint file, so a recipient can edit them. Free positioning is left out on purpose; it is the point where decks stop being fitted, themed or repairable by an agent.

### 7. Images are assets

`image` gains an asset id, a fit mode and a focal point. Uploads are re-encoded, capped in pixel size, stripped of metadata, and SVG uploads are rasterised. Assets are stored once by content hash and read only through the host's own store, inside the tenant. The preview's inertness rule, which refuses any `href` or `src` (platform-api `src/work-graph/sources/activityReader.ts:65`), is relaxed for inline raster data only.

### 8. One build pipeline, shared by both hosts

The build steps move into the engine package as plain functions with two inputs supplied by the host: a way to call a model and a way to fetch evidence. This repo's middleware runs them as one of its background runs; platform-api runs the same steps as pipeline steps. There is still one way a deck gets built.

Making platform-api the only builder was the alternative. It is rejected because this repo's mock mode runs without platform-api, and you work local-first.

Inside this repo, the four tenants register a host record (fact builder, authority rule, store, kinds) with one route factory, which removes the repeated agent id, revise validation and revise mechanisms.

### 9. The pipeline: staged, typed, checked by code

```
brief ─▶ evidence ─▶ storyline ─▶ [you approve] ─▶ draft ─▶ layout repair ─▶ critique ─▶ package
```

| Stage | Who does it | Hands over | What code checks |
|---|---|---|---|
| Brief | A form or a chat turn; no model needed | Purpose, audience, the decision wanted, length, kit, sources, must-haves | Sources are readable by the asker |
| Evidence | The tenant's fact builder, chosen documents, knowledge search | Facts, verbatim excerpts, data series and image assets, each with a source id | Every item has a source |
| Storyline | A model: the judgment step | The governing message, sections, and per slide an assertion title, a layout and the evidence that supports it | Every slide has evidence; the count fits the brief; the layout is in the kit |
| Approval | A person, in the editor, on title-only slides | The edited outline | Skippable for a quick draft |
| Draft | A model, one call per section, in parallel | Slide payloads | Today's acceptance rule: quotes verbatim, numbers from the facts, caps. Chart data is copied from the evidence, never written by the model |
| Layout repair | Code first, a model for rewrites | Shorter text or a split slide for each finding | At most two rounds, then a deterministic trim |
| Critique | A model against the brief; optionally a vision model on a contact sheet | Findings from a fixed list, with proposed edits | Edits are applied through the existing revise merge, so facts and sources survive |
| Package | Code | `.pptx`, `.pdf`, PNG thumbnails | Cached by spec hash, theme hash, engine version and format |

Supporting choices:

- **A dedicated agent.** A new `deck-builder` agent beside the others takes the storyline, draft, shorten and critique commands; `deck_narrative.py` moves into it. The models are registry roles, Nova Pro by default, with a separate role for the vision review.
- **One spend hold per build.** Add a `deck` spend source, reserve from the slide count before the first model call, meter as stages finish, settle at the end. Revision gets the same treatment. This closes the gap where decks are free and uncapped.
- **Every stage writes a revision or a run event**, so the build is visible, resumable and attributable.
- **A quick mode** skips approval, critique and the vision review. It is what `/deck` in chat does by default.

### 10. The skill

One published skill, `deck-builder`, holds:

- **The procedure** (`SKILL.md`): how to get from a brief to a deck. One idea per slide, titles that assert, numbers with their source, when each layout fits, how to shorten.
- **Data**: the layout catalogue generated from the engine's definitions, the kit, the writing rules, and two or three worked examples.

It is used in two ways, from the same published version:

- **In the app**, the pipeline reads the skill's data as its prompt material. Improving how decks are written becomes a reviewed skill proposal, not a code change.
- **On a machine**, an agent follows the procedure with new `lab deck` commands, since machines have no general shell: `lab deck validate` returns the validator's errors and the layout findings, `lab deck preview` saves PNG thumbnails the agent can look at, and `lab deck submit` files a revision. A run gains a deck as a kind of delivery, beside a pull request. This is the route for a deck that needs real research in a repository or a long document set.

The debrief step that already drafts runbooks after a good run applies unchanged, so the skill improves from use.

### 11. Where it lives in the product

No new tenant; tenants are separate products. Each tenant gets the same three things:

- **A Decks page**: a table of the tenant's decks with owner, kit, version and last build, and a New deck action that opens the brief. Assessment already has the list; the others gain it.
- **Context actions** where the evidence is: on an initiative, a pipeline run, an assessment, a Social conversation, and a Candidates debrief (a new fact builder).
- **The editor**, extended in ui-components first: a kit and theme picker, a layout gallery with real thumbnails, image upload into a slide, a table and chart data editor, an outline review mode, findings shown on the slide with a "fix this" action, an export menu (PowerPoint, PDF, PDF with notes, images), and a full-screen presenter view with notes and a timer.

Chat keeps `/deck`. The voice navigator gets a `build_deck` capability only after its catalogue is trimmed; it is 652 characters under its limit (ledger row V-1).

### 12. Safety

- The validator stays strict and stays the only door: unknown keys are refused, and every stage output passes through it.
- Evidence is data. The drafting model has no tools, and its output is accepted only when the quotes and numbers trace to the evidence. A hostile document can make a slide wrong; it cannot make the pipeline act.
- Links in a deck are limited to `https` and to the product's own sources. A test scans generated files for external relationships, embedded objects and macros and fails if any appear.
- Rendering runs with a time budget on a worker, so a pathological spec cannot stall the server.
- Authority is unchanged: the existing rule covers build, save, revise and share, and budget decks stay hidden below the budget read tier.

## Phases

Each phase ends in something usable. Phases 1 and 2 can run side by side after phase 0, and phase 3 can start against today's engine because its contract is the deck format.

### Phase 0: one engine, debts paid

- Move the engine's authority to realtime-modules; platform-api and ui-components import it.
- The pins are level as of 26 November: this repo's middleware and frontend both run realtime-modules 0.151.0, so the engine has one consumer version to move.
- Generate the model-facing schema text from the engine, fixing the 300/400/200 bullet mismatch.
- Put deck drafting and revision behind `reserveSpend` with a `deck` source.
- Replace the four tenants' repeated code with host records and one route factory.
- Add content tests: slide size, text present, notes, escaping of hostile strings in the PowerPoint file.

Done when: three copies are one, a deck build shows up in the spend ledger, and the existing deck tests pass unchanged.

### Phase 1: layout model, PDF and images

- A spike first, two days at most: paint three real slides to PDF and measure text against PowerPoint with the font pairs. If the PDF library or the metrics fall short, this is where to find out.
- `layout()` with bundled metrics and findings; the three painters; PNG from SVG.
- Export menu in the editor; a render cache keyed by content; a render time budget.
- The conformance container with LibreOffice, in development and CI only.

Done when: one deck downloads as PowerPoint, PDF and images that agree with the preview, and the editor shows overflow findings.

### Phase 2: themes, kits and layouts

- `DeckTheme` as an object; the generator from ui-components tokens; tenant brand in the manifest.
- Layout definitions, then the new layouts in the order given in decision 6.
- Image assets end to end.
- Kits published as skill data; kit and theme picker; layout gallery.

Done when: each tenant's decks carry its brand without anyone choosing colours, and a new layout is one definition.

### Phase 3: the agent pipeline

- The `deck-builder` agent and its four commands.
- The shared build steps, the run panel, the outline approval, layout repair, critique.
- The Decks page per tenant and the brief dialog; `/deck` on the new pipeline in quick mode.
- The Candidates debrief fact builder.

Done when: a brief plus sources yields a deck with zero layout findings and every claim cited, through an approval a person actually used.

### Phase 4: the skill and the machine route

- Publish the `deck-builder` skill; the pipeline reads its data.
- `lab deck validate`, `preview` and `submit`; a deck as a run's delivery.
- platform-api's chat pipeline adopts the shared steps.

Done when: a dispatched work item returns a deck revision, and a skill proposal changes how the next deck is written with no deploy.

### Phase 5: later, in any order

- Presenter view; the vision review as a default.
- Brand template import: read colours, fonts and logo out of an uploaded PowerPoint template and propose a kit for review. Filling a template's own layouts is a larger job and is not promised here.
- Generated images, behind a spend hold and labelled as generated.
- Milo presenting a deck in a call.

## Who builds what

The release order follows the dependency chain: realtime-modules first, then ui-components and platform-api, then this repo. Library changes are batched into one release per phase, never one per item.

| Lane | Repository | Work | Kind of judgment |
|---|---|---|---|
| A | realtime-modules | Engine authority, layout model, layout definitions, font metrics | Design: the scene model is the piece everything else rests on |
| B | realtime-modules | The three painters, PNG, conformance harness | Routine once lane A fixes the scene shape |
| C | realtime-modules, this repo | Theme object, token generator, tenant brand in the manifest, kits | Design |
| D | ui-components | Editor additions, one release per phase | Routine, library-first |
| E | this repo, `agents/` | The `deck-builder` agent, shared build steps, host records, run panel | Design for the stage contracts, routine after |
| F | this repo | Spend hold, authority, asset store, safety tests | Money and security |
| G | this repo, platform-api | The skill, `lab deck`, deck delivery, platform-api adoption | Routine |

Lanes with design, money or security judgment go to the stronger model; the rest to the routine one, as usual.

## How it gets judged

Following the pattern you already use, the feature gets a goal document and a validator script, with these checks:

- **Mechanical, on a fixed set of briefs with evidence for each tenant:** the spec validates, there are no layout findings, every slide cites a source, every number traces to a fact, titles are sentences within a word cap, the slide count fits the brief, speaker notes are present.
- **Painters:** scene snapshots are stable; the text extracted from the PDF equals the text in the scenes; the PowerPoint file opens cleanly in the conformance container and its rendering stays within a pixel threshold of the preview.
- **Safety:** hostile strings in every text field come out inert in all three outputs; no external relationship, embedded object or macro in any file.
- **Story quality:** a rubric judged by a model, with an offline stand-in in CI and a live run by hand, the same split as Milo's judge.

During the build itself, lanes run the typecheck and the unit tests they touch; the validator is written at the end of each phase.

## Risks

- **Fonts differ between programs.** Keynote and Google Slides substitute fonts differently from PowerPoint. The font pairs, the safety shrink and the conformance check reduce this; they do not remove it. The PDF is the format to send when exact appearance matters.
- **The layout model grows without limit.** It holds six kinds of thing: text, rectangle, line, image, chart, table. Anything else is a new layout built from those, or it is out.
- **The engine package gets heavy.** Fonts and a PDF library add a few megabytes. The subpath split keeps them out of the browser and out of any consumer that only validates.
- **Storage limits.** platform-api caps a stored file at 8 MB and an image in its table store near 350 KB (`src/deck/chunkedBlobStore.ts:14-33`). Decks with images need the filesystem or object store, with assets stored once and files built on demand.
- **Two hosts drift again.** Sharing the build steps prevents it only if neither host adds its own stage. The judge runs against both.

## Not verified

- That a pure JavaScript PDF library covers what the painter needs (embedded fonts, links, outline, vector charts). The phase 1 spike settles it.
- That `sharp` rasterises the preview SVG with the bundled fonts correctly in the container.
- How `shrinkText` behaves in Keynote and Google Slides.
- Whether platform-api's deck model calls reach any spend record. Its deck code has no budget references.
- The exact shape of this repo's background run mechanism for decks (`middleware/src/lib/flow-artifacts/`), which the shared steps would run on. It was mapped by search, not read line by line.
