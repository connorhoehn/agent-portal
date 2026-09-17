# Docker/ECR Connectivity Issue

## Problem

Docker (via Colima) cannot connect to AWS ECR despite:
- ✅ Docker networking works (can pull from Docker Hub, ping external hosts)
- ✅ DNS resolution works (can resolve ECR endpoint)
- ✅ AWS credentials are valid (AWS CLI works)

## Error

```
Error response from daemon: Get "https://647757222309.dkr.ecr.us-east-1.amazonaws.com/v2/": 
net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)
```

## Verification Steps Taken

1. **Docker networking**: ✅ Working
   ```bash
   docker run --rm alpine ping -c 2 google.com
   # Successfully pulled alpine image and pinged Google
   ```

2. **DNS resolution**: ✅ Working  
   ```bash
   docker run --rm alpine nslookup 647757222309.dkr.ecr.us-east-1.amazonaws.com
   # Resolved to 44.219.104.119
   ```

3. **AWS credentials**: ✅ Valid
   ```bash
   aws sts get-caller-identity
   # Returns valid role in account 647757222309
   ```

4. **ECR login**: ❌ Fails
   ```bash
   aws ecr get-login-password | docker login --username AWS --password-stdin 647757222309.dkr.ecr.us-east-1.amazonaws.com
   # Timeout connecting to ECR
   ```

## Impact

Cannot build and push container images for:
- **OrgIQ-Devbox**: Requires `orgiq-devbox:latest` in ECR
- **OrgIQ-MiddlewareService**: Requires `orgiq-middleware:latest` in ECR

Both stacks remain undeployed.

## Possible Causes

1. **Colima networking configuration**: Colima VM may not have proper routing to AWS service endpoints
2. **VPN/Proxy interference**: Corporate VPN or proxy may be blocking HTTPS to ECR
3. **MTU issues**: Packet fragmentation issues with VPN or Colima network bridge
4. **AWS service endpoint reachability**: ECR endpoint may require specific network configuration

## Workarounds

### Option 1: Use Docker Desktop instead of Colima
Docker Desktop typically has better macOS networking integration.

### Option 2: Build on EC2 and push from there
Build images on an EC2 instance in the same region:
```bash
# On EC2 instance
git clone <repo>
cd agents/devbox
./build.sh

cd ../..
cd middleware  
docker build -t $(aws ecr describe-repositories --repository-names orgiq-middleware --query 'repositories[0].repositoryUri' --output text):latest .
docker push ...
```

### Option 3: Debug Colima networking
```bash
# Restart with explicit DNS
colima stop
colima start --network-address

# Or restart Docker daemon
colima ssh
sudo systemctl restart docker
```

### Option 4: Use AWS CodeBuild
Create a CodeBuild project to build and push images to ECR.

## Current Deployment Status

- **16/18 stacks**: ✅ Deployed and healthy
- **2/18 stacks**: ❌ Blocked on image builds
  - OrgIQ-Devbox
  - OrgIQ-MiddlewareService

## Next Steps

1. Investigate Colima networking configuration
2. Try Docker Desktop as alternative
3. Consider building images on EC2 or via CodeBuild
4. Document successful workaround in deployment checklist
