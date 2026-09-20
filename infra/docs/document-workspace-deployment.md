# Opt-in document workspace deployment

`deployDocumentWorkspace=true` composes the existing `realtime-examples`
`cdk/document-workspace` package inside the middleware VPC/cluster. It creates
private gateway, platform-api, catalog, MQ and Redis tasks, with retained DynamoDB
tables and encrypted retained EFS uploads. It never deploys on an ordinary synth.

Preconditions: the middleware image is pushed (`deployMiddlewareService=true`),
an ALB HTTPS certificate is configured, the normal Cognito identity pool exists,
and each backend image has been built/pushed at an immutable digest. Supply a
`documentWorkspace` context object (or `MiddlewareServiceStackProps` property):

```json
{
  "tenantId": "assessment",
  "publicBaseUrl": "https://assessment.example.com",
  "grantIssuer": "assessment-bff",
  "grantKeyId": "v1",
  "grantPrivateKeySecretArn": "<existing Ed25519 private PEM secret ARN>",
  "grantPublicKeySecretArn": "<matching public PEM secret ARN>",
  "architecture": "ARM64",
  "images": {
    "gateway": {"repositoryName":"realtime-examples","digest":"sha256:<64 hex characters>"},
    "platform": {"repositoryName":"platform-api","digest":"sha256:<64 hex characters>"},
    "catalog": {"repositoryName":"event-catalog","digest":"sha256:<64 hex characters>"},
    "mq": {"repositoryName":"message-queue","digest":"sha256:<64 hex characters>"},
    "redis": {"repositoryName":"redis","digest":"sha256:<64 hex characters>"}
  }
}
```

The BFF alone receives the private signing key. Gateway/platform receive only its
public key and a separate session-policy credential. A private CloudMap BFF name
serves the authoritative session-epoch callback, avoiding an ALB/task-definition
construction cycle. The public ALB rejects that internal path. Tenant and
canonical document IDs remain grant scopes; this deployment does not convert the
upstream single-tenant storage schema into a multitenant API. The current BFF
adapter serves `assessment`; other tenant values are rejected at synthesis.

Public WebSocket URL is `wss://<publicBaseUrl>/document-realtime`. Protected
`/api/uploads/*` uses the same ALB origin. Platform stays private at the exported
CloudMap URL and the BFF uses `DOCUMENT_PLATFORM_INTERNAL_URL` for scoped workflow
requests. The construct injects `DOCUMENT_GATEWAY_INTERNAL_URL`,
`DOCUMENT_GATEWAY_PUBLIC_URL`, issuer/key ID/private key and policy credential into
the BFF. Add the chosen public hostname to DNS and cover it with the certificate.
The existing `albAllowCidr` restriction still controls listener reachability.

All document writers deploy stop-before-start with one task. A brief reconnect is
expected during rollout. No autoscaling or overlapping ownership is enabled. MQ
and document data are DynamoDB-backed; Redis is cache/presence state. Upload bytes
use the existing filesystem adapter mounted on EFS with encrypted transit and
access-point-scoped IAM. This is deliberately not a pretend S3 upload adapter.
Redis currently uses private plain TCP; authenticated/TLS Redis needs upstream
client configuration support before enabling that cache topology.

Synthesis is validated locally, not applied. Image build/restart, two-user cold
restart, signed upload authorization and BFF revocation acceptance remain separate
runtime gates; generated infrastructure does not by itself prove those flows.

`documentWorkspace.sourceOwnerSub` optionally names an existing assessment steward
for newly imported source mappings. It is passed only to the BFF as
`DOCUMENT_SOURCE_OWNER_SUB`. Omitting it leaves ownership unestablished; a viewer
is never promoted to owner by opening a document. Changing this setting does not
rewrite existing mapping ownership or automatically claim platform lifecycle rows.

## Optional accelerator source

`documentWorkspace.source` accepts `{url, secretArn}` for an existing accelerator
source adapter. The URL must use HTTPS; the secret is imported from Secrets Manager
and injected as `ASSESSMENT_SOURCE_SECRET` only into the BFF. The gateway, platform,
Redis and catalog never receive this source credential. The BFF receives the URL as
`ASSESSMENT_SOURCE_URL`. The URL must be reachable from the middleware task subnet;
private network routing and ingress are owned by the source deployment.

The accelerator remains a separately deployed external dependency. This construct
does not deploy its Python application or claim that untested runtime is packaged.
Omit the source configuration to run local canonical documents without it. The
local document launcher forwards explicitly configured source environment values;
its private settings file never embeds source credentials in committed artifacts.
