# aws-agentcore

OrgIQ, the Organizational Intelligence Platform, is a multi-agent system on Amazon Bedrock AgentCore. It ingests organisational documents, builds a knowledge graph in Aurora, scores expertise, and answers "who knows what" through conversational search.

The product is split into tenants that share one backend: work (`orgiq`), `assessment`, `social`, `pipelines` and `access`. Each has its own section of the portal and its own API prefix.

## What's in the repo

- `agents/` holds the Strands agents (Python 3.12) that run on AgentCore Runtime, plus shared helpers in `agents/_shared`, the base image in `agents/base`, and the golden-set tests in `agents/tests`.
- `infra/` is the CDK (TypeScript) code for every AWS stack, with deploy and teardown wrappers in `infra/scripts`.
- `middleware/` is the Express backend-for-frontend. It proxies AG-UI streaming over SSE, talks to Aurora through the RDS Data API, and hosts the realtime gateway on `/ws`.
- `portal/` is the React + Vite UI, built on the ui-components library.
- `schema/` has the Aurora SQL and the synthetic corpus pipeline in `schema/synth`.
- `notebooks/` has Jupyter notebooks that walk through each AgentCore capability (AWS and GCP flavours).
- `scripts/` has build, image, deploy-support, load-test and check scripts. `tenants/` holds the tenant manifest, `k8s/` has Kubernetes custom-resource examples, and `tools/` has the local-compute worker.
- `Tiltfile` and `docker-compose.yml` define the local development stack.

## Getting started

You need Node 20 or newer, Python 3.12, and Docker. Deploying also needs the AWS CLI and credentials for the target account. The CDK CLI is installed by `npm install` in `infra/`. The optional `tilt` CLI runs the whole local stack in one command.

### Run it locally

No AWS access is needed. The mock backend serves fixture data.

```bash
tilt up                                # middleware on :3001, portal on :5183
```

Or start the two processes yourself:

```bash
cd middleware && npm install && npm run dev:mock
cd portal && npm install && npm run dev
```

Notebooks run in Docker: `docker-compose up jupyter` serves them at http://localhost:8888.

### Test

```bash
cd middleware && npm test && npm run typecheck
cd portal && npm test && npm run typecheck
cd infra && npm test
```

The agent tests need `botocore`. Install `schema/synth/requirements.txt` into a virtualenv, then:

```bash
cd agents/_shared && python -m unittest test_prompt_source test_callbacks
cd agents/tests && python golden_runner.py     # structural check, offline
```

Run the full middleware suite on its own. Two concurrent runs can hang.

### Deploy

Everything is deployed with CDK through the wrapper script, not with `agentcore deploy`.

```bash
cd infra
./scripts/deploy.sh [Stack] [--context key=value]
DEPLOY_PLAN_ONLY=true ./scripts/deploy.sh [Stack]    # prints the plan, changes nothing
./scripts/destroy.sh                                  # teardown
```

Agent runtimes need their container images to exist first, so they deploy in phases:

1. `./scripts/deploy.sh OrgIQ-AgentCoreRuntime` creates the image repositories.
2. `agents/base/build.sh` builds and pushes the base image.
3. `agents/build-all.sh` builds and pushes every agent image.
4. `./scripts/deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true` creates the runtimes.

The middleware image is built with `node scripts/docker/middleware-image-build.mjs` (add `--dry-run` to preview) and goes live with `--context deployMiddlewareService=true`. The portal is built, then published to S3 and CloudFront with `node scripts/portal-publish.mjs` after deploying with `--context deployPortal=true`.

The stacks create Aurora and the Bedrock knowledge base. Apply the Aurora schema with `schema/apply-schema.sh` (see `schema/README.md`), and generate demo content with `python -m schema.synth all` (see `schema/synth/README.md`).

## Architecture notes

- Each agent's system instructions are kept in Bedrock's managed template store and read at run time with a short cache. The system text hard-coded in each agent's `main.py` is only a fallback.
- The organisation graph is plain relational tables in Aurora PostgreSQL. Agents and the backend reach it through the RDS Data API with parameterised SQL, and the agents' read tools only accept `SELECT` and `WITH`.
- AG-UI streaming runs over SSE with `POST`, not `EventSource`, so the request can carry a body and headers.
- Embeddings use Titan Embeddings V2 at 1024 dimensions everywhere. Knowledge base searches pin the search type explicitly rather than relying on the default.
- Users, tenants and grants live in Aurora (`schema/identity_schema.sql`). Authorisation uses Cedar policies per tenant, in `middleware/seeds/roles/<tenant>/`.
- `npm run dev:mock` runs the backend against fixtures that follow a contract: they return rows and selectors rather than precomputed counts, take timestamps from a shared clock, and register every write so `POST /api/__mock/reset` undoes it. `POST /api/__mock/scenario` produces empty and error states without touching shared data.
- The portal's realtime socket connects to the gateway on `/ws`, authenticated with a short-lived token from `GET /api/session/realtime-token`.

## Related repositories

All of these sit next to this checkout under the same parent directory.

- `connorhoehnslalom/ui-components`: the React component library behind the portal, consumed as a packed tarball in `portal/vendor`.
- `connorhoehn/realtime-modules`: presence, chat, calls and collaborative documents served over the realtime gateway, with matching client hooks.
- `connorhoehn/service-runtime`: signed service-to-service authentication for internal calls.
- `connorhoehn/distributed-core`: clustering and coordination primitives under the realtime gateway.
- `connorhoehnslalom/message-queue`: the message queue service, built into the `mq` container image.
- `connorhoehn/realtime-examples`: reference realtime applications. Its `cdk/` package of reusable CDK constructs is vendored in `infra/vendor`.
- `connorhoehn/platform-api`: the HTTP API behind call sessions, document workspaces and lobby admission.
- `connorhoehn/live-video-streaming`: the media server (SFU) that carries call audio and video.
- `connorhoehn/managed-nosql-store`: a DynamoDB-compatible store used for local durable storage.
