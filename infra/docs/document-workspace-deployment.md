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
