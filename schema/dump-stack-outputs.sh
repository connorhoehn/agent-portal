#!/usr/bin/env bash
# dump-stack-outputs.sh — regenerate middleware/.env.aws from CloudFormation.
#
# Referenced by the .env.aws header since 2026-05 but previously unwritten —
# this is the canonical generator now. Pulls outputs from every OrgIQ-* stack
# and maps them to the env vars middleware/src/config.ts reads. Safe to re-run
# after any stack change.
#
# Usage:  ./schema/dump-stack-outputs.sh [--mock]   (--mock keeps MOCK_*=true)
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"
MOCK_FLAG="false"
[[ "${1:-}" == "--mock" ]] && MOCK_FLAG="true"

python3 - "$REGION" "$MOCK_FLAG" <<'PYEOF'
import json, subprocess, sys
from datetime import date

region, mock = sys.argv[1], sys.argv[2]

raw = subprocess.check_output([
    "aws", "cloudformation", "describe-stacks", "--region", region,
    "--query", "Stacks[?starts_with(StackName, `OrgIQ`)].{name: StackName, outputs: Outputs}",
    "--output", "json",
], text=True)
stacks = json.loads(raw)

# Flatten: OutputKey and ExportName both become lookup keys.
vals: dict[str, str] = {}
for st in stacks:
    for o in (st["outputs"] or []):
        vals[o["OutputKey"]] = o["OutputValue"]
        if o.get("ExportName"):
            vals[o["ExportName"]] = o["OutputValue"]

account = subprocess.check_output(
    ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
    text=True).strip()


def cognito_client_secret() -> str:
    """The one value CloudFormation cannot give us.

    Cognito never exposes an app client's secret as a stack output, so a
    regenerated .env.aws used to come back WITHOUT it — and the middleware
    treats a secretless Cognito config as "SSO not configured", falling back to
    the user picker with no error anywhere. A rebuild silently turned SSO off.
    Fetch it from the API instead, and leave it blank only when there is
    genuinely no pool yet.
    """
    pool, client = vals.get("UserPoolId", ""), vals.get("UserPoolClientId", "")
    if not pool or not client:
        return ""
    try:
        return subprocess.check_output([
            "aws", "cognito-idp", "describe-user-pool-client", "--region", region,
            "--user-pool-id", pool, "--client-id", client,
            "--query", "UserPoolClient.ClientSecret", "--output", "text",
        ], text=True, stderr=subprocess.DEVNULL).strip().replace("None", "")
    except subprocess.CalledProcessError:
        return ""

def pick(*keys: str, default: str = "") -> str:
    for k in keys:
        if k in vals:
            return vals[k]
    return default

ecr = f"{account}.dkr.ecr.{region}.amazonaws.com"

def social_block() -> str:
    """OrgIQ-Social (deploySocial=true): the middleware gateway's chat tables
    and Redis, written COMMENTED OUT on purpose.

    This file configures a LAPTOP middleware. The Redis is ElastiCache inside
    the middleware VPC, unreachable from here, so a live REDIS_URL would make
    every call frame fail until the connection times out. The chat tables ARE
    reachable (IAM), but `npm run dev:mock` does not blank SOCIAL_CHAT_*, and
    under MOCK_AURORA the gateway seeds its fixture channels into any empty
    table it is pointed at — a stale .env.aws would write mock rows into the
    deployed tables. Uncomment deliberately. The deployed task gets all three
    from OrgIQ-MiddlewareService (REDIS_URL via SSM /orgiq/social/redis-url).
    """
    prefix = pick("SocialChatTablePrefix", "SocialTablePrefix", "orgiq-social-table-prefix")
    redis = pick("SocialRedisUrl")
    if not prefix and not redis:
        return "# OrgIQ-Social not deployed (--context deploySocial=true): social chat and\n# realtime state stay in memory locally.\n"
    return (
        "# OrgIQ-Social — commented out on purpose; see social_block() in\n"
        "# schema/dump-stack-outputs.sh before uncommenting.\n"
        f"# SOCIAL_CHAT_STORE=dynamo\n"
        f"# SOCIAL_CHAT_TABLE_PREFIX={prefix}\n"
        f"# REDIS_URL={redis}   # inside the VPC: unreachable from a laptop\n"
    )

client_secret = cognito_client_secret()
# Cognito rejects non-localhost HTTP callbacks, so the local BFF URL is the
# only one that works until the deployed middleware has an HTTPS origin.
callback_url = "http://localhost:3001/api/auth/callback" if client_secret else ""
portal_origin = "http://localhost:5183" if client_secret else ""

