# Agent Portal

Agent Portal is an organizational intelligence application for exploring people, knowledge and work with conversational and voice-assisted tools. It includes a React portal, an Express backend, agents, and infrastructure for running the application.

The product is split into tenants that share one backend: work (`orgiq`), `assessment`, `social`, `pipelines` and `access`. Each has its own section of the portal and its own API prefix.

How this repository and its siblings came to be, and how they depend on each other, is told in [docs/project-story.md](docs/project-story.md). What is loose and what comes next is in [docs/next-steps.md](docs/next-steps.md).

## Project layout

- `agents/` holds the Strands agents (Python 3.12) that run on AgentCore Runtime, plus shared helpers in `agents/_shared`, the base image in `agents/base`, and the golden-set tests in `agents/tests`.
- `infra/` is the CDK (TypeScript) code for every AWS stack, with deploy and teardown wrappers in `infra/scripts`.
- `middleware/` is the Express backend-for-frontend. It proxies AG-UI streaming over SSE, talks to Aurora through the RDS Data API, and hosts the realtime gateway on `/ws`.
- `portal/` is the React + Vite UI, built on the ui-components library.
- `schema/` has the Aurora SQL and the synthetic corpus pipeline in `schema/synth`.
- `notebooks/` has Jupyter notebooks that walk through each AgentCore capability (AWS and GCP flavours).
- `scripts/` has build, image, deploy-support, load-test and check scripts. `tenants/` holds the tenant manifest, `k8s/` has Kubernetes custom-resource examples, and `tools/` has the local-compute worker.
- `Tiltfile` and `docker-compose.yml` define the local development stack.

## Getting started

To run the app locally you need Node 20 or newer (checked on Node 25), `git`, and SSH access to GitHub: the middleware pins `service-runtime` as a `github:` dependency. Nothing else is needed: no Docker, no Python, no AWS account. The portal installs its sibling libraries from tarballs in `portal/vendor`, so it needs no network beyond npm. Python 3.12 is only for the agents, Docker only for the notebooks and the optional `social` compose profile, and the AWS CLI and credentials only for deploying. The CDK CLI is installed by `npm install` in `infra/`. The optional `tilt` CLI runs the local stack in one command.

### Run it locally

The mock backend serves fixture data. `dev:mock` sets every mock flag itself, so there is no `.env` to write.

```bash
cd middleware && npm install    # about 2.5 minutes, most of it the github: dependency
cd ../portal && npm install     # about 35 seconds
```

Then start the two processes in separate terminals:

```bash
cd middleware && npm run dev:mock    # http://localhost:3001, ready in about 10 seconds
cd portal && npm run dev             # http://localhost:5183
```

Check it: `curl localhost:3001/api/health` returns `"service":"orgiq-middleware"`, and the portal answers at http://localhost:5183.

`tilt up` starts the same two processes, but it does not install dependencies, so run both installs first. Its `platform-api-forward` and `social-docs-forward` resources need Colima and fail without it; ignore them, they only matter for real video calls and the document canvas.

To use other ports, set `PORT` for the middleware and point the portal's proxy at it; the portal's own port is fixed at 5183 (override with `npm run dev -- --port N --strictPort`):

```bash
cd middleware && PORT=3013 npm run dev:mock
cd portal && API_PROXY_TARGET=http://127.0.0.1:3013 npm run dev -- --port 5190 --strictPort
```

Open `/workspaces` and pick a person to sign in as (the walk-through in [docs/demo-script.md](docs/demo-script.md) names them). Without a sign-in the mock serves a demo user who holds every orgiq and assessment role. For `curl`, `POST /api/session/login` with `{"userId":"u-vera"}` and keep the cookie jar. `POST /api/__mock/reset` puts the fixtures back.

Notebooks run in Docker: `docker-compose up jupyter` serves them at http://localhost:8888.

### Test

Run `npm install` in `middleware/`, `portal/` and `infra/` first (the infra install takes about 45 seconds, and some middleware tests read from it).

```bash
cd middleware && npm test && npm run typecheck   # tests about 15 minutes, typecheck 15 seconds
cd portal && npm test && npm run typecheck       # tests 5 seconds, typecheck 7 seconds
cd infra && npm test                             # about 2 minutes
```

