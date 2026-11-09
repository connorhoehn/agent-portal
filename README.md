# Agent Portal

Agent Portal is an application for exploring an organization's people, knowledge, and work, with chat and voice-assisted navigation. It includes a React frontend (`portal/`), an Express backend (`middleware/`), agents, and deployment infrastructure.

## Get it running

For the quickest local setup, paste this into a Codex or Claude session:

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

Mock mode uses fixture data and does not require a cloud account, Docker, or Python. It includes a demo user; visit [localhost:5183/workspaces](http://localhost:5183/workspaces) to choose another persona. See the [demo walkthrough](docs/demo-script.md).

To start it yourself, install dependencies once:

```bash
cd middleware && npm install
cd ../portal && npm install
```

Run these from the repository root in separate terminals:

```bash
cd middleware && npm run dev:mock   # API: http://localhost:3001
cd portal && npm run dev            # App: http://localhost:5183
```

Check the backend with `curl http://localhost:3001/api/health`; its service name should be `orgiq-middleware`. Stop each server with Ctrl+C. For live voice, configure `OPENAI_API_KEY` in `middleware/.env`; without it mock mode uses a scripted voice session. See the [voice design](docs/voice-navigator-spec.md).

## Related projects

These repositories provide shared components and supporting services. **You do not need to clone them for the basic mock setup above**; the app uses pinned dependencies and vendored packages.

- [ui-components](https://github.com/connorhoehn/ui-components) — shared React components used by the portal.
- [realtime-modules](https://github.com/connorhoehn/realtime-modules) — presence, chat, calls, and collaborative document features.
- [service-runtime](https://github.com/connorhoehn/service-runtime) — service-to-service authentication.
- [distributed-core](https://github.com/connorhoehn/distributed-core) — clustering and coordination primitives.
- [message-queue](https://github.com/connorhoehn/message-queue) — messaging service.
- [realtime-examples](https://github.com/connorhoehn/realtime-examples) — reference realtime applications and reusable infrastructure constructs.
- [platform-api](https://github.com/connorhoehn/platform-api) — API for calls, document workspaces, and lobby admission.
- [live-video-streaming](https://github.com/connorhoehn/live-video-streaming) — media server for audio and video calls.
- [managed-nosql-store](https://github.com/connorhoehn/managed-nosql-store) — local DynamoDB-compatible storage.

## Prerequisites and optional tools

- **Basic local app:** Node.js 20 or newer, npm, Git, and GitHub SSH access for a middleware dependency.
- **Tilt:** Optional `tilt` CLI can start the local stack after the npm dependencies are installed. Some optional forwarding services also need Colima.
- **Docker:** Optional for notebooks and the social compose profile; additional services and live integrations can require containers and configuration.
- **Python 3.12:** Needed for agent development, not the mock app.
- **Cloud deployment:** AWS CLI and credentials, plus the dependencies in `infra/`; deployment scripts are in `infra/scripts/`.

For more context, see the [project story](docs/project-story.md) and [next steps](docs/next-steps.md).
