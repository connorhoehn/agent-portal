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

## The six tenants

The portal hosts six products, called tenants. They are separate products that share only the backend (`middleware/`): each has its own navigation, roles and pages. They are registered in `tenants/manifest.json`; the page code is under `portal/src/pages/`.

| Tenant | Shown as | Roles | What it is for |
| --- | --- | --- | --- |
| `orgiq` | Work | member, sme, program-owner, org-leader, hr-admin | The original product: initiatives, people, knowledge, agent runs and runbooks, search and the voice navigator. Its code name is why `orgiq` appears throughout the code. |
| `assessment` | Assessment | assessor, lead-assessor, program-lead | Reviewing teams: submissions are scored by agents against dimensions, reviewed by people and published as reports and decks. |
| `social` | Social | participant, moderator, community-admin | Channels, direct messages, calls, rooms and recordings. The same communication plane is also embedded in the other tenants. |
| `pipelines` | Pipelines | author, operator, pipeline-admin | Definitions, workflows and runs of durable pipelines, with approvals and artifacts. Its runs act for the other products. |
| `access` | Access | requester, approver, access-admin | Requesting access from a catalog, approval chains computed from the directory, separation-of-duties policies, review campaigns and an audit trail. |
| `interviews` | Candidates | recruiter, interviewer, hiring-manager | Running job interviews end to end: openings and a question kit, candidates, rounds, an interview room with a shared code pad, scorecards, a debrief and a decision. A candidate joins from an invite link without an account. Design record: [interviews-tenant-plan.md](docs/interviews-tenant-plan.md). |

The role `admin` applies across all of them.

Milo is the meeting assistant: it joins a call, transcribes, and raises suggestions that a person confirms. It is used in Work meetings and in Candidates interviews. See [the rebuild plan](docs/milo-rebuild/REBUILD-PLAN.md) and the [meeting assistant design](docs/meeting-assistant-design.md).

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

## Map of the documents

The list of open work is [docs/ledger.md](docs/ledger.md). "History" means the document records what was decided or found at the time and may be out of date; the ledger says which parts mislead.

| Document | What it is | Status |
| --- | --- | --- |
| [docs/ledger.md](docs/ledger.md) | The single list of open work, with evidence and a next action per row. | Current |
| [docs/next-steps.md](docs/next-steps.md) | Dated narrative of what was built and the record of decisions. | History |
| [docs/project-story.md](docs/project-story.md) | How the twelve repositories came to be, and how they depend on each other. | History |
| [docs/demo-script.md](docs/demo-script.md) | A ten-minute walk through the app on the mock backend. | Current |
| [docs/journeys.md](docs/journeys.md) | How the journey scripts that walk the demo moments are run. | Current |
| [docs/release-order.md](docs/release-order.md) | Which repository to release first when a shared library changes. | Current |
| [docs/repo-consolidation.md](docs/repo-consolidation.md) | Measurements and a recommendation on merging repositories. | History |
| [docs/spend-map.md](docs/spend-map.md) | What costs money, what reaches the spend ledger, what the backend can carry. | History |
| [docs/fail-open-audit.md](docs/fail-open-audit.md) | Audit of defaults that decide security when nothing is set, across twelve repositories. | History |
| [docs/interviews-tenant-plan.md](docs/interviews-tenant-plan.md) | Design and decision record for the Candidates tenant. | Design record; the tenant is built |
| [docs/audits/candidates-gap-audit-2026-11-20.md](docs/audits/candidates-gap-audit-2026-11-20.md) | Product gap audit of the Candidates tenant. | History |
| [docs/meeting-assistant-design.md](docs/meeting-assistant-design.md) | Design and plan for the meeting assistant (Milo) in calls. | Design record; built |
| [docs/meeting-assistant-audit.md](docs/meeting-assistant-audit.md) | Audits of the meeting assistant and the repairs that followed. | History |
| [docs/meeting-consent-design.md](docs/meeting-consent-design.md) | Design for proposals Milo notices and the consent they need. | Design only |
| [docs/milo-rebuild/REBUILD-PLAN.md](docs/milo-rebuild/REBUILD-PLAN.md) | The plan for rebuilding Milo's turn-taking, with its [review](docs/milo-rebuild/REBUILD-REVIEW.md), [probe](docs/milo-rebuild/REBUILD-PROBE.md), [model bake-off](docs/milo-rebuild/DECIDE-BAKEOFF.md) and [voice research](docs/milo-rebuild/VOICE-ASSISTANT-RESEARCH.md). | Plan and supporting research |
| [docs/milo-rebuild/AUDIT-2026-11-19.md](docs/milo-rebuild/AUDIT-2026-11-19.md) | Audit of two days of work on Candidates, Milo and the voice gate. | History |
| [docs/milo-rebuild/CODING-FILM-RESTART.md](docs/milo-rebuild/CODING-FILM-RESTART.md) | Why the coding interview film was redone; it supersedes the acceptance in the Film 5 report. | History |
| [docs/milo-rebuild/FILM-7-CODING-REPORT.md](docs/milo-rebuild/FILM-7-CODING-REPORT.md) | Report on the coding interview film. The other `FILM-*` reports in that folder are earlier takes. | History |
| [docs/voice-navigator-spec.md](docs/voice-navigator-spec.md) | Design of the voice navigator. | Design record; built |
| [docs/voice-navigator-gaps.md](docs/voice-navigator-gaps.md) | What was missing from the navigator on 8 November; section 4 now reads as a plan but is built. | History |
| [docs/voice-tool-inventory.md](docs/voice-tool-inventory.md) | What the application can do and the tool catalogue that covers it (also `docs/voice-tool-inventory.json`). | Generated; recapture when routes change |
| [docs/voice/page-ids.md](docs/voice/page-ids.md) | The stable page ids the voice `open` tool uses, per tenant. | Current |
| [docs/voice/replay.md](docs/voice/replay.md) | How recorded voice sessions are replayed in tests. | Current |
| [docs/learning-loop-design.md](docs/learning-loop-design.md) | How a finished run writes what it learned into a runbook; decisions are in [docs/learning-loop-decisions.md](docs/learning-loop-decisions.md), handoff in [docs/learning-loop-handoff.md](docs/learning-loop-handoff.md). | Design record; built |
| [docs/value-sweep-2026-11-11.md](docs/value-sweep-2026-11-11.md) | A sweep of the Work tenant for features one step from done. | History |
| [docs/create-initiative-design.md](docs/create-initiative-design.md) | Creating an initiative by hand. | Design record; built |
| [docs/microvm-runner-design.md](docs/microvm-runner-design.md) | Design for the runner that does one work item per session; section 16 is out of date. | Design record |
| [docs/deck-builder-plan.md](docs/deck-builder-plan.md) | Plan for building presentations in the product. | Plan; nothing built |
| [docs/ui-components-queue.md](docs/ui-components-queue.md) | Gaps found in the component library, each with the workaround used here. | Current |
| [docs/ux-audit-ai-3d-storymaker-2026-11-08.md](docs/ux-audit-ai-3d-storymaker-2026-11-08.md) | Copy of a UX audit of the Studio project. | History |
| [docs/design/README.md](docs/design/README.md) | The design reference sheet and mock-up prompts. | Current |
| [scripts/README.md](scripts/README.md) | What each script and validator is and whether it still works. | Current |

For more context, see the [project story](docs/project-story.md) and [next steps](docs/next-steps.md).
