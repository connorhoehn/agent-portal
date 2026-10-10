# One store for a work item's conversation — 2026-10-08

Closes the "two stores for one page conversation" finding (D2 in
[the 2026-10-07 audit plan](../../audit/2026-10-07-audit-plan.md)) for the
`orgiq` work-item page. Assessment's `assessment_knowledge_comments` vs
`assessment:doc:<id>` (the other half of D2) is **not** in this lane.

## What changed

A work item's conversation is now one store: the gateway chat thread
`orgiq:work:<id>`. `work_item_comments` is read-only audit history for human
rows; its `is_system` audit events (status changes, run settlements) are
still written there and still shown.

- **Migration.** `middleware/src/lib/migrate-work-comments.ts` copies each
  human `work_item_comments` row into the configured chat store as a message
  on `orgiq:work:<work_item_id>`, with provenance
  `metadata: { migratedFrom: 'work_item_comments', commentId, authorPersonId }`
  and `timestamp = created_at`. It is batched, has a `--dry-run` flag, and
  prints a per-run JSON report (claimed, written, already in store, unlinked
  authors, removed authors, per-item counts, failures). Run it with
  `SOCIAL_CHAT_STORE=dynamo SOCIAL_CHAT_DYNAMODB_ENDPOINT=… SOCIAL_CHAT_TABLE_PREFIX=… npx tsx src/lib/migrate-work-comments.ts [--dry-run] [--batch N] [--report out.json]`.
  It refuses a non-dry run into a memory store, since that store lives in
  another process.
- **Idempotency is keyed on the comment id twice.** The ledger
  `work_item_comment_migrations` (`schema/work_item_comment_migration_schema.sql`,
  registered in `schema/load_schema.py` and `schema/apply_all_seed.py` right
  after `work_item_documents_schema.sql`) admits one claim per comment, and the
  message id is a pure function of the comment (`lib/work-thread.ts`
  `migratedMessageId`: the created_at instant in base 36, as the library's own
  ids are, plus a SHA-256 digest of the comment id). A retried or raced write
  therefore lands on the same key. A claim left unwritten for more than 5
  minutes, by a migrator that died, is taken over; a fresh one is not.
- **Sender identity is stamped by the server.** The author is the app user
  linked by `app_users.person_id`, using that login's display name. When
  several logins link one person, the lowest id is chosen deterministically.
  A person with no login migrates as a named-but-unlinked sender: the
  directory name, no `userId`, and `unlinkedAuthor: true`. A deleted person
  (`author_id` NULL) carries no name at all. Nothing in a comment's body is
  read as identity. Before this change the mock used the person id as a user
  id; it now goes through the same mapper.
- **Write path.** `POST /api/graph/work-items/:id/comments` posts a message on
  the thread. The sender is the session's user and its directory name, and the
  persist goes through `lib/social-chat.ts` `postThreadMessage`. When the
  gateway is up, the ChatService cache, the live broadcast and the page-unread
  item are handled exactly as for a socket send (`lib/realtime-gateway.ts`
  `setThreadLiveAppend`). `addWorkItemComment` now throws for any non-system
  row, so the table cannot take a human comment again.
- **Read path.** `GET …/comments` returns the thread, under the reader's
  history floor (the strictly-after rule in `routes/chat-pins.ts`), merged with
  the table's `is_system` rows. The response shape is unchanged. Migrated rows
  keep their old `wic-…` id through `metadata.commentId`.
- **Mock.** `mock/social-channels.ts` now derives the thread's seeded history
  with the migration's own mapper (`legacyCommentMessage`). The mock thread is
  therefore the migration of the fixture, and a jest test asserts exactly that.

## Contracts and numbers

| contract | where | result |
|---|---|---|
| Native PostgreSQL 16.15 (pgvector image `sha256:7b822b0a…`), dedicated container `orgiq-page-thread-postgres-acceptance`, label `orgiq.validation=page-thread-postgres`, network `none`, no published ports | `middleware/src/lib/__tests__/migrate-work-comments-postgres.test.ts` ([log](page-thread-postgres.log)) | **5/5 pass** |
| DynamoDB Local 3.3.1 (`orgiq-social-dynamodb`, :8000), suite-owned tables under a random `orgiq-chat-pagethread-<hex>-` prefix, deleted afterwards (0 left) | `middleware/src/lib/__tests__/migrate-work-comments-dynamo.test.ts` | **2/2 pass** |
| Migration rules over the memory store, and mock thread = migration of the fixture | `middleware/src/lib/__tests__/migrate-work-comments.test.ts` | **8/8 pass** |
| Write routes no longer write the table (real provider, Data API transport recorded) | `middleware/src/routes/__tests__/work-item-comments-one-store.test.ts` | **3/3 pass** |
| Provider and route suites updated for the new author shape | `providers/…/work-item-criteria-comments.test.ts` (22), `routes/…/work-item-criteria-comments.test.ts` (33) | **55/55 pass** |

The five focused jest files pass 68/68 together
([log](page-thread-dynamo-and-jest.log)).

