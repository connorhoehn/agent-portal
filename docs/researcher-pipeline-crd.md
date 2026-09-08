# OrgIQ Researcher Pipeline CRD

**Kind**: `AgenticPipeline` (platform.connorhoehn.dev/v1alpha1)
**Name**: `orgiq-researcher`
**Namespace**: `orgiq`

This is the first real CRD-based capability declaration by App #2 (OrgIQ). It declares OrgIQ's research workflow as a gateway-reconciled `AgenticPipeline` — the proof of concept for the platform's CRD-driven capability layer.

---

## Workflow modeled

User submits a query → agent searches → agent summarizes → optional human approval → publish.

| Step ID | Type | Description |
|---|---|---|
| `search` | `tool-call` | Calls `web-search` with the trigger's query payload; retries up to 3 times |
| `summarize` | `llm` | Summarizes search results via `claude-opus-4-7` |
| `approval` | `approval` | Human gate — requires `role:org-leader`; times out after 24 hours |
| `publish` | `webhook` | POSTs the summary to `https://orgiq.example/api/publish` |

Edges: `search → summarize → approval →(approved) publish`

---

## Prerequisites

1. **dc-k8s-operator deployed** to the target cluster with RBAC permission to reconcile `agenticpipelines.platform.connorhoehn.dev`.
2. **Event-catalog bundle registered**: `agentic-pipeline-signal@1.0.0` must be present in the EC registry snapshot so the operator can resolve the event schema on reconcile.
3. **`orgiq` namespace exists**: `kubectl create namespace orgiq` if not already present.
4. **platform-api reachable** from within the cluster (the operator delegates pipeline execution to platform-api, not directly to the gateway).

---

## Deploy

```bash
kubectl apply -f k8s/crds/researcher-pipeline.yaml
```

---

## Verify reconciliation

```bash
kubectl get agenticpipeline orgiq-researcher -n orgiq -o yaml
```

Expected `status` once the operator reconciles:

```yaml
status:
  phase: Ready
  lastPublishedVersion: 1
  conditions:
    - type: Reconciled
      status: "True"
      reason: BundleResolved
```

`lastPublishedVersion` increments each time the spec changes and the operator re-validates + re-registers with platform-api.

---

## Trigger

### Via webhook (declared in spec)

```bash
curl -X POST https://<gateway-host>/api/orgiq/researcher/trigger \
  -H 'Content-Type: application/json' \
  -d '{"query": "latest developments in AI regulation"}'
```

### Via platform-api REST

```bash
curl -X POST https://<platform-api-host>/api/pipelines/orgiq-researcher/trigger \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"query": "latest developments in AI regulation"}'
```

---

## Observe

### Run status (platform-api)

```bash
curl https://<platform-api-host>/api/pipelines/runs/<runId> \
  -H 'Authorization: Bearer <token>'
```

Returns `{ runId, phase, currentStep, startedAt, steps: [...] }`.

### Live events (gateway WebSocket)

Subscribe to `pipeline:run:<runId>` after connecting:

```jsonc
// client → gateway
{ "type": "subscribe", "channel": "pipeline:run:<runId>" }

// gateway → client (example step transition)
{ "type": "pipeline:step:completed", "runId": "<runId>", "stepId": "search", "result": "..." }
{ "type": "pipeline:step:waiting", "runId": "<runId>", "stepId": "approval" }
```

The `approval` step emits a `pipeline:step:waiting` frame. The approver approves via:

```bash
curl -X POST https://<platform-api-host>/api/pipelines/runs/<runId>/approve \
  -H 'Authorization: Bearer <token>'
```

---

## Phase 2.5 follow-up

Wire end-to-end trigger + observe in the OrgIQ portal:
- `ResearcherPipelinePage` (stub at `portal/src/pages/ResearcherPipelinePage.tsx`) uses `useAgentStream` to subscribe to active runs of `orgiq-researcher`.
- Approval gate surfaced via a modal in the reviewer's approval view.
- Full implementation deferred — see the stub for the scaffold.
