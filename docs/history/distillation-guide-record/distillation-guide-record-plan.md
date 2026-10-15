# Distillation guide record: build plan

**Target:** `docs/distillation-guide-record-mockup.png`. The transcription is `docs/distillation-guide-record-spec.md`. "Today" is `14367dc1`/`8a7c8aea` on `feat/distillation-guide-record` (worktree `aws-agentcore-wt-guide`).

**How exports were checked:** against the installed dist at `/Users/connorhoehn/Projects/aws-agentcore/portal/node_modules/@connorhoehnslalom/ui-components/dist`. That is version 2.388.2, sha `858b02bd`, the same pin as the worktree's `portal/package.json:17`. The worktree has no `node_modules` of its own. Each export was confirmed with `node import(...)` and `typeof`, and cross-read against the library source at `~/Projects/ui-components/src`.

**Verified present:** `ExplorerLayout`, `ScopeHeader`, `ProcedureSteps`, `SourceList`, `SourceCard`, `RailSectionHeader`, `ContextColumn`, `Disclosure`, `KeyValue`, `ArrowRightIcon`, `DocumentIcon`, `ChevronIcon`, `DropdownMenu` (root). `Banner`, `InlineAlert`, `DetailSection`, `GroupedList`, `SearchInput`, `FilterPopover`, `StatusPill`, `MarkdownView` (/shared). `EditorShell`, `FloatingComposerDock` (/doc-editor). `RichChatComposer`, `ComposerReferences` (/social/rich-composer).

**Verified absent:** `WarningIcon`, `Callout`.

## 1. The mockup vs today, element by element

"Exists" means the component already does it; "NEW" means an addition to ui-components; "portal" means a page-side change only.