PostgreSQL proves the following, running the exact `CLAIM_SQL`,
`PENDING_SQL`, `MARK_WRITTEN_SQL`, the provider's audit read and the
people-title read over the unmodified `orgiq_schema.sql`,
`orgiq_work_items_schema.sql`, `identity_schema.sql` and ledger files:

- Reapplying the ledger DDL is safe.
- A 9-comment migration runs in batches of 4 and writes 9 messages; `is_system`
  rows are excluded.
- With two logins on one person, the lowest login id is the sender, under its
  display name.
- Unlinked and removed authors are handled as described above.
- Commas, quotes and apostrophes in bodies survive.
- A second run claims 0.
- **Two concurrent migrators over 30 rows put exactly 30 messages, with no
  duplicate ids.** The ledger splits differed between runs (14/16, then 22/8),
  so the race is real.
- A stale unwritten claim is taken over; a fresh one is left alone.
- A dry run writes no ledger rows.
- After the change, a REST post adds no table row, and the read returns thread
  plus audit rows only.

DynamoDB proves the following, using the library's `DynamoChatStore` over real
SDK requests:

- 25 comments become 25 items.
- A re-run writes 0 (25 already in store).
- **Two migrators with no shared ledger leave exactly 20 items for 20
  comments.** Idempotency holds at the store key even without the ledger.
- The thread reads back in created_at order.
- History floor: a member whose `historyFrom` equals the second comment's
  instant reads only the third, through the library's own
  `ChatService.getChannelHistoryFor`. An earlier member reads all three, and
  a non-member of a channel with a member list reads none. The BFF's REST
  rule (`messageVisible`) agrees with the library over the same rows.

## Gates

- Middleware typecheck: clean.
- Full middleware jest, first run: 6,659 passed, 1 failed, 24 skipped
  (480 suites). The one failure was
  `project-activity-mock.test.ts`, which asserted that the table takes a human
  comment. It now asserts the refusal, and the suite passes 11/11. The full
  run inside `validate-mock-floor.sh`, made after that fix, passed.
- `validate-mock-floor.sh` (full): ALL CHECKS PASS. The handler digest covers
  `lib/`, `providers/`, `mock/` and `routes/`, so the wire and write snapshots
  were recaptured from a private BFF on :3012 (all `MOCK_*` flags), and that
  server was stopped afterwards. The shared :3001 server was not used, and no
  budget changed. The comments route's captured shape is unchanged:
  `{comments: array, total: number}`.
- `validate-route-coverage.sh`: ALL CHECKS PASS (769 routes, 0 untested).
- `validate-honest-numbers.sh`: ALL CHECKS PASS.
- `portal/e2e/pane-header.spec.ts` on the shared Tilt mock stack (:5183 and
  :3001, hot-reloaded): 4/4 pass, including both work-item cases where "the
  Discussion tab lists the pane's thread". No portal file changed, so no
  journey log goes stale.

## What is NOT verified (honest limits)

- **Aurora and the RDS Data API transport are untested.** The default AWS
  identity is invalid and Aurora is unreachable. The PostgreSQL contracts
  replace only the transport, using string-parameter binding through psql.
  They do not prove Data API placeholder parsing, type mapping, IAM or a
  migration on the real cluster. The `to_char` format quotes its colons so
  that no `:MI` can be read as a placeholder by either scanner. That is a
  precaution, not something observed against the Data API.
- **The ledger table is not applied to Aurora.** Apply
  `work_item_comment_migration_schema.sql`, run with `--dry-run`, then run for
  real, all **before** deploying a BFF that contains this change. After the
  change, the read path no longer reads human rows from the table, so a
  deployment before the migration hides old comments until it runs. They are
  hidden, not lost.
- The CLI was not run against a real Dynamo table set; the contracts drive
  the same function directly.
- Still reading the table, and noted for a follow-up: the initiative activity
  feed (`getProjectActivity`) and `v_work_item_summary.comment_count`. Both
  still count `work_item_comments`, so neither sees comments posted after the
  migration. The thread is the store; those two readers have not moved yet.
- The REST post's live broadcast and unread item were not exercised against a
  running gateway. They are covered only by the typecheck and the
  memory-backend route contract.
- Assessment's `assessment_knowledge_comments` vs `assessment:doc:<id>` is
  out of scope here.

---

## Follow-up (same day): the two readers that still counted the table

The two open readers from "What is NOT verified" now read the thread.

- **Activity feed** (`providers/work-items.ts` `getProjectActivity`,
  `GET /api/graph/projects/:id/activity`). The human comments come from each
  item's thread `orgiq:work:<id>`, through the store's own
  `ChatStore.listMessages`, under the reader's history floor (`messageVisible`,
  so deletions are dropped). The route passes the session's `sub`. The table
  arm is now `… AND c.is_system`, so it reads audit rows only. The thread walk
  is bounded: at most 200 items per initiative (most recently touched first),
  8 reads per round, and the newest `limit` messages per thread. A migrated
  row keeps its `wic-…` id through `metadata.commentId`. Mock and Aurora use
  the same thread arm. The mock thread is the migration of the fixture
  (`mock/social-channels.ts`), so its counts still derive from rows.
