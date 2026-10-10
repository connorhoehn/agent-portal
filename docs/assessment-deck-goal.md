# Assessment review decks — goal

An assessment-tenant user asks for "a review deck for team X". A workflow builds
a PowerPoint that reviews each rubric dimension of that team's assessment and
adds summary slides. The user revises it in the library's `PresentationEditor`
(by hand or by instructing the agent), downloads the `.pptx`, and shares it into
a Social conversation that team X can read.

Judge: `scripts/validate-assessment-decks.sh` (exits 0 only when every check
below passes).

## Decisions

1. **One deck engine, vendored.** `DeckSpec`, `renderPptx`, `renderSlideSvg`,
   `theme` and `deckConstraints` are copied from platform-api `src/deck/` at
   `34d17f7` into `middleware/src/lib/deck/`, unchanged except imports, with that
   commit named in each file header. The SVG previews and the `.pptx` therefore
   come from the same engine the library's `PresentationEditor` expects.
   Extracting the engine into a shared package is a queued follow-up
   (`docs/ui-components-queue.md`), not a reason to fork its behaviour.
2. **No platform-api runtime dependency.** platform-api's deck LLM steps call
   Anthropic models (its Bedrock client speaks only the Anthropic payload), which
   this project forbids, and its container is not reachable locally. Decks are
   stored and rendered by the BFF.
3. **Numbers never come from the model.** Levels, targets, confidence, counts,
   claims and recommendation kinds are filled deterministically from
   `providers/assessment.ts` (`dimensionCertification`, `teamCertification`,
   `getTeamRecommendations`, evidence rows). Nova (`orgiq-assessment-drafter`,
   commands `draft-review-deck` / `revise-review-deck`) writes only prose:
   executive summary, per-dimension narrative, next steps, and instructed edits.
   Every narrative claim carries verbatim `source_spans` from evidence; a span
   that is not verbatim fails validation and the templated text is used instead.
   `MOCK_AGENTCORE` returns a deterministic narrative so `dev:mock` works offline.
4. **The workflow is an assessment run.** Generation and agent revisions are
   `assessment_runs` rows (`launchRun`, durable dispatcher, Runs page), so they
   inherit progress, failure and audit. Each completed run writes one deck
   revision; `producedBy` names the run.
5. **Revisions are append-only with CAS.** A save names `baseRevisionId`; a stale
   base is a 409 the editor surfaces. Person edits require `ScoreAssessment`;
   agent edits require `RunAssessmentAgent`. Locked slides survive regeneration.
6. **Sharing sends bytes by the author's explicit act.** Team X's members usually
   hold no assessment grant, so a reference would read as "unavailable". The
   portal fetches the revision's `.pptx` and posts it with the existing
   attachment path (`useChatAttachments` → gateway `fileUploads()` →
   `/api/uploads`) into a Social conversation the sender is a member of, after a
   confirm step naming the destination. The message carries display-only
   `metadata.sourceDeck = { id, revisionId }`. Channel rules govern who downloads
   it; removal from the channel cuts access.

## API (all under `/api/assessment`, `requireTenant('assessment')`)

| Route | Action | Notes |
|---|---|---|
| `POST /teams/:teamId/decks` `{ title?, dimensionIds?, audience? }` | `RunAssessmentAgent` | 202 `{ deckId, runId }`; launches `draft-review-deck` |
| `GET /decks?teamId=` | `ViewAssessment` | list `{ id, teamId, title, latestRevision, updatedAt }` |
| `GET /decks/:id` | `ViewAssessment` | `{ id, teamId, title, revisions: [{ id, label, createdAt, producedBy }], activeRevisionId, pendingRun? }` |
| `GET /decks/:id/revisions/:rid/spec` | `ViewAssessment` | `DeckSpec` |
| `POST /decks/:id/revisions` `{ spec, baseRevisionId }` | `ScoreAssessment` | person edit; 409 on stale base |
| `POST /decks/:id/preview` `{ spec }` | `ViewAssessment` | `{ slides: [{ id, svg, title?, generated? }], warnings }` |
| `POST /decks/:id/revise` `{ instruction, slideId?, baseRevisionId }` | `RunAssessmentAgent` | 202 `{ runId }`; launches `revise-review-deck` |
| `GET /decks/:id/revisions/:rid/file` | `ViewAssessment` | `.pptx`, `Content-Disposition: attachment` |

New Cedar actions are not needed (existing ones cover every route); any new one
must be added to `CAPABILITY_ACTIONS` in `lib/authz.ts`.

## Slide set (generation)

1. Title — team, cohort, date, rubric version.
2. Executive summary — verified-at-target count, floor level, open claims (facts) + narrative.
3. Dimension overview — chart of verified vs target for all assessed dimensions.
4. One slide per assessed dimension — verified / claimed / target, confidence,
   evidence class, 2–3 verbatim evidence excerpts, certification statement,
   next-level criteria, open follow-ups; narrative.
5. N/A dimensions — one slide with approved exception reasons.
6. Overall summary — strengths vs gaps.
7. Recommendations — grouped `close_claim` / `advance` / `answer`.
8. Next steps — narrative.

Every slide cites its sources (`DeckSource.documentId = assessment:<team>:<dimension>`
or the evidence id), so the renderer's Sources slide lists them.

## Storage

Aurora `assessment_decks` + `assessment_deck_revisions` (additive
`schema/assessment_deck_schema.sql`, registered in both schema loaders). Under
`MOCK_AURORA`, a registered fixture `mock/assessment-decks.ts` (reset by
`POST /api/__mock/reset`, timestamps from `mock/core/clock.ts`).

## Definition of done (the judge's checks)

- Engine: vendored files carry the source commit; `renderPptx` output is a valid
  zip whose `[Content_Types].xml` declares presentation parts; SVG preview count
  equals the spec's slide count plus generated slides.
- Generation: for a mock team, every assessed dimension has exactly one slide;
  every number on a slide equals the provider's value; every slide cites a source.
- Narrative validation: a non-verbatim span falls back to template text (agent
  unit test in the synth venv, middleware test for the fallback).
- Authz: assessor can generate/read/revise-by-agent; a role without
  `ScoreAssessment` cannot save a person edit; other tenants get 403.
- CAS: a stale `baseRevisionId` is 409.
- Download: `.pptx` content type and attachment disposition.
- Portal: "Create review deck" in the team actions menu; deck page uses
  `PresentationEditor` (no hand-rolled slide UI); Download, agent instruct box,
  revision picker; Share to Social with a confirm step.
- Share: a member of the chosen Social channel can download the shared file; a
  non-member gets 403 (gateway upload tests).
- Browser (real BFF): an assessor creates a deck for a team, revises a slide by
  instruction, downloads it, and shares it to a Social channel where a member
  sees the attachment live.
- Gates: middleware typecheck + suites, portal typecheck/tests/build,
  component discipline, nav parity, route coverage, mock floor.
