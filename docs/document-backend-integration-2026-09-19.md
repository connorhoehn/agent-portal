# Reuse the existing document backend

Follow-up: the user clarified that reusable middleware and Docker/CDK deployment
are the priority, and authorized cross-repo fixes. See the
[deployment research and evidence](realtime-middleware-deployment-research-2026-09-20.md).
The deployment-choice question below is historical; editor work is deferred.

Source inspection: realtime-modules sibling checkout, realtime-examples at
`510049ab12242dcf5230a73966fb338e3c8de20a`, and platform-api routes. Sibling
working trees contain ongoing work; these findings do not certify their entire
current deployment. No sibling files were changed.

## What already exists

| Capability | Implementation to reuse | Application wiring |
| --- | --- | --- |
| Collaborative document content | realtime-modules `CRDTService`, `GatewayProvider`, `useYjsDoc` / `useCanvasDocument` | realtime-examples `src/server.ts`, frontend document editor |
| Metadata, hierarchy and ordering | realtime-modules `DocumentMetadataService` / `MetadataStore` | examples `DdbMetadataStore` persists parentId, position, conversation binding |
| Snapshots and version restoration | realtime-modules `SnapshotManager` / `SnapshotStore` | examples `DdbSnapshotStore`, `RedisHotCache`; ownership wrappers for clustered gateway |
| Presence and cursors | realtime-modules services and client hooks | gateway authenticated connection and channel authorization |
| Anchored comment threads and resolution | platform-api `documentComments.ts`, `DocumentCommentRepository` | examples `useDocumentComments`, independent of Yjs content |
| Section reviews and review requests | platform-api document routes/repositories | examples `useDocumentReviews` and document editor |
| Draft/review/approval/finalization | platform-api `documentLifecycleService`, `document-lifecycle.ts` | examples `useDocumentLifecycle`; server returns availableActions and version |
| Typed documents, validation and imports | platform-api `typedDocuments.ts`, documentTypes/import/export routes | examples `useTypedDocuments`, `useDocumentTypes` |
| Live comments/review/workflow delivery | realtime-modules `DocumentEventsService` | platform publishes events; gateway subscribes clients to document channels |

The `typed-documents` package export is a subscription service, NOT the
persistence/validation/lifecycle backend. Importing it alone cannot provide the
full system. The examples' REST hooks call platform-api with a bearer token;
they are not exported by realtime-modules.

## Dependency mismatch found

aws-agentcore used the slalom fork at `ccf37b6c` (0.17.0). Its manifest advertised
server and typed-document subpaths whose built server files were absent in the
installed package. The examples use the canonical repository at
`08771183e29b6a560912a66328879c9e442518be` (0.51.0), which includes committed server
and typed-document builds. That is now the installed pin in both packages, not the sibling
checkout's newer 0.69.0 working tree. Keep this app's existing import alias to
avoid a gratuitous import rewrite; pin both application packages consistently.

## Integration boundaries

Reusing the existing gateway plus platform-api preserves their existing durable
stores and document workflows. Embedding `attachRealtime` / `collabDocs` here
is an alternative, but it needs application-owned Aurora MetadataStore and
SnapshotStore adapters and still does not bring in platform-api workflows.
Do not implement a second lifecycle/comments backend under the guise of
installing a library. Deployment choice is pending user clarification.

Before connecting the existing stack:

1. Map the application's authenticated assessment principal to the gateway and
   platform API's verified identity. The BFF cookie is not their bearer token;
   this app does not currently retain the SSO token for forwarding.
2. Preserve tenant/capability/document access. The example repositories describe
   a single-tenant deployment; a channel string or service signature alone does
   not establish assessment document membership. Keep the retired arbitrary
   channel proxy retired.
3. Define one stable mapping from namespaced assessment IDs (`ec:`, `page:`, etc.)
   to existing document IDs. Explicitly separate read-only synced pages and
   editable local documents. No second independent copy of the same content.
4. Import Markdown into the example's section/canvas document model with a
   verified round-trip/export strategy, retaining the original until validated.
   Existing comments/reactions require an explicit migration, not silent loss.
5. Adopt the example's editor composition and backend-driven actions together.
   Verify two authenticated users, reconnect, restart persistence, version
   restore, denied access, comment anchors and lifecycle conflicts.

Dependency alignment is a prerequisite, not completion of these integration
steps. No shared gateway, platform data, credentials or live deployment was
changed during inspection.

## Verified adoption checkpoint

- Portal: 923 tests pass; typecheck/production build pass.
- Middleware: typecheck passes. Runtime imports for CRDTService, SnapshotManager,
  DocumentMetadataService, attachRealtime, collabDocs, DocumentEventsService and
  createWsHandler all resolve from the installed package.
- Isolated smoke: metadata create/rename/read through a new service instance,
  and Yjs snapshot write/rehydration through an injected store pass. Stores were
  in-memory: this does not establish production durability or authenticated access.
- Git artifact packaging now keys artifacts by exact repository/commit and
  resolves nested dependencies. Four converter regression tests pass, including
  two commits of the same package; the middleware Docker dependency stage installs
  successfully using the generated artifacts and existing registry lock pins.
- No application routes were switched to the external platform. The integration
  still needs the deployment/identity/content mapping described above.

Full middleware run: 4,300 tests pass; two fail (297 passing suites, two failing).
Both failures are route-capture freshness: the concurrently committed compute
capability integration adds six internal routes absent from routes.json and
five writes absent from writes.json. No route snapshots were fabricated or
refreshed by this dependency adoption. Log:
`/tmp/aws-agentcore-audit/realtime-adoption-middleware-tests.log`.
