# Agent Portal

Agent Portal is an application for exploring an organization's people, knowledge, and work, with chat and voice-assisted navigation. It includes a React frontend (`portal/`), an Express backend (`middleware/`), agents, and deployment infrastructure.

## Prerequisites

Check these before installing anything.

- **Node.js 22 recommended** (`.nvmrc`; 20.19 or newer works, which is what Vite needs), npm, and Git.
- **GitHub SSH access to two private repositories.** `service-runtime` and `distributed-core` are private, and both are `github:` dependencies. `middleware/package.json` pins them directly, and the portal's vendored `realtime-modules` package depends on them too, so `npm install` in either folder currently fails without collaborator access to those two repositories (`git ls-remote git@github.com:connorhoehn/service-runtime.git` should succeed). There is no credential-free install path yet. Everything else in the install is public or vendored in `portal/vendor/`.
- **Mock mode needs nothing else.** It uses fixture data and does not need a cloud account, Docker, or Python.

Optional:

- **Tilt:** the optional `tilt` CLI can start the local stack after the npm dependencies are installed. Some optional forwarding services also need Colima.
- **Docker:** for notebooks and the social compose profile; other services and live integrations can need containers and configuration.
- **Python 3.12:** for agent development, not the mock app.
- **Cloud deployment:** AWS CLI and credentials, plus the dependencies in `infra/`; deployment scripts are in `infra/scripts/`.

## Get it running

For the quickest local setup, once the prerequisites are met, paste this into a Codex or Claude session:

```text
Clone https://github.com/connorhoehn/agent-portal.git if it is not already here.
Set up Agent Portal for local development using its README. Check that Node.js,
git, npm, and any required GitHub access are available; explain anything I need
to install or authenticate. Install the portal and middleware dependencies,
start the middleware in mock mode and the portal, and verify that the API health
check and http://localhost:5183 work. Tell me where to open the app, how to stop
it, and which integrations need additional setup. Don't deploy anything or
create cloud resources.
```

To do it yourself, install dependencies once:

```bash
cd middleware && npm install
cd ../portal && npm install
```

Run these in separate terminals:

```bash
cd middleware && npm run dev:mock   # API: http://localhost:3001
cd portal && npm run dev            # App: http://localhost:5183
```

Mock mode includes a demo user; visit [localhost:5183/workspaces](http://localhost:5183/workspaces) to choose another persona. See the [demo walkthrough](docs/demo-script.md).

Check the backend with `curl http://localhost:3001/api/health`; its service name should be `orgiq-middleware`. Stop each server with Ctrl+C. For live voice, configure `OPENAI_API_KEY` in `middleware/.env`; without it mock mode uses a scripted voice session. See the [voice design](docs/voice-navigator-spec.md).

Environment variables for the run:

| Variable | Applies to | Default | Effect |
| --- | --- | --- | --- |
| `PORT` | middleware | `3001` | API port. |
| `PORTAL_PORT` | portal | `5183` | Dev server port. When set, Vite fails instead of picking another port if it is taken. |
| `API_PROXY_TARGET` | portal | probes `127.0.0.1:3001`, then `:3011` | Where `/api` is proxied. Set it when the middleware runs on another port, e.g. `PORT=3937` with `API_PROXY_TARGET=http://127.0.0.1:3937`. |
| `BIND_HOST` | middleware, portal | `127.0.0.1` in dev | Interface to listen on. Both servers are loopback-only by default; set `BIND_HOST=0.0.0.0` on each to reach the portal from another device on your network (the dev stack uses a permissive demo identity, so only do this on a network you trust). |

## Former names

This repository was called `aws-agentcore` (the checkout folder may still be). The Work tenant's code name is `orgiq`, which is why the middleware package is `@orgiq/middleware`, the health check reports `orgiq-middleware`, and `orgiq` appears throughout the code. They all mean the same thing as "Agent Portal"; the old names have not been mass-renamed.

## Related projects

These repositories provide shared components and supporting services. **You do not need to clone them for the basic mock setup**: the app pins them as dependencies or vendors them. Two of them, service-runtime and distributed-core, are private and fetched over SSH during `npm install` (see Prerequisites).

- [ui-components](https://github.com/connorhoehn/ui-components) — shared React components used by the portal.
- [realtime-modules](https://github.com/connorhoehn/realtime-modules) — presence, chat, calls, and collaborative document features.
- [service-runtime](https://github.com/connorhoehn/service-runtime) — service-to-service authentication.
- [distributed-core](https://github.com/connorhoehn/distributed-core) — clustering and coordination primitives.
- [message-queue](https://github.com/connorhoehn/message-queue) — messaging service.
- [realtime-examples](https://github.com/connorhoehn/realtime-examples) — reference realtime applications and reusable infrastructure constructs.
- [platform-api](https://github.com/connorhoehn/platform-api) — API for calls, document workspaces, and lobby admission.
- [live-video-streaming](https://github.com/connorhoehn/live-video-streaming) — media server for audio and video calls.
- [managed-nosql-store](https://github.com/connorhoehn/managed-nosql-store) — local DynamoDB-compatible storage.

For more context, see the [project story](docs/project-story.md) and [next steps](docs/next-steps.md).
