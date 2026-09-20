# Rebuilding the document service images

The local launcher builds every required owning service image. It does not depend
on earlier `:codex-*` images, sibling working-tree changes, host `node_modules`, or
untracked build output.

```sh
node scripts/document-workspace.mjs build-plan
node scripts/document-workspace.mjs build
node scripts/document-workspace.mjs check
```

Prerequisites: Node 20+, Git, tar, Docker with BuildKit, and an SSH agent authorized
to read the private GitHub repositories. The owning Dockerfiles use `--ssh default`
for dependency installation. Runtime signing keys and service credentials are not
build arguments or image inputs.

`scripts/docker/document-workspace-sources.json` pins full Git commits for:

- managed-nosql-store: durable DynamoDB-compatible storage;
- message-queue: queue API and its admin UI;
- event-catalog: schema service and its admin UI;
- ui-components: the catalog admin's existing source dependency;
- platform-api: authoritative document workflows;
- realtime-examples: document gateway and the shared Compose/schema/init files.

The builder reads committed Git objects with `git archive`. A dirty sibling can
provide the object database, but its changed files never enter the build context.
If a sibling or commit is missing, the builder fetches that exact commit into an
isolated bare cache under `.scratch/document-workspace/git-cache`. There is no
checkout, reset, or branch change in sibling repositories.

Each image uses its owner's Dockerfile and committed lockfiles. The catalog gets
a temporary parent context containing both catalog and UI source, preserving its
existing relative `file:` dependency and Vite aliases. Linux dependencies are
installed inside its Docker stages. Platform similarly receives its expected
`platform-api/` parent context. The gateway uses the existing `server-runtime`
target. Shared libraries stay governed by the owning repositories' dependency
locks; this launcher does not copy or reimplement them.

Redis is selected by the recorded repository digest and pulled only when absent.
The six standard image environment overrides remain available (`MNS_IMAGE`,
`MQ_IMAGE`, `CATALOG_IMAGE`, `PLATFORM_API_IMAGE`, `GATEWAY_IMAGE`, `REDIS_IMAGE`).
Overrides are explicit operator choices and are recorded in build provenance.

Defaults use `:document-<source SHA prefix>` tags, so building this release leaves
older `:document-workspace` and `:codex-*` images intact. A build does not start,
replace, or stop containers. Only a subsequent explicit `up` reconciles the
isolated `assessment-document-workspace` project:

```sh
node scripts/document-workspace.mjs up
node scripts/document-workspace.mjs middleware
# Start the portal using its ordinary development command on :5183.
```

Gateway is exposed at `127.0.0.1:18081`, platform API at `127.0.0.1:13002`, and the
BFF session-policy callback at host port 3001. Compose, initialization scripts,
probes and table schemas are materialized from the pinned examples commit, so
Compose no longer reads an unrelated dirty sibling tree. `down` is scoped to the
same project and retains its named data volumes.

## Provenance and deployment

`build-plan` archives and checks inputs without building or running containers.
The build writes `.scratch/document-workspace/build-plan.json` and
`build-report.json`. The latter records each completed local image's ID,
architecture, operating system, repository digests when present, and source commit.
It is updated after each successful image so an interrupted build is visible.
Private local runtime keys remain in `settings.json`; never commit that file.

These are reproducible **source inputs**, not a promise of byte-identical images:
several owning Dockerfiles still use floating upstream Node image tags and install
global tools. Registry availability, upstream image refreshes, and tool releases
can change the resulting image bytes. The report records what was actually built.

A Git source SHA, a local Docker image/config ID, and a registry manifest digest
are different identifiers. The opt-in CDK consumer requires existing ECR repository
names and `sha256:` manifest digests, plus explicit ARM64 or X86_64 architecture.
Publishing these locally tested images to the target registry, resolving their
registry digests, and supplying those digests to CDK is a separate deployment step.
The launcher performs no push or AWS deployment. Do not paste a source SHA or local
image ID into CDK's digest field.

The existing accelerator source adapter remains optional and separately deployed;
see `infra/docs/document-workspace-deployment.md`. Its credentials are injected
only into the BFF. The document image build does not package or claim validation
of an accelerator Python runtime.

## Verified image set

The complete build ran successfully on September 20, 2026 for all five owning
Dockerfiles and the pinned Redis image, producing ARM64 images. The committed
[image provenance](research-evidence/document-workspace-images-2026-09-20.json)
records the exact source revisions and local image IDs, including UI release
`79bdd2bae303d6a4b0bb9a8287d4b7be1eddc3c7` used by catalog. Existing service images
and running containers were left intact during this validation. Earlier live
workflow verification is documented in the middleware workflow bridge notes;
this build does not itself claim a new deployment or restart.

The source-isolation regression also starts with a missing sibling, fetches the
specified commit into a bare cache, and verifies that dirty tracked changes and an
untracked `.env` file never enter the resulting context:

```sh
node --test scripts/docker/tests/document-workspace-build.test.mjs
```