The middleware suite is large and slow; run it once, alone. On a fresh clone (7 November 2026) every suite passes: 599 suites, 8247 tests, with `INSECURE_DEV_MODE=true` set by the jest setup file. The portal tests, infra tests, agents' Python suites and both typechecks pass.

The agent tests need `botocore`. Install `schema/synth/requirements.txt` into a virtualenv, then:

```bash
cd agents/_shared && python -m unittest test_prompt_source test_callbacks
cd agents/tests && python golden_runner.py     # structural check, offline
```

Run the full middleware suite on its own. Two concurrent runs can hang.

CI: `.github/workflows/ci.yml` runs typecheck and tests on push; it has not run yet (no GitHub access from the machine that wrote it).

### Deployment

Deployment infrastructure and scripts live in `infra/` and `infra/scripts/`.

## Talk to it

The portal footer has a voice dock: press Ctrl+Shift+Space or click it, then speak. It can open pages, search people and records, list your initiatives, open the Computer Lab, start a computer, open a shell and run safe read-only commands, check bot sweeps and access requests, post a chat message after you confirm, and set your presence status.

- Put `OPENAI_API_KEY=...` in `middleware/.env` (gitignored; the middleware loads it, and an exported variable wins). Without a key the mint answers 503 and the dock says it is unavailable.
- `npm run dev:mock` sets `MOCK_VOICE=1` for you when there is no key, so the dock plays a scripted session offline. Set `MOCK_VOICE=1` yourself to force it with a key present.
- It costs money per minute of audio. Every session takes a budget hold up front (`VOICE_USD_PER_MINUTE`, default 0.05, times `VOICE_SESSION_MINUTES_P75`) and settles to the billed seconds.
- The dock is behind `features.voiceNavigator`, which is on under the Vite dev server (`VITE_VOICE_NAVIGATOR=1` turns it on elsewhere).

To debug a session, read its log. Each session keeps a structured event log: the mint, the dock's phases, tool calls and results, refusals, confirms, errors, the provider's usage, and the close or reap. It never holds what was said or a tool's arguments, which are stored only as a hash. Rows are kept for 30 days, at most 500 per session. Under `npm run dev:mock` every event is also appended to `middleware/.voice-log/<session id>.jsonl` (set by `VOICE_LOG_DIR`, ignored in production), so you can `tail -f` it while you talk. Four routes read your own sessions back, and nobody else's: `GET /api/voice/sessions?since=&limit=` lists them, `GET /api/voice/sessions/latest` returns the most recent one, `GET /api/voice/sessions/:id` returns one session with its tool calls and events, and `GET /api/voice/sessions/:id/export` downloads one session as a JSON file for a bug report. For example: `curl -s localhost:3001/api/voice/sessions/latest | jq`.

The design is in [docs/voice-navigator-spec.md](docs/voice-navigator-spec.md); `scripts/voice/probe-realtime.mjs` probes the live API with the same key.

## Architecture notes

- The portal is a React and Vite application; the middleware is its Express backend.
- The mock backend provides fixtures for local development and can reset writes through `POST /api/__mock/reset`.
- Agent responses stream over SSE. Realtime features use a gateway and short-lived session tokens.
- Production agents, data stores and deployment infrastructure live alongside the application in this repository.

## Related repositories

All of these sit next to this checkout under the same parent directory.

- `connorhoehn/ui-components`: the React component library behind the portal, consumed as a packed tarball in `portal/vendor`.
- `connorhoehn/realtime-modules`: presence, chat, calls and collaborative documents served over the realtime gateway, with matching client hooks.
- `connorhoehn/service-runtime`: signed service-to-service authentication for internal calls.
- `connorhoehn/distributed-core`: clustering and coordination primitives under the realtime gateway.
- `connorhoehn/message-queue`: the message queue service, built into the `mq` container image.
- `connorhoehn/realtime-examples`: reference realtime applications. Its `cdk/` package of reusable CDK constructs is vendored in `infra/vendor`.
- `connorhoehn/platform-api`: the HTTP API behind call sessions, document workspaces and lobby admission.
- `connorhoehn/live-video-streaming`: the media server (SFU) that carries call audio and video.
- `connorhoehn/managed-nosql-store`: a DynamoDB-compatible store used for local durable storage.
