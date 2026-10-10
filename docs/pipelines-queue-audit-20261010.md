# Pipelines queue and realtime audit — October 10, 2026

## Scope and findings

The Pipelines tenant already reads a run ledger and subscribes to authorized per-run realtime progress through realtime-modules. Those are distinct from durable work delivery. The app’s concrete message-queue integration is the distillation compaction worker, with two FIFO queues and two dead-letter queues. Run status is not a queue-depth measurement, and a connected gateway is not worker-health evidence.

The new `/pipelines/queues` page reads `/api/pipelines/queues` under the existing Pipelines tenant and `ViewPipelines` gates. It reports the selected transport, approximate ready/in-flight/delayed counts, and registered dead-letter queues. Partial reads remain unknown rather than turning into zero. Counts refresh every 15 seconds and on explicit Refresh. Queue details distinguish app-configured retry policy from reported native attributes.

The transport reads **GET `/api/v1/queues/:queue/attributes`**, signed with the existing service-runtime envelope and bounded by a four-second timeout. It does not create queues or receive, acknowledge, retry, purge or inspect message bodies. Native **GET `/api/v1/queues/:queue/messages` leases messages** and must never be used for a monitoring page. Native `/inspect` currently returns placeholder zero age/stuck fields; this UI does not present them as measurements. Missing FIFO attributes remain “Not reported by service.”

Inventory defaults to `distill-compact-l1`, `distill-compact-l1-dlq`, `distill-compact-l2`, and `distill-compact-l2-dlq`, taken from the worker’s actual definitions. `PIPELINES_QUEUE_NAMES` optionally adds comma-separated explicit queue names (32 total maximum), on the same configured transport and service identity. It does not enumerate every upstream service’s queues or discover sensitive payloads. `MESSAGE_QUEUE_URL`, `MESSAGE_QUEUE_SERVICE_ID`, `MESSAGE_QUEUE_AUTH_SECRET`, and `MOCK_QUEUE` retain their existing meanings. In-process queues are clearly marked volatile; observing an uncreated queue does not create it.

The run-detail native progress component now remounts when the run ID changes, preventing its initial subscription ref from continuing to display a previous run.

## Native integration boundaries

- message-queue source inspected at `b93c6b7ff12ff39db52f56ef78c2abaf6b78b391`: `src/api/routes.ts`, `src/services/QueueInstance.ts`.
- platform-api source inspected at `b63634061ab543bab688d86b7e6920490ae3ae8c`: `src/services/pipeline-event-dispatcher.ts`. Its existing consumers invoke pipeline dispatch after their own successful handling. Adding a competing queue consumer for visibility would steal events; none was added.
- realtime-modules sibling source at `3a46a90c2f222da9c242bc08592f27537655cda3`; the portal continues using its pinned native package. `PipelineRunLive` and `gateway-run-feed` provide per-run subscription authorization, not an unrestricted event firehose.

Worker heartbeat, queue age, stuck delivery detection, transport durability verification and platform-api’s complete queue inventory are not claimed by this view. Additional configured queues have no inferred dead-letter or retry policy. No service was deployed or upstream repository changed by this audit.

## Verification

- Middleware and portal typechecks passed before parallel deck/auth integration.
- 52 focused backend tests passed across HTTP queue metadata, in-process queue semantics, bounded inventory/partial failures, and Pipelines route authorization.
- One frontend aggregation test passed: missing metrics and partial failures remain unknown.
- One isolated browser fixture passed at desktop and narrow widths: real Queues page and native UI components, intercepted metadata, visible partial failure, search/details, volatile transport notice, no API writes or browser errors.
- Browser screenshots and logs are local under `/private/tmp/pipeline-queues-browser`; they are fixture evidence, not a claim of a production message-queue connection.
