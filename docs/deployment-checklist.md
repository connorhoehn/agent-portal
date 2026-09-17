# OrgIQ Deployment Checklist

## Prerequisites

### 1. AWS Credentials
```bash
aws-azure-login --mode gui
# Must assume aws-innovationlabs-washingtondc1-admin role
# Account: 647757222309 (innovation lab)
```

### 2. Docker Running
**Required for:** Building agent and service container images

Check Docker is running:
```bash
docker ps
```

If using Colima on macOS:
```bash
colima start
```

### 3. Node Dependencies
```bash
cd infra && npm ci
```

## Deployment Sequence

### Phase 1: Core Infrastructure (No Container Images Required)
```bash
cd infra
./scripts/deploy.sh  # Deploys 16 base stacks
```

**Stacks deployed in Phase 1:**
- OrgIQ-Foundation
- OrgIQ-Aurora
- OrgIQ-KnowledgeBase
- OrgIQ-Guardrails
- OrgIQ-Authorization
- OrgIQ-Authentication
- OrgIQ-AgentCoreMemory
- OrgIQ-AgentCorePolicy
- OrgIQ-AgentCoreCapabilities
- OrgIQ-AgentCoreRuntime (ECR repos only, no runtimes)
- OrgIQ-AgentCoreGateway
- OrgIQ-AgentCoreTelemetry
- OrgIQ-Agents
- OrgIQ-Observability
- OrgIQ-SpanProjector
- OrgIQ-PromptCanary

### Phase 2: Agent Container Images
**Requires Docker running**

```bash
cd agents/base
./build.sh  # Builds shared base image

cd ..
./build-all.sh  # Builds all 8 agent images (ARM64)
```

### Phase 3: Agent Runtimes
```bash
cd infra
./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true
# Or for specific agents:
# --context onlyAgents=supervisor,search
```

### Phase 4: Devbox (Optional)
**Requires Docker running**

```bash
cd agents/devbox
./build.sh  # Builds and pushes devbox image

cd ../../infra
./scripts/deploy.sh OrgIQ-Devbox --context deployDevbox=true
```

### Phase 5: Middleware Service (Optional)
**Requires Docker running**

⚠️ **IMPORTANT:** The stack creates the ECR repo and attempts to deploy the ECS service in one operation. The service will fail with "CannotPullContainerError" if the image doesn't exist yet. Build and push the image BEFORE deploying the stack.

Build middleware image:
```bash
cd middleware

# Get the ECR repository URI (create repo if it doesn't exist)
aws ecr describe-repositories --repository-names orgiq-middleware 2>/dev/null || \
  aws ecr create-repository --repository-name orgiq-middleware

# Build and push ARM64 image
docker buildx build --platform linux/arm64 \
  -t $(aws ecr describe-repositories --repository-names orgiq-middleware --query 'repositories[0].repositoryUri' --output text):latest \
  --push .
```

Deploy service:
```bash
cd ../infra
./scripts/deploy.sh OrgIQ-MiddlewareService --context deployMiddlewareService=true
# Optionally add --context albAllowCidr=<your-ip>/32 to allow traffic
```

If the service fails to start, check ECS events:
```bash
aws ecs describe-services --cluster orgiq-middleware --services orgiq-middleware \
  --query 'services[0].events[0:5]'
```

### Phase 6: Post-Deployment Configuration

Regenerate middleware environment file:
```bash
cd schema
./dump-stack-outputs.sh
```

This creates `middleware/.env.aws` with all stack outputs.

## Common Issues

### Docker Not Running
**Error:** `failed to connect to the docker API at unix:///Users/connor.hoehn/.colima/default/docker.sock`

**Fix:** Start Docker/Colima:
```bash
colima start
```

### Image Doesn't Exist in Repository
**Error:** `The specified image identifier does not exist in the repository`

**Fix:** Build and push the image first (see phases above)

### Runtime Deployment Times Out
**Cause:** Runtime deletions can exceed CloudFormation timeout

**Fix:** Use `destroy.sh` which pre-drains runtimes before stack deletion

### Middleware Service Can't Pull Image
**Error:** `CannotPullContainerError: 647757222309.dkr.ecr.us-east-1.amazonaws.com/orgiq-middleware:latest: not found`

**Cause:** The MiddlewareService stack creates the ECR repo AND deploys the ECS service in one operation. If the image doesn't exist, the service deployment triggers the circuit breaker.

**Fix:** 
1. Build and push image BEFORE deploying the stack (see Phase 5)
2. If stack already failed, delete it and redeploy after building image:
   ```bash
   aws cloudformation delete-stack --stack-name OrgIQ-MiddlewareService
   aws cloudformation wait stack-delete-complete --stack-name OrgIQ-MiddlewareService
   # Then build image and redeploy
   ```
3. Verify image exists: `aws ecr list-images --repository-name orgiq-middleware`

### ECS Deployment Circuit Breaker Triggered
**Error:** `ECS Deployment Circuit Breaker was triggered`

**Cause:** ECS tasks failed to start successfully (usually image pull failure)

**Check:**
```bash
aws ecs describe-services --cluster orgiq-middleware --services orgiq-middleware \
  --query 'services[0].events[0:5]'
```

Look for `CannotPullContainerError` or task failure reasons.

## Verification

Check all deployed stacks:
```bash
aws cloudformation list-stacks \
  --query 'StackSummaries[?starts_with(StackName, `OrgIQ-`) && StackStatus==`CREATE_COMPLETE`].StackName' \
  --output table
```

Expected: 16 stacks minimum, 18 with Devbox and MiddlewareService

## Database Initialization

After Aurora deploys, apply schemas:
```bash
cd schema
python load_schema.py
```

See `CLAUDE.md` for full schema application steps and synthetic corpus generation.
