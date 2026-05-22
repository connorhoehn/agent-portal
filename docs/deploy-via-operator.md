# OrgIQ Deployment via dc-k8s-operator

Deploys OrgIQ portal + middleware to a Kubernetes cluster using the
`distributed-core.dev/v1alpha1` Workload + Application CRDs reconciled by
`dc-k8s-operator`.

---

## Prerequisites

1. **dc-k8s-operator installed** and reconciling in the target cluster.
   Verify: `kubectl get crd workloads.distributed-core.dev` returns the CRD.

2. **`orgiq` namespace exists**:
   ```bash
   kubectl create namespace orgiq
   ```

3. **Service-auth secret provisioned** (used by middleware to sign requests
   to the gateway):
   ```bash
   kubectl create secret generic orgiq-service-auth \
     --namespace orgiq \
     --from-literal=secret="<your-shared-hmac-secret>"
   ```
   The secret value must match the `orgiq-middleware` entry in the gateway's
   `SERVICE_AUTH_ALLOWED_SERVICES` config.

4. **Gateway reachable** from within the cluster at
   `gateway.platform.svc.cluster.local` (assumes the gateway is deployed in
   the `platform` namespace). Adjust the `WEBSOCKET_GATEWAY_URL` +
   `VITE_GATEWAY_URL` env values in the Workload YAMLs if your topology differs.

---

## Step 1 — Build + push images

No CI/CD is configured; push manually from the project root.

```bash
# portal (production stage)
docker build \
  --target production \
  --build-context ui_components=../ui-components \
  --build-context realtime_modules=../websocket-gateway/realtime-modules \
  -t connorhoehnslalom/orgiq-portal:dev \
  portal/

docker push connorhoehnslalom/orgiq-portal:dev

# middleware (production stage)
docker build \
  --target production \
  --build-context realtime_modules=../websocket-gateway/realtime-modules \
  -t connorhoehnslalom/orgiq-middleware:dev \
  middleware/

docker push connorhoehnslalom/orgiq-middleware:dev
```

Replace `:dev` with a versioned tag (e.g. `:v1.0.0`) for stable rollouts.
Update the `image:` field in the Workload YAMLs accordingly.

---

## Step 2 — Apply CRDs

```bash
kubectl apply -f k8s/crds/portal-workload.yaml
kubectl apply -f k8s/crds/middleware-workload.yaml
kubectl apply -f k8s/crds/orgiq-application.yaml

# Also apply the AgenticPipeline for the researcher workflow (Phase 2.4)
kubectl apply -f k8s/crds/researcher-pipeline.yaml
```

---

## Step 3 — Verify reconciliation

Expected status flow: `Pending → Provisioning → Ready`

```bash
# Workload status
kubectl get workload orgiq-portal -n orgiq -o yaml
kubectl get workload orgiq-middleware -n orgiq -o yaml

# Application status
kubectl get application orgiq -n orgiq -o yaml
```

Ready state looks like:

```yaml
status:
  phase: Ready
  conditions:
    - type: Reconciled
      status: "True"
      reason: DeploymentReady
```

---

## Step 4 — Access locally

```bash
# Forward portal
kubectl port-forward svc/orgiq-portal 5173:5173 -n orgiq

# Forward middleware (optional, for direct API calls)
kubectl port-forward svc/orgiq-middleware 3001:3001 -n orgiq
```

Open `http://localhost:5173` to verify the portal is serving.

---

## Step 5 — Trigger the researcher pipeline

Once the `orgiq-researcher` AgenticPipeline is applied and the operator
reconciles it, trigger a run via the gateway webhook route:

```bash
curl -X POST https://<gateway-host>/api/orgiq/researcher/trigger \
  -H 'Content-Type: application/json' \
  -d '{"query": "latest developments in AI regulation"}'
```

Or via platform-api:

```bash
curl -X POST https://<platform-api-host>/api/pipelines/orgiq-researcher/trigger \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"query": "latest developments in AI regulation"}'
```

See `docs/researcher-pipeline-crd.md` for the full trigger + observe flow.

---

## Phase 3 status

| Sub-phase | Status | Notes |
|---|---|---|
| Phase 3.1 — CRDs declared | DONE | `portal-workload.yaml`, `middleware-workload.yaml`, `orgiq-application.yaml` |
| Phase 3.2 — Build + push images | PENDING | Manual; no CI/CD. Run Step 1 above. |
| Phase 3.3 — Apply + verify Ready in real cluster | PENDING | Blocked on Phase 3.2 + cluster access. |
