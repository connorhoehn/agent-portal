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

def pick(*keys: str, default: str = "") -> str:
    for k in keys:
        if k in vals:
            return vals[k]
    return default

ecr = f"{account}.dkr.ecr.{region}.amazonaws.com"

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