| # | Element (mockup) | Today (file:line) | Renders with |
|---|---|---|---|
| 1 | Shell, org rail, Distillation sub-nav | unchanged (`DistillationModule.tsx:86-107`, `SubNavLayout`) | Exists: `SubNavLayout` (/shared). No change. |
| 2 | Explorer pane header "Knowledge", 18px | small 12px "Knowledge" (`KnowledgeTab.tsx:334`) | Exists: `ExplorerLayout` `railTitle="Knowledge"` + `railHeading="prominent"`. Gives an 18px/600 title on a 56px row (`WorkspaceRail.tsx:24-27,49-51`; d.ts `index.d.ts:6972-6975`). |
| 3 | Scope row "GUIDES & FINDINGS" + count pill "11" | not present | NEW: `RailSectionHeader` gets `count?: number`, an always-shown neutral `Chip` at the right. The label style is already 11px caps tertiary (`social/RailSectionHeader.tsx:103-106`). Portal puts it first in `railHeader`. The count is the live tier count `tierCount(L2)`, the same one the sub-nav shows (`KnowledgeTab.tsx:145-148`). |
| 4 | Search field with the filter button on the same row | Search, then hint, then `Select` + filter (`KnowledgeTab.tsx:180-214`) | Exists: `Inline` > `SearchInput` (flex-1, via `wrapperClassName`/`className`) + `FilterPopover trigger="icon"`. The hint `T` moves under the row. |
| 5 | No view `Select` | `Select aria-label="Knowledge view"` (`KnowledgeTab.tsx:190-198`) | Portal: delete it. The sub-nav already chooses the view (`moduleNavModel.ts:49-51`). |
| 6 | Group headings "RECENTLY UPDATED 4" in caps | 14px sentence case + Chip (`GroupedList.tsx:600-605`) | NEW: `GroupedList` gets `groupHeading?: 'title' \| 'label'`. `label` renders 11px caps tertiary semibold with a plain muted count. The default `title` keeps every other caller unchanged. |
| 7 | Rows with no icon: title (one line, ellipsis) + "Procedure · Published · 16h" | `FileKindMark` icon on every row (`KnowledgeTab.tsx:245`) | Portal: drop `icon`. `GroupedListRow.icon` is optional (`GroupedList.tsx:122`). |
| 8 | Selected row: pale indigo fill + 2px left bar | fill only; the bar is `md`-only (`GroupedList.tsx:744`) | NEW: `GroupedList` gets `currentStyle?: 'tint' \| 'bar'` (default `tint`). `bar` adds the inset primary bar at `sm`. |
| 9 | Rail footer ("11 guides & findings", Load more) | `KnowledgeTab.tsx:257-268` | Keep. The mockup crops it, and `validate-distillation.sh:85` requires Load more. |
| 10 | No "Knowledge" H1 band above the panes | `ScopeHeader` title band (`DistillationModule.tsx:109-130`) | Portal: `DistillationModule` renders `ScopeHeader` only for Review and Activity. Knowledge gets the crumbs in its pane (row 11). |
| 11 | Crumb "Build › Distillation › Knowledge" at the top of the content pane; "All repositories" select + "Open Library ↗" at the right | inside the removed band | NEW: `ExplorerLayout` gets `paneHeader?: ReactNode` (a non-scrolling band right of the rail, above pane + aside, testid `-pane-header`). NEW: `ScopeHeader` gets `variant?: 'default' \| 'crumbs'` and `title` becomes optional when `variant='crumbs'`. That variant draws crumbs on the left and the right group (`controls`, `link`) on the right, with no h1, `px-6 pt-3 pb-0`, right group vertically centred against crumb + title (tune to the mockup: select centre about 17px below the crumb baseline). Crumbs, controls and link come from `DistillationModule` through outlet context. |
| 12 | Record title about 26px semibold + "Draft" pill; "Updated 20h ago" | `EditorShell` 20px bold (`EditorShell.tsx:207`), kind mark (`KnowledgeRecord.tsx:178`), crumbs "Guides & findings / Procedure" (`:179`) | NEW: `EditorShell` gets `titleSize?: 'md' \| 'lg'`, where `lg` is `text-[26px] font-semibold leading-8` in the document variant. Portal: omit `kind` and `breadcrumbs`, keep `statusPill` (`StatusPill size="sm"`) and `subtitle`. Pages must not style titles (`validate-branding.sh:71`). |
| 13 | "Sources 4" right-aligned on the tabs' row | in `headActions` on the title row (`KnowledgeRecord.tsx:182-193`) | NEW: `EditorShell` gets `tabsTrailing?: ReactNode`, at the right end of the tab row above the underline (testid `-tabs-trailing`). Content is `Button size="sm" variant="secondary"` "Sources N", plus "Open in Library ↗" when `library_item_id` is set (keeps today's behaviour for published records). |
| 14 | Tabs: Content · History · Runs 2 | `KnowledgeRecord.tsx:194-200` | Exists: `EditorShell` `tabs` (count badge). Portal: the tab moves into the URL (`tab`, `run`). |
| 15 | No collapsed Sources strip on the right | `ContextColumn` rendered whenever an item is selected (`KnowledgeTab.tsx:270-299`) | Portal: render `aside` only while `state.panel === 'sources'` (state open or wide). Collapsing sets `panel:null`, which removes it. `ContextColumn` stays, so `validate-distillation.sh:83` still passes. |
| 16 | "WHEN THIS HELPS" + paragraph | not present (`MarkdownView`/summary instead, `KnowledgeRecord.tsx:66-85`) | Exists: `DetailSection first title="When this helps"` + `T wrap` per paragraph (split on `\n`). Data: `artifact.when_this_helps` (§2). |
| 17 | Rule, then "USE IT IN YOUR WORK", sentence, two buttons, helper line | not present | Exists: `DetailSection title="Use it in your work"`, `T`, `Inline` > `Button variant="primary"` "Draft a plan for my project" + `Button variant="secondary"` "Explain this guide", then `T` (13px tertiary). This copy is UI chrome, so a portal literal is fine. |
| 18 | Amber callout: warning icon, title "Check the redirect before you use this", body, trailing "View run →" | the red note under step 3 + marker (`procedureRunsModel.ts:86-97`) | NEW: `Banner` gets `icon?: ReactNode \| true` (`true` means the tone's default glyph) and `layout: 'callout'`: icon, then title over body, with the action trailing and centred. `inline` and `stacked` are unchanged (`Banner.tsx:38-70`). NEW: `WarningIcon` glyph in `ui/Icons.tsx`, exported from root and /shared like `InfoIcon`. The action is `Button variant="link"` "View run" + `ArrowRightIcon`. Data: `guide.run_warning`. |
| 19 | "THE APPROACH  4 steps": neutral number badges, no ✓/!/○, no red note | `ProcedureStepList` with `stepMarkers` (`ProcedureRuns.tsx:51-63`, `KnowledgeRecord.tsx:80`) | Exists: `DetailSection title="The approach" hint={`${n} steps`}` + `ProcedureSteps numbered` with no `status`. The default `Marker` is already a neutral disc with the number (`work/ProcedureSteps.tsx:76`). Data: `guide.approach`. |
| 20 | "BASED ON": a document tile, "Retire the SAML shim tenant by tenant", meta "Source pattern · auth-service", chevron, whole row opens the pattern | "What the source run found" + "Pattern: … →" link (`KnowledgeRecord.tsx:41-64`) | NEW: `SourceCard`/`SourceList` get `meta?: string` (a quiet line under the title that replaces the age) and `layout?: 'card' \| 'row'`. `row` makes the whole row one button, puts `FileKindMark` in a 32px bordered tile, a 13px medium title, a 12px tertiary meta line, and a trailing `ChevronIcon` (aria-hidden). `SourceList` forwards `layout`. Wrapped in `DetailSection title="Based on"`. Data: `guide.based_on`. |
| 21 | "› Technical details", collapsed | `Disclosure` + `KeyValue` (`KnowledgeRecord.tsx:33-39`) | Exists, unchanged. |
| 22 | Light composer with a faint border | dark particle sky (`backdropTone` default `auto`) | Exists: `RichChatComposer backdropTone="none"` (`RichChatComposer.tsx:486`), wrapped in `FloatingComposerDock` as `realtime-examples/.../PipelinesComposerDock.tsx:353-365` does. |
| 23 | "Agent ▾" at left | `modeControl="menu"` (`ExplainComposer.tsx:30`) | Exists. |
| 24 | "This guide ▾" context dropdown, no × | a removable × chip (`ExplainComposer.tsx:40-41`) | NEW: `ComposerReference` gets `menu?: readonly DropdownMenuSection[]` + `menuLabel?: string`. With a menu, the chip is a `DropdownMenu` trigger (label + chevron) and no remove button is drawn even if `onRemove` is passed (`ComposerReferences.tsx:27-36,82`). It stays in the mode row under `modeControl="menu"` (`RichChatComposer.tsx:2289-2299`). |
| 25 | Placeholder "Describe your project or ask about this guide…" | "Explain when I should use this…" (`KnowledgeRecord.tsx:208`) | Exists: `modePlaceholders.agent`. |
| 26 | Toolbar B · I · link · • · ? and "Ask →" | `toolbar="compact"`, `submitLabel={{agent:'Ask'}}` | Exists, unchanged. |
| 27 | Draft-plan and Explain buttons drive the composer | not present | Exists: the `RichChatComposerHandle` ref (`editor`, `focus`, `insertText`; `RichChatComposer.tsx:226-232`). Prefill mirrors `realtime-examples/.../DocumentComposerDock.tsx:486-493` (`editor.chain().setContent(html).focus('end').run()`). |

**Not needed in the library:** `ProcedureSteps` (no status already means neutral numbers), `DetailSection` (title + hint), `ContextColumn` (just render it conditionally), `StatusPill`, `Button`, `T`.

## 2. Data contract

**Today's L2 wire** (`GET /api/distillation/items/art-010`, confirmed with curl): `id, type, title, summary, body_markdown, cluster_ids, facts, owner, classification, status, reviewed_*, last_used_at, created_by_compaction_id, created_at, updated_at, library_item_id, confidence` (`types.ts:164-196`; `providers/distillation.ts:474-477`).

- Nothing plain-language is stored.
- Step text is `Fact.statement`, which reaches the portal through lineage node labels (`providers/distillation.ts:1816-1821`, `distillationFormat.ts:505-514`).
- The warning's facts exist (`papp-006`: failed at `fact-020`, note "flag flipped but the hosted-UI redirect still resolved to the old domain"; `mock/distillation.ts:1527-1528`). The plain title and reason do not.

### Stored fields to add (plain text, not aggregates, so floor rule 1 is satisfied)

| Row | New field | art-010 fixture value |
|---|---|---|
| `ArtifactRow` (`mock/distillation.ts:124-152`), `Artifact` (`types.ts:164`), `distillation_artifacts` (`schema/distillation_schema.sql:52`) | `when_this_helps: string \| null` | "Planning to move a customer's sign-in to Cognito? Use this guide to plan a gradual switch, keep people signed in, and preserve a way to roll back.\nIt brings together steps and lessons from an earlier migration." |
| `Fact` (`mock:167-181`, `types.ts:148`), `distillation_facts` (`:85`) | `plain: string \| null` | fact-018 "Keep the existing sign-in available as a fallback." · fact-019 "Check that active sessions stay signed in." · fact-020 "Switch one customer and verify sign-in." · fact-021 "Restore the previous sign-in if the checks fail." |
| `ProcedureApplication` (`mock:209-227`, `types.ts:281`), `distillation_procedure_applications` (`:144`) | `advice: string \| null`, `plain_reason: string \| null` | papp-006: advice "Check the redirect before you use this", plain_reason "sign-in still pointed to the old service" |

- Give all 11 artifacts a `when_this_helps` and the art-009 and art-011 steps a `plain`, so every seeded record reads right. Retired art-008 can be null.
- Change the `steps()` helper tuple (`mock:1359-1372`) to take an optional `plain`.
- Compaction-minted artifacts (`providers/distillation.ts:1228-1285`, `1170-1214`) write `when_this_helps: null` and `plain: null`. Nothing in the mock writes plain language, and that is the honest state. No agent under `agents/` writes L2 artifacts; the middleware compaction pass is the only producer (a grep for `body_markdown`/`distill` over `agents/` is empty).

### Server-derived projection

`guide`, embedded in `GET /items/:id` for L2 only (`routes/distillation.ts:170-175`). The provider adds `guideFor(artifactId)` and computes it at read time from rows:

```ts
interface GuideView {
  approach: Array<{ step_id: string; ordinal: number; text: string }>; // stepsOf() (providers:2138), text = plain ?? statement; [] for non-procedures
  based_on: Array<{ id: string; kind: 'cluster'; title: string; repo: string | null; repo_label: string | null }>; // cluster_ids → clusters; repo_label uses the facets rule r.split('/').pop() (providers:1773), so there is one rule for both
  run_warning: null | {
    run_id: string; outcome: 'failed' | 'abandoned'; at: string;
    failed_at_ordinal: number | null;
    title: string;  // advice ?? (failed ? `The last attempt failed at step ${n}` : 'The last attempt was abandoned')
    body: string;   // failed: `The last attempt stopped at step ${n}${plain_reason ? ` because ${plain_reason}` : ''}.`
                    // abandoned: `The last attempt was abandoned${plain_reason ? `: ${plain_reason}` : ''}.`
  };
}
```

- `run_warning` is non-null only when the latest application, taken in `listApplications` order (`providers:2214-2220`, newest first then id DESC, the same order the Runs tab uses), is failed or abandoned. For art-010 the result reproduces the mockup's body text exactly.
- Also add `meta.plain` to `nodeForFact`, so the Runs tab's lineage-based steps (`ProcedureRuns.tsx:37-40`) can show the same text as `meta.plain ?? label`.
- `POST /procedures/:id/apply` (`routes/distillation.ts:322-337`, `providers:2236-2273`) accepts optional `advice` and `plain_reason` (strings, trimmed, at most 200 characters, and only on failed or abandoned runs). This gives the real write path a way to supply them. `RecordRunForm` does not have to expose them yet.

### Aurora

The corpus has **no Aurora read path**: `providers/distillation.ts:31-38,1624-1631` and `distillation-store.ts:5-12` say so, and only compactions and ingest writers read Aurora. So:

- Add the three columns to the `CREATE TABLE` blocks, plus `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for clusters built before them (same idiom as `distillation_schema.sql` line 111).
- Document that the corpus is still mock-first.
- Do not claim Aurora supplies these fields.

### Mock-floor rules that apply

- No typed counts. "4 steps" is `approach.length` in the portal, and `run_warning` is computed on each read.
- No new timestamps.
- `applyProcedure` writes the registered applications fixture, so `POST /api/__mock/reset` undoes it.
- Re-capture `wire.json` after the shape change. Rule 6 fails when `wire.json` is older than a provider or mock source (`docs/mock-floor.md:400-445`). Use the full-env server on :3012, not :3001, which is already running.
- Update the `bodyFrom` for `POST …/apply` in `mock/core/wire/write-policy.ts:1455-1460`.

### Fixture changes the image implies (decide before building)

- `cl-010`'s title "Retire the SAML shim tenant by tenant, not in one cutover" (`mock:896`) should become "Retire the SAML shim tenant by tenant". No test or journey references the old string.
- Repo label: the mockup says "auth-service", but the repo is `connorhoehnslalom/orgiq-auth-service` (`mock:329`) and the facets rule yields "orgiq-auth-service". **Recommendation:** accept "orgiq-auth-service" as a recorded deviation (renaming REPO.AUTH ripples through initiatives, facets, bots and seed parity), or add a display-name map on the server. This is the user's call.

### Composer behaviour

Mode stays Agent only, with chat and terminal disabled as today. Sending navigates to `/iq/invoke?prompt=…`, which auto-sends through realtime-modules `useAgentStream` (`InvokePage.tsx:3,549-566`). That keeps `validate-distillation.sh:88`.

- **"Draft a plan for my project" prefills and does not send.** It sets the context to `guide` and puts "Draft a plan for my project using this guide. My project: " in the editor with the caret at the end. The person types their project and presses Ask. This is the same pattern as `DocumentComposerDock.tsx:355-357`: prefill, then the person reviews and sends.
- **"Explain this guide" submits straight away.** It navigates with `guidePrompt('Explain this guide in plain language — when to use it and how.', subject, guide, context)`.
- **"This guide ▾" options:**
  - `guide` (default): the prompt carries title, id, `when_this_helps` and the numbered approach.
  - `guide+sources`: adds the `based_on` titles and the `run_warning` title and body.
  - `none`: labelled "No context", which replaces today's ×.
- Every prompt keeps the "Explain only; do not change anything." guard (`knowledgeModel.ts:346-349`).
- Review keeps today's composer unless the user wants it light too (`ExplainComposer` gets `backdropTone`, default `'auto'`).

## 3. Work breakdown

The order is A and C in parallel, then B, then D2; D1 can start alongside A and C.

### (A) ui-components: one batched additive release, 2.389.0

- **Where:** a new worktree from **origin/main**, which is at 2.388.4 (`9bfd2f73`), ahead of local main at 2.388.2. Do not touch `~/Projects/ui-components` main or the more than 20 `ui-components-*` and scratch worktrees.
- **Files:**
  - `shared/Banner.tsx` (`icon`, `layout:'callout'`)
  - `ui/Icons.tsx` (`WarningIcon`) and its barrel re-exports
  - `doc-editor/EditorShell.tsx` (`titleSize`, `tabsTrailing`)
  - `layout/ExplorerLayout.tsx` (`paneHeader`)
  - `work/ScopeHeader.tsx` (`variant:'crumbs'`, optional `title`)
  - `shared/GroupedList.tsx` (`groupHeading`, `currentStyle`)
  - `work/SourceCard.tsx` (`meta`, `layout:'row'`)
  - `social/ComposerReferences.tsx` (`menu`, `menuLabel`)
  - `social/RailSectionHeader.tsx` (`count`)
- **Each change needs:** a `__tests__/*.test.tsx` case and a `*.stories.tsx` entry.
- **Release steps:** `CHANGELOG.md` entry, version 2.389.0 in `package.json` and the lock, `npm run snapshot:exports` (`src/__tests__/export-surface.snapshot.ts`), and `npm run build` so `dist` is committed in the release commit only.
- **Tests:**
  - `callout` renders the title above the body with the action last, and `role=alert` for warning.
  - `tabsTrailing` renders inside the header after the tablist.
  - `titleSize=lg` puts the 26px class on the h1.
  - `paneHeader` sits outside the scrolling pane.
  - `ScopeHeader variant="crumbs"` has no h1 but does have crumbs and controls.
  - `groupHeading="label"` renders uppercase with the count; `currentStyle="bar"` at `sm` adds the inset bar.
  - `SourceCard layout="row"`: a click anywhere calls `onOpen`, the accessible name is the title, the meta line renders, the chevron is aria-hidden.
  - A reference with `menu` shows no remove button, opens the menu and fires the item's `onSelect`.
  - `RailSectionHeader count` renders the Chip.
- **Acceptance:** `npm test && npm run lint && npm run lint:static-styles && npm run build`, green except the packaging /doc-editor optional-peers test, which already fails on origin/main (see the `858b02bd` message). Then `grep -c "tabsTrailing\|titleSize" dist/doc-editor.d.ts` ≥ 2, `grep -c "paneHeader\|groupHeading\|currentStyle" dist/index.d.ts` ≥ 3, and `node -e "import('./dist/index.js').then(m=>console.log(typeof m.WarningIcon))"` prints `function`.
- **Push:** rebase onto origin/main just before pushing. If 2.389.0 is taken, take the next minor.

### (B) Pin bump (after A)

- **Files:** worktree `portal/package.json:17` (full 40-character sha), `portal/package-lock.json`, `CLAUDE.md:239-244` (version and sha).
- **Steps:** `cd portal && npm install` (the worktree has no `node_modules`; resolves over SSH), then `rm -rf node_modules/.vite`.
- **Acceptance:** from `portal/`, `node -e "console.log(require('@connorhoehnslalom/ui-components/package.json').version)"` prints 2.389.0, and `node --input-type=module -e "import('@connorhoehnslalom/ui-components').then(m=>console.log(typeof m.WarningIcon))"` prints `function`. Check new optional peers (`CLAUDE.md:241-244`).

### (C) Middleware, types, fixtures and schema (parallel with A; no portal files)

- **Files:**
  - `middleware/src/mock/distillation.ts`: fields, fixture values, `steps()`, the cl-010 title if decided.
  - `middleware/src/providers/distillation.ts`: `guideFor`, `nodeForFact` meta, apply validation, null fields in `runL2Compaction`/`mint*Facts`.
  - `middleware/src/routes/distillation.ts`: `/items/:id` embeds `guide`; apply body.
  - `middleware/src/mock/core/wire/write-policy.ts`
  - `middleware/src/mock/core/wire/snapshots/{wire,writes}.json` (re-capture)
  - `schema/distillation_schema.sql`
- **Tests:**
  - `providers/__tests__/distillation-domain.test.ts`:
    - art-010 `guide` equals the expected approach, `based_on` (cl-010, `repo_label`) and `run_warning` (`papp-006`, `failed_at_ordinal` 3, the exact title and body).
    - art-009 and art-011 have `run_warning` null.
    - `applyProcedure(art-010, succeeded)` clears the warning; an abandoned run with `plain_reason` gives the abandoned body; reset restores the seed.
    - A minted artifact has null fields and `text === statement`.
  - `routes/__tests__/distillation-routes.test.ts`: `/items/art-010` has `guide`, `/items/cl-010` has none, apply rejects `advice` on a succeeded run.
- **Acceptance:** `cd middleware && npx tsc --noEmit && npx jest src/routes/__tests__/distillation src/providers/__tests__/distillation`. Then, on the :3012 capture server, `curl -s localhost:3012/api/distillation/items/art-010 | node -e "d=JSON.parse(require('fs').readFileSync(0));console.log(d.when_this_helps&&d.guide.approach.length, d.guide.run_warning.body)"` should print `4 The last attempt stopped at step 3 because sign-in still pointed to the old service.` Finally `./scripts/validate-mock-floor.sh` and `./scripts/validate-route-coverage.sh`.

### (D1) Portal pure models (parallel with A and C; `.ts` only)

- **Files:**
  - `types.ts`: `when_this_helps`, `GuideView`, `Artifact.guide?`, `Fact.plain`, application fields.
  - `knowledgeModel.ts`: `guideContext` options/labels, `guidePrompt`, `PLAN_PREFILL`, `basedOnRows` (kind label "Source pattern"), `approachSteps`.
  - `distillationRoutes.ts`: `KnowledgeState.tab: 'content'|'history'|'runs'` (default content, omitted when serialised) and `run`.
  - `procedureRunsModel.ts`: `stepMarkers(steps, runs, runId?)` to show a chosen run.
- **Tests:** the matching `__tests__/*.test.ts`.
- **Acceptance:** `cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'`.

### (D2) Portal TSX (after B and C)

- **`DistillationModule.tsx`:** show `ScopeHeader` only when not on Knowledge. Outlet context gains `scope: { breadcrumbs, controls, link }`.
- **`KnowledgeTab.tsx`:**
  - `railTitle` + `railHeading="prominent"`.
  - `railHeader` = `RailSectionHeader count` + search/filter `Inline` + hint.
  - No `Select`, no row `icon`, `groupHeading="label"`, `currentStyle="bar"`.
  - `paneHeader={<ScopeHeader variant="crumbs" …/>}`.
  - `aside` only while `panel==='sources'`.
  - `go({item, tab:null, run:null})` when a row is picked.
- **`KnowledgeRecord.tsx`:**
  - `titleSize="lg"`, no `kind` or `breadcrumbs`, `tabsTrailing`, tab/run from the URL.
  - Procedure Content: WHEN, USE, `Banner layout="callout"`, APPROACH (`ProcedureSteps` without status), BASED ON (`SourceList layout="row"`), Technical details.
  - Guide Content: WHEN, USE, markdown body, BASED ON, Technical details.
  - When `when_this_helps` is null, fall back to today's lead text (summary or markdown).
  - Delete `SourceRunFound`.
- **`ProcedureRuns.tsx`:** `ProcedureStepList` gets `markers` (true on the Runs tab, which still shows the latest-run markers and callout) and honours `run`.
- **`ExplainComposer.tsx`:** `forwardRef` handle, `backdropTone`, `references` with `menu`, `FloatingComposerDock`, the new placeholder, `onSend` → `guidePrompt`.
- **Acceptance:**
  - `npx tsc --noEmit && npx vite build`
  - `./scripts/validate-distillation.sh --quick` (component discipline 0 raw, 0 `style={{}}`)
  - `./scripts/validate-component-discipline.sh`
  - `./scripts/validate-honest-numbers.sh`
  - `grep -c 'aria-label="Knowledge view"' portal/src/pages/distillation/KnowledgeTab.tsx` is 0
  - `grep -c "stepMarkers" portal/src/pages/distillation/KnowledgeRecord.tsx` is 0

### (E) Docs, validator and journeys (last)

- **Docs:** `docs/distillation-redesign-spec.md` §1 (the Knowledge paragraph: no view selector, the record layout, markers only on Runs), `docs/distillation.md`, `docs/mock-floor.md` (a note on the new fields).
- **Validator** `scripts/validate-distillation.sh`, new checks:
  - no `Knowledge view` Select;
  - `KnowledgeRecord` uses `Banner` + `run_warning` and does not use `stepMarkers`;
  - `when_this_helps` count in the mock ≥ 3;
  - `guideFor` present in the provider.
- **Journeys:** re-walk **all six** `docs/distillation-journeys/{member,org-leader}/{knowledge,review,activity}.md`, because every `pages:` line names `DistillationModule.tsx` and freshness is checked at `validate-distillation.sh:154-181`. Include new screenshots and a `first-row-top` ≤ 640.
- **Acceptance:** `./scripts/validate-distillation.sh` exits 0.

### Which slices can run at the same time

- A (ui-components repo), C (`middleware/**` + `schema/`) and D1 (`portal/src/pages/distillation/*.ts` + tests) share no files.
- B touches `portal/package*.json` and `CLAUDE.md` only.
- D2 is the only slice that touches `.tsx`.
- E touches `docs/**` and `scripts/validate-distillation.sh`.

## 4. Visual checklist (u-theo as member, u-vera as org-leader, ≥1440px window)

For each element, the check and the component that should render it:

1. **Rails:** unchanged against `14367dc1` (`SubNavLayout`).
2. **Explorer title:** "Knowledge", 18px, at the same baseline as the rail headers (`ExplorerLayout` railHeading prominent).
3. **Scope row:** "GUIDES & FINDINGS" with an 11 pill (`RailSectionHeader count`).
4. **Search row:** search with the filter icon on one row, hint below, no Select (`SearchInput`, `FilterPopover`).
5. **Groups:** "RECENTLY UPDATED 4" / "EARLIER THIS WEEK 7" in caps (`GroupedList groupHeading="label"`).
6. **Rows:** no icon, one-line ellipsis, "Procedure · Draft · 20h" (`GroupedList`).
7. **Selected row:** tint plus a 2–3px left bar (`currentStyle="bar"`).
8. **Crumb band:** crumb at the top of the pane; select and Open Library at the right, between the crumb and the title (`ExplorerLayout paneHeader` + `ScopeHeader variant="crumbs"`).
9. **Title:** about 26px semibold, Draft pill, "Updated Nh ago", no kind mark, no crumb above it (`EditorShell titleSize="lg"`).
10. **Tab row:** Sources 4 at the right end (`EditorShell tabsTrailing`).
11. **Tabs:** Content / History / Runs 2 (`EditorShell tabs`).
12. **No right strip** while Sources is closed; Sources opens `ContextColumn` (List/Graph).
13. **WHEN THIS HELPS:** two lines of the fixture text (`DetailSection` + `T`).
14. **USE IT:** the sentence, the primary and secondary buttons, the helper line (`DetailSection`, `Button`).
15. **Callout:** amber, icon at left, bold title, body, "View run →" at right. Clicking it opens Runs with papp-006 (`Banner layout="callout" icon`).
16. **THE APPROACH 4 steps:** four neutral numbered discs with plain text, no ✓/!/○, no red note (`ProcedureSteps`).
17. **BASED ON:** one row with a document tile, the title, "Source pattern · …", a chevron. The whole row opens cl-010 in Patterns and Back returns (`SourceList layout="row"`).
18. **Technical details:** collapsed (`Disclosure`).
19. **Composer:** light surface, "Agent ▾", "This guide ▾" (a menu, no ×), the placeholder, B I link • ?, "Ask →" (`RichChatComposer backdropTone="none"` + reference menu).
20. **Draft a plan:** the prefill appears with the caret at the end and nothing is sent. **Explain this guide:** lands on `/iq/invoke`, which auto-sends.
21. **Runs tab:** the latest-run callout and markers are still there. The "Record a run" form shows only for u-vera.
22. **Published record** (art-009): no callout (latest run succeeded), and "Open in Library ↗" beside Sources.
23. **Review and Activity:** unchanged; `ScopeHeader` band still present.
24. **Console errors 0; no horizontal scroll.**

## 5. Risks

1. **Other sessions in ui-components.** origin/main has already moved to 2.388.4 since the portal pin, and realtime-examples pins 2.388.4 (`b3009fb5`). Build in a fresh worktree from origin/main. Keep `dist/` out of feature commits (ui-components `CLAUDE.md:89-97`). Rebase and pick the next free version just before pushing. Its `CLAUDE.md` no-touch list covers barrels, `CHANGELOG` and `package.json` exports; the previous distillation release (`08a351a3`) touched the same set with authorisation.
2. **The main aws-agentcore checkout has uncommitted work from other sessions.** Work only in `aws-agentcore-wt-guide`. :3001 already serves a mock middleware from another checkout, so capture on :3012 and never POST `/api/session/*` against the user's browser session.
3. **Branding.** Title sizes must come from `EditorShell titleSize`; `validate-branding.sh:71` fails any `text-[26px] font-semibold` in a page.
4. **Component discipline.** Distillation pages must stay at 0 raw styled elements and 0 `style={{}}` (`validate-distillation.sh:29-44`). The budgets are ratchets. Every gap goes to the library, never a local composite or a queue exemption.
5. **Journey staleness.** Changing `DistillationModule.tsx` and `ExplainComposer.tsx` makes all six logs stale. Walk them after the last `.tsx` edit. The knowledge logs currently describe the view Select and must be rewritten.
6. **Validator IA checks this design must keep:** `ScopeHeader` + `data-shell-flush` in the module (`:49-50`), `controls=` and `/iq/library` (`:60-61`), `ContextColumn` in KnowledgeTab (`:83`), Load more (`:85`), `/iq/invoke` (`:88`).
7. **Markers vs today's spec and tests.** `distillation-redesign-spec.md` §1 says procedure steps carry the latest outcome marker. The mockup moves markers to Runs only; update the spec in slice E. `procedureRunsModel.test.ts:35-63` stays valid because Runs still uses `stepMarkers`/`latestRunCallout`.
8. **Two readings of "latest run".** The Content callout reads `guide.run_warning` (server); the Runs tab callout is `latestRunCallout` (portal). Both use newest-first order; a test should pin that they name the same run.
9. **Mock floor.** `wire.json` must be re-captured with the full `MOCK_*` env (`mock-floor.md:400-432`). The fixture key-set check (`vocabulary.ts`) sees the new keys. `write-policy.ts` needs the new apply body.
10. **Aurora is DDL only.** The corpus has no read path, so docs must not claim Aurora supplies these fields.
11. **Places the mockup and the data disagree:** "auth-service" vs "orgiq-auth-service", and the shortened cl-010 title (decide in C). For procedures, the rest of `body_markdown` (e.g. art-011 "## Why", art-010 "Still draft…") no longer shows on Content when `when_this_helps` is set. Confirm it can live in Technical details or be dropped.
12. **Guides that aren't procedures** (the mockup is silent): plan is WHEN, USE, markdown, BASED ON.
13. **Composer.** The reference menu has to work in the `menu` mode row and in compact or idle density. Prefilling through `editor.chain()` needs the composer ref to survive the `key={subject.id}` remount.
14. **Packaging test.** The pre-existing `packaging` test failure in ui-components must not be read as a regression.

### Critical files for implementation
- /Users/connorhoehn/Projects/aws-agentcore-wt-guide/portal/src/pages/distillation/KnowledgeRecord.tsx
- /Users/connorhoehn/Projects/aws-agentcore-wt-guide/portal/src/pages/distillation/KnowledgeTab.tsx
- /Users/connorhoehn/Projects/aws-agentcore-wt-guide/middleware/src/providers/distillation.ts
- /Users/connorhoehn/Projects/aws-agentcore-wt-guide/middleware/src/mock/distillation.ts
- /Users/connorhoehn/Projects/ui-components/src/components/doc-editor/EditorShell.tsx (edit in a fresh worktree from origin/main)

## Decisions taken (2026-09-24, by the orchestrator — the image wins)
1. `cl-010` title becomes "Retire the SAML shim tenant by tenant" (matches the mockup).
2. Repo label: the mockup's "auth-service". One server rule, `repoDisplayName(repo)` = last path segment with a leading `orgiq-` stripped, used by BOTH the facets label and `based_on.repo_label` (no second rule). Update any test/snapshot that asserted the old label.
3. Leftover procedure `body_markdown` (e.g. "## Why") moves into the collapsed Technical details disclosure on Content; nothing is dropped.
4. Review's composer turns light too (`backdropTone="none"`) so the module has one composer look.