env = f"""# Generated from CloudFormation stack outputs on {date.today().isoformat()}.
# Re-run schema/dump-stack-outputs.sh to regenerate after stack changes.
# Loaded by middleware via dotenv from this path.

AWS_REGION={region}
AWS_ACCOUNT_ID={account}

# Mock fallbacks. Set any of these to true to bypass real AWS for that domain.
MOCK_AURORA={mock}
MOCK_AGENTCORE={mock}
MOCK_GUARDRAILS={mock}
MOCK_CLOUDWATCH={mock}

# OrgIQ-Aurora
AURORA_CLUSTER_ARN={pick('ClusterArn', 'orgiq-aurora-cluster-arn')}
AURORA_SECRET_ARN={pick('CredentialsSecretArn', 'orgiq-aurora-secret-arn')}
AURORA_DB_NAME={pick('DbName', default='orgiq')}

# OrgIQ-Foundation
SCORES_TABLE={pick('ScoresTableName', 'orgiq-scores-table-name', default='orgiq-scores')}
SESSIONS_TABLE={pick('SessionsTableName', 'orgiq-sessions-table-name', default='orgiq-sessions')}
DOCUMENTS_BUCKET={pick('DocumentsBucketName', default=f'orgiq-documents-{account}-{region}')}
ARTIFACTS_BUCKET={pick('ArtifactsBucketName', default=f'orgiq-artifacts-{account}-{region}')}

# OrgIQ-KnowledgeBase
KNOWLEDGE_BASE_ID={pick('KnowledgeBaseId', 'orgiq-knowledge-base-id')}
KB_SERVICE_ROLE_ARN={pick('KbServiceRoleArn', 'KBServiceRoleArn', 'ServiceRoleArn', 'orgiq-kb-service-role-arn', default=f'arn:aws:iam::{account}:role/orgiq-kb-service-role')}

# OrgIQ-Guardrails
GUARDRAIL_ID={pick('GuardrailId', 'orgiq-guardrail-id')}
GUARDRAIL_VERSION={pick('GuardrailVersion', default='DRAFT')}
GUARDRAIL_ID_MEMBER={pick('GuardrailIdMember', 'orgiq-guardrail-id-member')}
GUARDRAIL_ID_ORG_LEADER={pick('GuardrailIdOrgLeader', 'orgiq-guardrail-id-org-leader')}
GUARDRAIL_ID_HR_ADMIN={pick('GuardrailIdHrAdmin', 'orgiq-guardrail-id-hr-admin')}

# OrgIQ-Authorization
POLICY_STORE_ID={pick('PolicyStoreId', 'orgiq-policy-store-id')}

# OrgIQ-AgentCoreMemory
MEMORY_ID={pick('MemoryId', 'orgiq-memory-id')}

# OrgIQ-AgentCoreCapabilities
BROWSER_ID={pick('BrowserId', 'orgiq-browser-id')}
BROWSER_PROFILE_ID={pick('BrowserProfileId', 'orgiq-browser-profile-id')}
CODE_INTERPRETER_ID={pick('CodeInterpreterId', 'orgiq-code-interpreter-id')}
WORKLOAD_IDENTITY_ARN={pick('WorkloadIdentityArn', 'orgiq-workload-identity-arn')}

# OrgIQ-AgentCorePolicy
POLICY_ENGINE_ID={pick('PolicyEngineId', 'orgiq-policy-engine-id')}

# OrgIQ-AgentCoreGateway
GATEWAY_ID={pick('GatewayId', 'GatewayIdentifier', 'orgiq-gateway-id')}
GATEWAY_URL={pick('GatewayUrl', 'orgiq-gateway-url')}

# OrgIQ-AgentCoreTelemetry
QUALITY_EVALUATOR_ID={pick('QualityEvaluatorId', 'orgiq-quality-evaluator-id')}
TOOL_SELECTION_EVALUATOR_ID={pick('ToolSelectionEvaluatorId', 'orgiq-tool-selection-evaluator-id')}

# OrgIQ-Devbox
DEVBOX_RUNTIME_ARN={pick('DevboxRuntimeArn', 'orgiq-devbox-runtime-arn')}

# OrgIQ-PromptCanary (gated on --context deployCanary=true)
CANARY_SUBJECT_A_ARN={pick('SubjectPromptAArn')}
CANARY_SUBJECT_B_ARN={pick('SubjectPromptBArn')}
CANARY_JUDGE_PROMPT_ARN={pick('JudgePromptArn')}
CANARY_SCORES_LOG_GROUP={pick('ScoresLogGroupName', default='/orgiq/canary/scores')}

# OrgIQ-Authentication — enterprise SSO (Cognito authenticates; mintSession
# still owns the session). All four must be set for cognitoEnabled(); a blank
# CLIENT_SECRET reads as "not configured" and silently falls back to the picker.
COGNITO_USER_POOL_ID={pick('UserPoolId', 'orgiq-cognito-user-pool-id')}
COGNITO_CLIENT_ID={pick('UserPoolClientId', 'orgiq-cognito-client-id')}
COGNITO_CLIENT_SECRET={client_secret}
COGNITO_DOMAIN={pick('HostedUiDomain', 'orgiq-cognito-domain')}
COGNITO_CALLBACK_URL={callback_url}
# Where the BFF sends the browser after a successful login. Needed only when the
# portal is on a different origin than this middleware, which is exactly the
# local-dev layout (portal :5183, middleware :3001) — without it a relative
# redirect resolves against :3001 and SSO ends on a middleware 404.
PORTAL_ORIGIN={portal_origin}

{social_block()}
# Runtime image ECR URIs
SUPERVISOR_ECR_URI={ecr}/orgiq-supervisor
SEARCH_ECR_URI={ecr}/orgiq-search
SCORING_ECR_URI={ecr}/orgiq-scoring
ADVISOR_ECR_URI={ecr}/orgiq-advisor
INGESTION_ECR_URI={ecr}/orgiq-ingestion
GRAPH_BUILDER_ECR_URI={ecr}/orgiq-graph-builder
"""

out = "middleware/.env.aws"
with open(out, "w") as f:
    f.write(env)

missing = [line.split("=")[0] for line in env.splitlines()
           if line and "=" in line and line.endswith("=") and not line.startswith("#")]
print(f"wrote {out}")
if missing:
    print(f"⚠️  unresolved (blank) keys: {', '.join(missing)}")
PYEOF
