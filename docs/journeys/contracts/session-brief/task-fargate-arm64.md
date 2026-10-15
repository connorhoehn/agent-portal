# Session brief — job-contract-task-fargate-arm64

> Assembled 2026-10-14 for run job-contract-task-fargate-arm64 · 1,031 of 6,000 tokens · brief-job-contract-task-fargate-arm64

## Runbooks for this work

### 1. Deploy a Mac-built image to Fargate without exec format errors (rb-fargate-arm64-image v1)
Included because: tool fargate; keywords crash, loop, fargate, image, built.

# Deploy a Mac-built image to Fargate without exec format errors

Pin the task definition to ARM64 before deploying an image built on Apple Silicon, so the task starts instead of crash-looping with exec format error.

## Use when

- You built a container image on a Mac (Apple Silicon) and are deploying it to Fargate.
- A Fargate task is replaced in a loop and its log says exec format error.

## Not for

- Images built in CI on x86_64 runners, which need the X86_64 platform instead.
- Lambda functions, which set their architecture on the function.

## Before you start

- [ ] You know the ECS cluster, service and task family (`$CLUSTER`, `$SERVICE`, `$TASK_FAMILY`).
- [ ] The image is pushed to ECR as `$IMAGE_URI`.

## Steps

1. **Check the architecture of the image you built.**
   ```bash
   docker image inspect "$IMAGE_URI" --format '{{.Architecture}}'
   ```
   Expect `arm64` for an Apple Silicon build.
2. **Check which platform the task definition asks Fargate for.**
   ```bash
   aws ecs describe-task-definition --task-definition "$TASK_FAMILY" --query 'taskDefinition.runtimePlatform'
   ```
   Expect `cpuArchitecture: ARM64`, while `null` means Fargate falls back to x86_64 and the task will crash.
3. **Pin the task definition to ARM64 in its CDK stack, then deploy the stack.**
   ```bash
   grep -rn "cpuArchitecture: ecs.CpuArchitecture.ARM64" infra/lib
   infra/scripts/deploy.sh "$STACK"
   ```
   Expect the grep shows the pin in your stack, and the deploy ends with the stack in `UPDATE_COMPLETE`.
4. **Wait for the Fargate service to settle on the new task definition.**
   ```bash
   aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
   aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[desiredCount,runningCount]'
   ```
   Expect running equals desired (for example `[1, 1]`), and no task stopped with exec format error.

## Verify

- The service runs as many tasks as it wants.
  ```bash
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[desiredCount,runningCount]'
  ```
- The newest task's log shows the app starting, not exec format error.

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| Task stops with `exec format error` | `runtimePlatform` missing or set to X86_64 | Redo step 3 |
| Stack is `UPDATE_COMPLETE` but nothing is running | The ECR repo is empty or the tag is missing | Push the image, then redeploy; the stack completes even with no image |
| `CannotPullContainerError` | The image manifest has no linux/arm64 entry | Rebuild with `docker buildx build --platform linux/arm64` and push again |

## Roll back

1. Point the service back at the previous task definition revision if the new one fails its health checks.
   ```bash
   aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$TASK_FAMILY:$PREVIOUS_REVISION"
   ```

## Selection hints

- Labels: infra, fargate
- Tools: fargate, ecs, docker
- Keywords: fargate, arm64, image, exec format error, task definition, crash loop

## Notes

ARM64 is also the cheaper Fargate option, so pinning it costs nothing.
The middleware service stack (`infra/lib/middleware-service-stack.ts`) already pins ARM64 and is the example to copy.

## How to report back
- When you finish, say which runbooks you followed: `lab applied rb-fargate-arm64-image followed` (or `lab applied rb-fargate-arm64-image failed --step 2 "why"`).
- If a runbook was wrong or missing a step, write the corrected markdown to a file and run `lab propose rb-fargate-arm64-image ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- Record anything else you learned with `lab remember`.
