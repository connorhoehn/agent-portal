# Work/document association acceptance — 2026-10-04

This is the historical work/document phase record. The later [direct-recipient acceptance](direct-recipient-acceptance.md) closes call/notification recipient checks, records the current 0.101.0 dependency pin and estimates overall progress at 75%. The phase-specific hashes, image and results below remain historical evidence.

Work items now support explicit saved links to canonical OrgIQ ingested document records. The shared `LinkedItemsSection` owns search, selection, display and removal controls. This follows the [DM page-reference slice](dm-page-reference-acceptance.md). The user confirmed the OrgIQ document corpus on 2026-10-04; the separate Assessment document workspace is not mapped into this relation.

## Behavior and authority

- The Brief's Documents section starts empty. Search returns at most 25 actual corpus records. Nothing infers an architecture document or relationship from a project, filename or display name.
- Selecting a document saves only the work-item/document pair, authenticated subject and timestamp. Duplicate PUTs keep the original attribution; retrying an uncertain receipt does not add a second relation. Removal changes the relation and leaves the document intact.
- Reads join canonical document metadata, so a renamed title is resolved from the document row rather than a copied association field. Missing documents disappear from the related list. The production schema cascades deletion of either parent.
- The API requires a signed, currently valid OrgIQ source session. Mutations require current `DispatchAgentRun`, matching other work-context writes. Directory epoch, role, actor and remote policy checks surround resource reads and writes. Unknown body fields refuse; a caller cannot supply titles, routes or attribution. Metadata reads preserve the existing tenant-open OrgIQ corpus policy and return `Cache-Control: no-store`.
- Opening a link uses `/iq/documents/<canonical-id>` through SPA navigation. The record page rechecks current authority and identifies the document, source and ingestion metadata. HTTPS source links reject credentials, unsupported schemes and malformed URLs; S3 locations remain text for use through an authorized source client. This feature does not proxy source content, mint source grants or manufacture an editor.
- Frontend state is keyed by identity and work item. Delayed association receipts cannot restore the old work context after navigation. Failures show a reason and an explicit Retry for the captured operation. Readers see saved links without Add/Remove controls and cannot mutate through direct HTTP calls.

## Schema and deployment boundary

The additive [migration](../../../schema/work_item_documents_schema.sql) creates `work_item_documents`, keyed by `(work_item_id, document_id)` with foreign keys to the canonical work and corpus tables. Both `schema/load_schema.py` and `schema/apply_all_seed.py` register it after the work-item schema. Associations receive no invented seed rows.

**The migration has not been applied to Aurora.** Apply it after `orgiq_schema.sql` and `orgiq_work_items_schema.sql` before enabling this feature against a provisioned database. A missing relation table produces an explicit 503 migration notice rather than a false empty list. Local browser validation uses the resettable mock relation store; reload acceptance is within the same BFF process. SQL contracts cover the production joins, bound literal search, atomic foreign-key pair, idempotent conflict path, removal and missing-table failure. Actual Aurora persistence/restart acceptance remains required.

## Verification on the combined source

| Check | Result | Evidence |
| --- | --- | --- |
| Portal | 1,318 tests passed; typecheck and production build passed | [Tests](work-documents-portal-tests.log), [typecheck](work-documents-portal-typecheck.log), [build](work-documents-portal-build.log) |
| Backend | 23 suites / 342 tests passed, 2 skipped | [Combined run](work-documents-backend.log); [final association contracts](work-documents-backend-focused.log) |
| Browser | 43 distinct checks passed | [42-check combined run](work-documents-browser.log) plus [held-receipt navigation check](work-documents-browser-receipt.log) |
| API snapshot/floor | Fresh 621-route capture; all quick judge checks passed | [Capture](work-documents-wire.log), [judge](work-documents-floor.log) |
| Architecture | Component discipline, navigation parity and route coverage passed, budgets unchanged | [Components](work-documents-components.log), [navigation](work-documents-nav.log), [route coverage](work-documents-route-coverage.log) |
| Gateway image | Production build and compiled route/provider inspection passed | [Build](work-documents-gateway-build.log), [artifact](work-documents-gateway-artifact.json) |
| Schema loader syntax | Both edited Python modules parse | Checked with `ast.parse`; scripts were not executed against AWS |

The browser total comprises 17 real BFF contracts and 26 component fixtures. The three document checks verify actual signed sessions, explicit save/reload/open/removal, reader permissions, missing records, and delayed-receipt isolation. Existing real DM/huddle checks still use Redis/Dynamo stores; unavailable media-session receipts remain substituted. The two backend skips remain the opt-in storage restart and the legacy Social test requiring unprefixed tables. No audio/video, Aurora capacity, deployment or distributed routing acceptance is claimed.

The fresh capture represents **336 GET routes** (268 responses captured; explicit reasons for the rest) and **285 writes** (109 responses captured). GET and write handler SHA is **`fbd9fcdd65c87cd7c8a6773347cd54147eca0259b58296ccd98415fae5e2eea4`**. The generic sweep lacks a correlated document target for some new paths; real handler and browser contracts cover those operations. The [manifest](work-documents-manifest.json) records source/evidence digests, package pins and exact image identity. The rebuilt image was not substituted into the old running soak container.

The UI pin remains **2.408.0 / `69d0283d1e6e0cf6d9a3684eaa78dcbf465b3901`**; realtime remains **0.100.3 / `5aa384065b2b53e8e662c88a8a2fe1d87ed847a7`**. The owning UI sibling main is clean and untouched. No root commit, registry release or cloud deployment occurred. The application remains at **http://localhost:5261** with BFF 3061 and capture BFF 3062.

## Remaining full scope

Apply and verify the relation migration on Aurora, verify actual SFU/audio/video, measure the provisioned current-authority directory/Aurora path, complete tenant cloud acceptance, add distributed gateway routing, and perform the final Work rail/layout and role journey walks. Per-recipient checks for ring recipients and notification replay were open at this checkpoint and are completed by the later acceptance linked above. Preserve the single-gateway safeguard and all unrelated uncommitted work. The full integration remains in progress; the 70% estimate at this phase was an engineering estimate, not a test-derived measure.
