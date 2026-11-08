# Release order across the repositories

Written 8 November 2026 from the pins in each `package.json`. A change at the bottom of the stack ripples upward through the consumers listed under it; nothing below a repository depends on it, so start at the lowest changed layer and work up. Every repository is under `github.com/connorhoehn`, every library is pinned by exact commit or tarball, and the rule is one release per library change: batch what you can, release once, then bump every consumer in the same pass.

## The layers

| layer | repository | package | consumed through | consumed by |
|---|---|---|---|---|
| 0 | distributed-core | `distributed-core` | `github:connorhoehn/distributed-core#<sha>` | service-runtime, pipeline-runtime, message-queue, managed-nosql-store, event-catalog, realtime-modules, live-video-streaming, platform-api, realtime-examples, aws-agentcore (middleware) |
| 1 | service-runtime | `@connorhoehn/service-runtime` | `github:…#<sha>` | message-queue, event-catalog, realtime-modules, platform-api, realtime-examples, aws-agentcore (middleware) |
| 1 | pipeline-runtime | `@connorhoehn/pipeline-runtime` | `github:…#<sha>` | platform-api |
| 1 | managed-nosql-store | `managed-nosql-store` | Docker image (commit pin in `scripts/docker/document-workspace-sources.json`) | aws-agentcore compose, platform-api runtime |
| 2 | message-queue | `@connorhoehn/message-queue` | `github:…#<sha>`; tarball in `aws-agentcore/middleware/vendor` | event-catalog, platform-api, aws-agentcore (middleware) |
| 3 | event-catalog | `@connorhoehn/event-catalog` | `github:…#<sha>` | realtime-modules, live-video-streaming, platform-api, realtime-examples |
| 4 | realtime-modules | `@connorhoehn/realtime-modules` | `npm pack` tarball in `aws-agentcore/portal/vendor` (the middleware reaches into it) and `realtime-examples/frontend/vendor` + `src/vendor`; `github:` from platform-api | ui-components (peer), platform-api, realtime-examples, aws-agentcore (portal and middleware) |
| 5 | ui-components | `@connorhoehn/ui-components` | tarball in `aws-agentcore/portal/vendor`, `realtime-examples/frontend/vendor`, `event-catalog/src/admin/vendor` | aws-agentcore portal, realtime-examples frontend, event-catalog admin |
| 6 | live-video-streaming | `mediasoup-streaming-cluster` | Docker image; `lvs-client`/`lvs-react` via `file:../` from realtime-examples | realtime-examples, aws-agentcore compose (`social-sfu`) |
| 6 | platform-api | `@connorhoehn/platform-api` | Docker image (commit pin in `document-workspace-sources.json`) | aws-agentcore compose (`social-platform-api`) |
| 6 | realtime-examples | `realtime-examples` (+ `realtime-examples-cdk` tarball) | Docker image; cdk tarball in `aws-agentcore/infra` | aws-agentcore compose (`social-gateway`), infra |
| 7 | aws-agentcore | portal, middleware, infra, agents, schema | the application | nobody |

## How a release is done

1. Bump the version, write the CHANGELOG line, run the suite, commit on `main`, push. Libraries that ship `dist/` (distributed-core, service-runtime, realtime-modules, ui-components) track it in git even though `.gitignore` lists it: rebuild, and `git add -f` any new `dist/` file, or the pinned commit ships a package that cannot import (0.7.3 and 0.51.0/0.51.1 both did this).
2. For `github:` consumers, put the full 40-character commit sha in the consumer's `package.json`, run `npm install` once, and check `node_modules/<pkg>/package.json` says the version you released and `dist/` carries the change.
3. For tarball consumers, `npm pack` in the library, copy the tarball into the consumer's `vendor/`, delete the previous tarball, point `package.json` at the new file, `npm install`, then `rm -rf node_modules/.vite` and restart the Vite dev server, or exports go missing.
4. For image consumers (platform-api, managed-nosql-store, live-video-streaming, realtime-examples into aws-agentcore), update the commit pin in `scripts/docker/document-workspace-sources.json` or the compose build context and rebuild.
5. Walk up: a distributed-core change touches ten repositories; a ui-components change touches three. Release each layer once and bump the layer above in one commit per consumer.

## What CI checks

Every repository runs typecheck and tests on push (`.github/workflows/ci.yml`). `github:` installs need the `GH_PACKAGES_TOKEN` secret and checkout with `persist-credentials: false`; the middleware suite runs as three jest shards.