- **`v_work_item_summary.comment_count`.** A SQL view cannot see the chat
  store, so the column now reads `NULL::bigint`, meaning "not known here",
  never zero. The column's name, its bigint type and its position are kept, so
  `CREATE OR REPLACE VIEW` applies over the old definition. Nothing in the repo
  read the column (middleware, portal, agents and notebooks all grepped).
  The count is now `GET /api/graph/work-items/:id/comments/summary` →
  `{ workItemId, commentCount, lastCommentAt }` (`workThreadSummary`). It reads
  the thread under the reader's history floor, uses the same rule as the
  comment feed's `total`, and makes no table read.
- A real loader bug was avoided. `schema/load_schema.py` `split_sql` ends a
  statement at any line ending in `;`. A first draft of the view's comment had
  one, and the native run caught it, because the view statement was cut
  mid-comment.

| contract | where | result |
|---|---|---|
| Native PostgreSQL (same container `orgiq-page-thread-postgres-acceptance`, reused; still running as found) | `migrate-work-comments-postgres.test.ts` ([log](page-thread-readers-postgres.log)) | **7/7** (2 new) |
| DynamoDB Local :8000, suite-owned tables, deleted afterwards | `migrate-work-comments-dynamo.test.ts` | **2/2** (unchanged code, rerun) |
| Route, real provider on the Aurora path, Data API recorder | `work-item-comments-one-store.test.ts` | **6/6** (3 new) |
| Mock (`dev:mock` fixtures) | `providers/__tests__/project-activity-mock.test.ts` | **13/13** (2 new) |

PostgreSQL proves the following:

- The pre-change view (counting the table) reads 2 for an item.
- The shipped view statement, taken from the file, replaces it in place.
- `comment_count` is then NULL, `pg_typeof` is bigint, and it is still the last
  column.
- After a real migration plus one later REST post, `workThreadSummary`
  answers 3 (two migrated comments and the post), with `lastCommentAt` equal to
  the post's time. No SQL touches `work_item_comments` for that read.
- The feed carries all four migrated comments and the post, with directory
  stamping (linked, unlinked and removed authors), and exactly one audit row.
- The feed's only table statement is the `AND c.is_system` one, run through the
  long-parameter binding that the acceptance transport now supports.

The route and mock contracts show the following:

- A new thread post raises the count and leads the feed, and the table gains
  no row.
- A member whose `historyFrom` equals the first comment's time counts 1 of 2.
- A deleted message stops counting, and the summary's `total` agrees with the
  comment feed's `total`.
- An unknown item returns 404.

**Deploy order.** Same as above: apply the ledger and run the migration
before the BFF that carries this change. Re-applying `orgiq_work_items_schema.sql`
replaces the view. Any external SQL that read `comment_count` gets NULL from
then on. In-repo there is none.

**Unverified.** Aurora and the RDS Data API remain unproven for the view
replace and both feed statements. The feed's per-item thread reads have not
been load-measured against DynamoDB. The walk is capped at 200 items × 1
`listMessages` each, and a large initiative costs that many reads per feed
request.

## The assessment half was not done: the D2 premise does not hold there

`assessment_knowledge_comments` is **not** split against `assessment:doc:<id>`.
The user's recorded decision
([parity goal, Phase 4 (rest), recommendation C](../../assessment-documents-parity-goal.md))
makes a document's comments **platform-api's document comments**. Those are
the anchored threads with replies and resolve that the Comments tab reads
(`portal/…/knowledge/useDocumentComments.ts` →
`routes/assessment-document-workflows.ts` → `providers/document-comments.ts`).
The legacy table already has its one-time migrator into that store:

- `providers/document-comment-import.ts`, which preserves ids, authors and
  timestamps, uses conditional puts, and carries replies, edits and
  tombstones;
- its ledger is `assessment_document_comment_imports`;
- once a document's import is recorded, the legacy write routes answer 409
  (`COMMENTS_MOVED`).

`assessment:doc:<id>` is the document's separate **Chat** (Phase 4 (part),
`DocumentConversation.tsx`). The portal no longer calls the legacy
`/knowledge/doc/comment(s)` routes.

Projecting the table into the chat thread, as briefed, would have three
effects:

- the same rows would get a second destination;
- the Comments tab would lose its threading and anchors;
- it would reverse a recorded user decision.

So no migrator, schema or route was written for it. One gap remains, and it
needs a user decision before work starts:

- Until a document's import has run, which is lazy on the first BFF read of
  its comments, `POST /knowledge/doc/comment` still writes the table. No UI
  calls it any more. Options: retire the legacy write routes outright (410),
  or run the import eagerly in a batch.
- The audit plan's D2 row and Step 7 should drop the assessment clause, or be
  restated as "the legacy table into platform-api comments, finished".
