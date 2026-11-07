# Repository consolidation: measurements and recommendation

Written 7 November 2026 from the twelve local checkouts under `~/Projects`. Window for every "90d" number: commits since 2026-08-08. Every number comes from a command in the appendix (cited as `[C#]`). Caveats: the local `ui-components` checkout is 48 commits behind `origin/main` (2.500.3 local, 2.507.0 remote) and has 139 dirty files; `aws-agentcore` is 5 ahead, `platform-api` 1 ahead; the `slalom`/`origin2` duplicate remotes were not fetched `[C12]`. All author emails are one person on different machines, so "authors" below means machine identities, not people `[C1]`.

The short version: the 24-hour co-commit join is saturated (one operator and agents touch nearly everything on the same days), so it does not separate the pairs. What does separate them is how often consumers had to re-pin a library and how far every pin lags today. Those numbers say: fold `service-runtime + message-queue + event-catalog` into one package, fold `pipeline-runtime` into `distributed-core`, move the React half of `realtime-modules` into `ui-components`, and replace all three pin mechanisms with tagged releases on the registry that is already half wired up. Twelve repositories become nine.

## 1. The repositories `[C1] [C2] [C3] [C4]`

| Repo | Package (local version) | GitHub owner | Commits 90d | Active days | Authors 90d/all | LOC | LOC excl. tests | Test files | Consumed via | Version bumps / tags 90d | CI |
|---|---|---|---|---|---|---|---|---|---|---|---|
| aws-agentcore | none (portal, middleware, infra) | connorhoehnslalom | 1,259 | 56 | 4/6 | 510,071 | 337,181 | 1,082 | app | 0 / 0 | none |
| ui-components | `@connorhoehnslalom/ui-components` 2.500.3 (origin 2.507.0) | connorhoehnslalom | 1,305 | 57 | 4/6 | 470,848 | 304,861 | 1,059 | `file:` tarball x3 sites, `file:../` x1; publishConfig GH Packages | 764 / 14 | `publish.yml` on `v*` tags |
| realtime-modules | `@connorhoehn/realtime-modules` 0.145.0 | connorhoehn (+slalom) | 355 | 55 | 3/4 | 128,402 | 77,286 | 225 | `file:` tarball x2, `github:` x4, `file:../` x2; publishConfig | 220 / 90 | none |
| service-runtime | `@connorhoehn/service-runtime` 0.6.1 | connorhoehn | 13 | 10 | 1/3 | 6,545 | 2,475 | 20 | `github:` x7 sites, 5 distinct SHAs | 9 / 12 | none |
| pipeline-runtime | `@connorhoehn/pipeline-runtime` 1.5.0 | connorhoehn | 25 | 9 | 1/3 | 4,879 | 3,028 | 9 | `github:` x1 (platform-api) | 16 / 16 | none |
| distributed-core | `distributed-core` 0.50.1 (unscoped) | connorhoehn (+origin2) | 62 | 21 | 1/5 | 331,009 | 110,108 | 669 | `github:` x12 sites, 6 distinct SHAs | 26 / 28 | `ci.yml` (manual dispatch only) |
| message-queue | `@connorhoehnslalom/message-queue` 0.6.1 | connorhoehnslalom | 40 | 16 | 1/4 | 60,921 | 22,186 | 153 | `file:` tarball 0.4.0 (aac), `github:` x1 (ec) | 11 / 12 | none |
| event-catalog | `@connorhoehn/event-catalog` 0.10.0 | connorhoehnslalom | 60 | 19 | 1/4 | 103,465 | 45,231 | 189 | `github:` x5 sites, 4 distinct SHAs; publishConfig | 23 / 10 | none |
| platform-api | `@connorhoehn/platform-api` 0.1.0 | connorhoehnslalom | 543 | 48 | 2/4 | 215,575 | 108,523 | 463 | Docker image (commit pin in `scripts/docker/document-workspace-sources.json`) | 0 / 1 | none |
| managed-nosql-store | `managed-nosql-store` 0.12.0 (unscoped) | connorhoehn (+slalom) | 7 | 5 | 1/4 | 93,543 | 34,298 | 153 | Docker image (commit pin); no package consumer | 0 / 0 | none |
| live-video-streaming | `mediasoup-streaming-cluster` 1.0.0 | connorhoehn | 102 | 28 | 2/6 | 179,051 | 77,259 | 315 | Docker image; `lvs-client`/`lvs-react` via `file:../` from realtime-examples | 0 / 0 | `ci.yml.disabled` |
| realtime-examples | `realtime-examples` 0.1.0 (+ `realtime-examples-cdk` 0.1.0 tarball) | connorhoehn | 1,964 | 44 | 3/7 | 374,630 | 183,733 | 933 | `file:` tarball (aac infra), Docker image | 0 / 0 | `ci.yml` (manual dispatch only) |

LOC is the exact filter asked for (`git ls-files`, `.ts .tsx .js .py`, excluding `dist/` and `node_modules/`); the "excl. tests" column also drops `*.test.*`, `__tests__`, `test(s)`, `e2e`, `examples`, `fixtures` `[C3]`. The largest single files are hand-written, not generated (`RichChatComposer.tsx` 3,496 lines, `middleware/src/mock/assessment.ts` 5,117, `realtime-examples/src/server.ts` 5,553) `[C3]`.

## 2. Coupling on the 34 tree edges `[C5] [C6] [C7]`

"24h" = share of the consumer's commits that have a dependency commit within plus or minus 24 hours, and the reverse. "Bumps" = commits in the consumer that changed the dependency's spec in a `package.json`. "Lag" = commits between the pinned ref and the library's local HEAD today.

| Edge (consumer → dependency) | Consumer 24h | Dependency 24h | Shared days | Bumps 90d | Pin lag today |
|---|---|---|---|---|---|
| service-runtime → distributed-core | 10/13 (77%) | 26/62 (42%) | 6 | 5 | 1 (2026-11-04) |
| pipeline-runtime → distributed-core | 25/25 (100%) | 39/62 (63%) | 8 | 12 | 1 (11-04) |
| managed-nosql-store → distributed-core | 7/7 (100%) | 21/62 (34%) | 5 | 3 | 44 (08-18) |
| message-queue → service-runtime | 32/40 (80%) | 12/13 (92%) | 9 | 8 | 1 (11-04) |
| message-queue → distributed-core | 16/40 (40%) | 35/62 (56%) | 8 | 6 | 1 (11-04) |
| event-catalog → service-runtime | 31/60 (52%) | 12/13 (92%) | 9 | 2 | 5 (10-14) |
| event-catalog → message-queue | 48/60 (80%) | 37/40 (92%) | 11 | 2 | 9 (10-26) |
| event-catalog → distributed-core | 46/60 (77%) | 44/62 (71%) | 11 | 4 | 4 (10-14) |
| realtime-modules → service-runtime | 65/355 (18%) | 13/13 (100%) | 9 | 2 | 3 (10-26) |
| realtime-modules → event-catalog | 194/355 (55%) | 60/60 (100%) | 19 | 5 | 15 (10-16) |
| realtime-modules → distributed-core | 184/355 (52%) | 62/62 (100%) | 21 | 13 | 1 (11-04) |
| ui-components → realtime-modules | 1,252/1,305 (96%) | 350/355 (99%) | 49 | 2 | `file:../realtime-modules` live checkout, peer `>=0.17.0 <1` |
| live-video-streaming → event-catalog | 46/102 (45%) | 39/60 (65%) | 9 | 0 | 60 (2026-06-13) |
| live-video-streaming → distributed-core | 74/102 (73%) | 50/62 (81%) | 11 | 4 | 3 (10-14) |
| platform-api → realtime-modules | 536/543 (99%) | 299/355 (84%) | 43 | 13 | 7 (10-26) |
| platform-api → service-runtime | 56/543 (10%) | 12/13 (92%) | 9 | 5 | 3 (10-26) |
| platform-api → event-catalog | 351/543 (65%) | 58/60 (97%) | 18 | 6 | 10 (10-26) |
| platform-api → pipeline-runtime | 50/543 (9%) | 25/25 (100%) | 9 | 10 | 2 (11-04) |
| platform-api → distributed-core | 371/543 (68%) | 61/62 (98%) | 20 | 18 | 1 (11-04) |
| aws-agentcore → ui-components | 1,186/1,259 (94%) | 1,162/1,305 (89%) | 43 | 116 | tarball 2.500.3-work.2 vs origin 2.507.0 |
| aws-agentcore → realtime-modules | 1,139/1,259 (90%) | 305/355 (86%) | 40 | 32 | tarballs 0.142.0 (portal) and 0.141.0 (middleware) vs 0.145.0 |
| aws-agentcore → service-runtime | 287/1,259 (23%) | 11/13 (85%) | 8 | 4 | 4 (10-25) |
| aws-agentcore → message-queue | 550/1,259 (44%) | 39/40 (98%) | 13 | 2 | tarball 0.4.0 vs 0.6.1 |
| aws-agentcore → distributed-core | 628/1,259 (50%) | 52/62 (84%) | 17 | 6 | 4 (10-14) |
| aws-agentcore → realtime-examples | 983/1,259 (78%) | 1,876/1,964 (96%) | 34 | 1 | CDK tarball (1 import line); Docker pins 1,136 and 54 behind |
| aws-agentcore → platform-api | 1,074/1,259 (85%) | 534/543 (98%) | 40 | 0 (Docker) | Docker pins 343 and 17 behind |
| aws-agentcore → live-video-streaming | 641/1,259 (51%) | 93/102 (91%) | 20 | 0 (Docker) | Docker pin 1 behind |
| aws-agentcore → managed-nosql-store | 89/1,259 (7%) | 6/7 (86%) | 3 | 0 (Docker) | Docker pin 1 behind |
| realtime-examples → realtime-modules | 1,964/1,964 (100%) | 281/355 (79%) | 41 | 162 | 91 (09-30) |
| realtime-examples → service-runtime | 97/1,964 (5%) | 12/13 (92%) | 8 | 5 | 6 (09-20) |
| realtime-examples → event-catalog | 1,036/1,964 (53%) | 58/60 (97%) | 17 | 12 | 18 (09-25) |
| realtime-examples → distributed-core | 1,059/1,964 (54%) | 62/62 (100%) | 20 | 10 | 15 (09-08); `cell-router` 63 (06-13) |
| realtime-examples → ui-components | 1,961/1,964 (100%) | 1,080/1,305 (83%) | 39 | 361 | tarball 2.506.0 vs origin 2.507.0 |
| realtime-examples → live-video-streaming | 784/1,964 (40%) | 91/102 (89%) | 19 | 0 | `file:../` live checkout |

Why the 24h column is not the argument: pairs with no edge score the same. `ui-components ~ platform-api` is 89%/99% on 42 shared days, `platform-api ~ realtime-examples` 98%/100% on 39, `message-queue ~ platform-api` 100%/50% `[C5]`. The join measures one operator's calendar. The bump and lag columns measure the cost of the split: in 90 days the two apps made 148 (aws-agentcore) and 550 (realtime-examples) hand bumps of sibling libraries `[C6]`, and today no library is on the same ref in any two consumers (`distributed-core` is pinned at 6 different SHAs, `service-runtime` at 5, `event-catalog` at 4, `realtime-modules` at 4) `[C2] [C7]`.

Edges the tree omits `[C2]`: `event-catalog/src/admin` → ui-components (tarball 2.505.0, 20 import lines); `live-video-streaming/ui` → realtime-modules and ui-components (`file:../`); `message-queue/src/admin` is a standalone React 18 app with no sibling dependency.

## 3. Three pin mechanisms today `[C2] [C7] [C8]`

| Mechanism | Sites | Where | Lag range |
|---|---|---|---|
| `github:owner/repo#sha` | 31 | every library-to-library edge, realtime-examples, aws-agentcore middleware | 1 to 91 commits; 6+5+4+4 distinct SHAs for the four shared libraries |
| `file:vendor/*.tgz` (checked in) | 6 (7 tarballs tracked) | aws-agentcore portal x2, middleware x2, infra x1; event-catalog admin x1; realtime-examples frontend x1 | realtime-modules 3 to 4 versions, message-queue 0.4.0 vs 0.6.1 |
| `file:../sibling` live checkout | 7 | ui-components dev, realtime-modules demo, lvs/ui x2, realtime-examples frontend x2 (lvs libs), lvs-react | whatever is on disk |
| commit pins in `document-workspace-sources.json` | 9 | aws-agentcore Docker builds of 7 siblings | 1 to 1,136 commits; ui-components 550, platform-api 343 |
| registry (`npm.pkg.github.com`) | 0 consumers | `publishConfig` on ui-components, realtime-modules, event-catalog; `publish.yml` only in ui-components; `.npmrc` only in ui-components | last tag `v2.371.1` on 2026-09-23, 543 commits and 136 versions ago; nothing current is published |

Tracked `dist/` (distributed-core 2,069 files, realtime-modules 1,216, event-catalog 628, ui-components 339, service-runtime 96) exists only so `github:` installs do not build `[C8]`. Release mechanics are a large share of library history: 764 of 1,305 ui-components commits (59%) and 220 of 355 realtime-modules commits (62%) bump the package version; 175 and 41 of them touch nothing but `package.json`, `dist/` and the changelog `[C4] [C9]`.

## 4. Recommendation

| Group | Verdict | The numbers |
|---|---|---|
| service-runtime + message-queue + event-catalog → `@connorhoehnslalom/platform-core` | Merge | 113 commits in 90d, one author, 70k LOC excl. tests. The chain is three hops (sr → mq → ec → rm, platform-api, realtime-examples, lvs); 14 pin sites with 11 distinct refs collapse to one. message-queue spent 14 of 40 commits (35%) re-pinning sr and dc; event-catalog 10 of 60. mq~ec co-commit 92%/80% on 11 of their 16/19 active days. message-queue is a layer over `distributed-core/messaging-queue` (34 import lines; dc's `src/messaging` is 12,227 LOC) `[C10]`; event-catalog uses `message-queue/client` in 3 lines. service-runtime is 2,475 LOC that security item 13 rewrites anyway; doing it inside one package avoids re-pinning six consumers (67 external import lines) `[C11]`. The new name under the `connorhoehnslalom` org also fixes the scope/owner mismatch that stops `@connorhoehn/event-catalog` publishing to GitHub Packages from a `connorhoehnslalom` repo `[C12]`. Admin UIs (mq 4,449 LOC, ec 12,455 LOC) stay as unpublished workspaces. |
| pipeline-runtime → `distributed-core/pipeline-runtime` | Merge | 3,028 LOC, 25 commits, 12 of them (48%) are `distributed-core` pin bumps and 7 (28%) are release-only `[C6] [C9]`. One consumer: platform-api, which imports `distributed-core/applications/pipeline` in 150 lines and pipeline-runtime in 18 `[C10]`. dc already owns 18,594 LOC of pipeline code (`PipelineExecutor.ts` 3,935 lines) that pipeline-runtime wraps. Not platform-api, because the bots direction (next-steps section 5.3) needs the runner outside the service, and security items 12 (webhook SSRF in dc's executor) and 14 (approve before persist) then land in one repo. |
| realtime-modules React client → ui-components | Move the client, do not merge the repos | `src/client` + `src/adapters` are 36,165 of realtime-modules' 75,831 src LOC (48%); all 74 React-importing files are there `[C10]`. ui-components already imports realtime-modules from 27 files over 8 subpaths and carries 16,023 LOC of `integrations/`. The apps bypass that layer: portal 61 direct `realtime-modules/client*` import lines vs 21 via `ui-components/integrations`; realtime-examples 116 vs 12 `[C11]`. ui-components~realtime-modules is the most coupled pair (96%/99%, 49 shared days) yet ui-components bumped it twice in 90 days because it builds against `file:../realtime-modules`: it already behaves as one codebase. Consumers chase two release trains (764 + 220 versions; aws-agentcore took 116 + 32, realtime-examples 361 + 162). Direction matters: the reverse leaves 8 ui-components files outside `integrations/` still importing realtime-modules and puts server code under a UI package. After the move realtime-modules is server and protocol only (`server` 8,927, `call` 6,664, `work-graph` 3,896, `chat` 3,364 LOC) with no React peer; the middleware's 200+ server-subpath imports are untouched. Cost: 34 cross-directory imports inside `src/client` re-pointed at public subpaths, 3 server files that import client code untangled, 177 app import lines rewritten by sed `[C11]`. This changes the rule in next-steps section 6: hooks live in `ui-components/realtime`, the wire protocol in realtime-modules. |
| distributed-core | Stay (the leaf) | 12 pin sites across 10 repos, 110k LOC excl. tests, 669 test files, 62 commits in 90d; one bump clears a transitive high in six repos (next-steps 7.11). One change: scope it as `@connorhoehn/distributed-core` so a registry can hold it; 578 `from 'distributed-core'` lines in 428 files across 8 repos plus 21 `require` lines in LVS `[C11]`. |
| live-video-streaming | Stay (different runtime) | CommonJS and mediasoup, no TypeScript build, Kubernetes manifests; 179k LOC, 315 test files; consumed as an image plus two 11,916-LOC client libs. It does use dc (21 requires) and event-catalog (5), so its edges are real `[C11]`, and tier-1 security items 2 to 4 are all here. |
| ui-components | Stay (the UI rule) | 1,305 commits, 1,059 test files, four consumers (portal, realtime-examples frontend, event-catalog admin, lvs/ui). It grows by the hooks above. |
| platform-api, managed-nosql-store, realtime-examples, aws-agentcore | Stay (services and apps, consumed as images) | managed-nosql-store has 7 commits in 90d and no package consumer; nothing to merge, nothing to gain. Cut the one library edge aws-agentcore → realtime-examples: a 12 KB CDK tarball, one import line (`ApplicationTables, DocumentWorkspaceServices, RedisService`), bumped once in 90 days; move those constructs into `aws-agentcore/infra/lib` `[C2] [C13]`. |

Result: 12 repositories become 9; the shared-library count goes from 7 to 4 (distributed-core, platform-core, realtime-modules, ui-components).

## 5. What replaces the tarballs and `github:` pins

Registry: GitHub Packages at `npm.pkg.github.com`. It is already configured in three `publishConfig`s and one workflow, and it uses the same GitHub auth the repos use. Its constraint is that the package scope must equal the repo owner, which today fails for `@connorhoehn/event-catalog` and `@connorhoehn/platform-api` (both under `connorhoehnslalom`) and for the two unscoped packages `[C12]`; the platform-core merge and the dc rename remove all four. If keeping two GitHub owners stays painful, AWS CodeArtifact takes any scope in one domain and the steps are identical except the `.npmrc`.

| Step | Exact change | Verified by |
|---|---|---|
| 1. Scope and publish in every library (dc, platform-core, rm, uic) | `npm pkg set name=@connorhoehn/distributed-core publishConfig.registry=https://npm.pkg.github.com`; copy `ui-components/.github/workflows/publish.yml` (trigger `tags: ['v*']`, `permissions: packages: write`, steps `npm ci`, `npm run build`, `npm test`, `npm publish`); `git rm -r --cached dist && echo dist/ >> .gitignore`; keep the `files` whitelist (7 libraries already have one) `[C8]` | `npm pack --dry-run` lists only `dist/`, README, LICENSE |
| 2. One release per library change | `npm version minor -m "release %s" && git push --follow-tags`; the tag runs the workflow; a changelog line per release. No `npm pack`, no copy into a vendor folder | `npm view <pkg> version` equals the new tag |
| 3. Consumers pin exact versions | `.npmrc` in portal, middleware, infra, platform-api, realtime-examples root and frontend, lvs, lvs/ui, platform-core admin: `@connorhoehn:registry=https://npm.pkg.github.com`, `@connorhoehnslalom:registry=https://npm.pkg.github.com`, `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`; specs become `"@connorhoehn/realtime-modules": "0.146.0"`; `npm install`, commit the lockfile; `git rm` the 7 tracked tarballs and their `vendor/` READMEs | fresh clone, no SSH agent, `NODE_AUTH_TOKEN` only: `npm ci` succeeds in all nine consumer folders |
| 4. Docker builds | `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci` replaces `--ssh default` and the git-archive contexts; `document-workspace-sources.json` keeps only the four service image pins (platform-api, realtime-examples, lvs, managed-nosql-store) and drops the library entries | `docker build --secret id=npmrc,src=$HOME/.npmrc` for middleware and platform-api |
| 5. Guard against regression | a CI step in every consumer: `grep -E '"(file|github):' package.json */package.json && exit 1`; developers use `npm link` locally and never commit it | the step is red on today's files, green after step 3 |
| 6. Later: automate bumps | Renovate (or Dependabot) with a host rule for `npm.pkg.github.com`, grouped per library, so the 148 and 550 hand bumps of the last 90 days become reviewed PRs | a bump PR opens within a day of a tag |

## 6. Migration, bottom of the tree first

Each step is one release at the library and a re-pin at its consumers; the previous step's package must be on the registry before the next begins.

| # | Repo(s) | Work | What breaks until the consumers re-pin | Verified by |
|---|---|---|---|---|
| 0 | all 12 | tag `pre-consolidation-2026-11` on every HEAD; pull ui-components (48 behind), resolve its 139 dirty files; drop the `slalom`/`origin2` duplicate remotes | nothing | `git status` clean in 12 repos `[C12]` |
| 1 | distributed-core | rename to `@connorhoehn/distributed-core`, publish workflow, untrack `dist/`, release 0.51.0 | all 12 `github:` dc pin sites and 21 LVS `require` lines until re-pointed | `ci.yml` jobs (lint, build, test 669 files, test-integration) run by dispatch; `npm view @connorhoehn/distributed-core version` |
| 2 | pipeline-runtime → distributed-core | `git subtree add --prefix src/applications/pipeline/runtime` from pipeline-runtime; export `./pipeline-runtime`; fix security item 14 here; release dc 0.52.0; delete the pipeline-runtime repo after step 6 | platform-api (18 import lines) | pipeline-runtime's 9 test files pass under dc's jest; platform-api `npm run typecheck` |
| 3 | service-runtime + message-queue + event-catalog → platform-core | new repo under `connorhoehnslalom` from message-queue's history with sr and ec as subtrees; subpaths `/service-auth`, `/queue`, `/queue/client`, `/catalog`, `/catalog/client-frames`, `/catalog/pipeline`; admin UIs as workspaces; release 1.0.0; delete the three repos after step 9 | realtime-modules (2 sr + 14 ec lines), platform-api (28 + 18), realtime-examples (21 + 5), aws-agentcore middleware (16 sr lines + the 0.4.0 tarball), lvs (5 ec requires) `[C11]` | 20 + 153 + 189 test files in one `npm test`; `helm template` of the queue chart renders with auth on (security item 10) |
| 4 | realtime-modules | re-pin dc and platform-core from the registry; move `src/client` and `src/adapters` out; drop the `react` peer; release 0.146.0 | ui-components (27 files), portal (61 lines), realtime-examples frontend (116), lvs/ui, `demo/` | `npm run verify:exports`, `check:contract`, `typecheck`, 225 test files `[C8]` |
| 5 | ui-components | add `src/realtime` from the moved client, fold `integrations/realtime` and `integrations/realtime-modules` (16,023 LOC) into it; pin rm 0.146.0 from the registry; tag `v2.508.0`, the first tag since `v2.371.1` | portal (21 `integrations` lines), realtime-examples (12; its `@connorhoehn/ui-components` alias becomes `npm:@connorhoehnslalom/ui-components@2.508.0`), event-catalog admin, lvs/ui | 1,059 test files incl. `export-surface.snapshot`; `npm run build`; `publish.yml` green |
| 6 | platform-api | re-pin dc, platform-core, rm; drop pipeline-runtime; rename 252 dc import lines | its Docker image | `typecheck`, 463 test files, `docker build` |
| 7 | live-video-streaming | re-pin dc (21 requires) and platform-core catalog (5); lvs/ui to registry pins | its Kubernetes image | 315 test files; `docker build` |
| 8 | aws-agentcore | `.npmrc` and registry pins in portal, middleware, infra; delete three `vendor/` folders (5 tracked tarballs); one realtime-modules version for portal and middleware (today 0.142.0 vs 0.141.0); move the three CDK constructs from `realtime-examples-cdk` into `infra/lib`; `document-workspace-sources.json` keeps four service pins | middleware moves from rm 0.141.0 to 0.146.0 (it needs 0.140+ for the gateway race fix, next-steps section 3) | portal `typecheck`, `test`, `audit:ui`; middleware jest run alone; infra `test`; `npm ci` with no SSH agent |
| 9 | realtime-examples | root, `src/`, `frontend/`, `cell-router/` pins to the registry (rm is 91 commits behind, `cell-router` dc 63 behind) | nothing new; the 2.506.0 tarball's source commit `325ec77d` is on ui-components main `[C13]` | frontend `typecheck` and `lint` (its `ci.yml`), `check:types-sync`, `docker build` |
| 10 | all | delete pipeline-runtime, service-runtime, message-queue, event-catalog; one remote and one owner per package | none | 9 repos; every `git remote -v` shows one remote; the step-5 grep guard is green in every consumer |

## Appendix: commands

Run from `/Users/connorhoehn/Projects`; `$R` is a repo name, `$LIB` a library, `$SHA` a pinned ref.

- `[C1]` per repo: `git -C $R log --since=2026-08-08 --format=%ct > ts/$R.ts; wc -l ts/$R.ts` (commits 90d); `git -C $R log --since=2026-08-08 --format=%ae | sort -u | wc -l` and the same without `--since` (authors); `git -C $R rev-list --count HEAD`; `git -C $R log --format=%ae | sort | uniq -c` (all identities are the same person).
- `[C2]` pins: Python over every tracked `package.json` (excluding `node_modules`, `dist/`, `examples/`, `demo/`) collecting `dependencies`, `devDependencies`, `peerDependencies` whose key is a sibling package; owner from `git -C $R remote get-url origin`; `name`/`version`/`publishConfig` from the root `package.json`.
- `[C3]` LOC: `git -C $R ls-files | grep -E '\.(ts|tsx|js|py)$' | grep -vE '(^|/)(dist|node_modules)/' | (cd $R && tr '\n' '\0' | xargs -0 cat) | wc -l`; "excl. tests" adds `grep -vE '(^|/)(__tests__|test|tests|e2e|examples|fixtures|__fixtures__|__mocks__)/' | grep -vE '\.(test|spec)\.'`; largest files: same list into `xargs -0 wc -l | sort -rn | head -4`; test files: `git ls-files | grep -E '\.(test|spec)\.(ts|tsx|js|mjs|cjs|py)$' | wc -l`.
- `[C4]` releases: `git -C $R log --since=2026-08-08 -p -- package.json | grep -cE '^\+\s*"version"\s*:'` (version bumps); `git -C $R for-each-ref --format='%(creatordate:short) %(refname:short)' refs/tags | awk '$1>="2026-08-08"' | wc -l` (tags); `ls $R/.github/workflows`.
- `[C5]` co-commit join: Python over the `ts/*.ts` files from `[C1]`; for each ordered pair, count timestamps in A with a timestamp in B within 86,400 s (bisect), and the size of the intersection of UTC commit dates; run for all 66 pairs, edges marked from the Mermaid tree in `project-story.md`.
- `[C6]` bumps: `git -C $R log --since=2026-08-08 --format='COMMIT %H %cs' -p -- <package.json files>` with the consumer's files (aws-agentcore: `portal/ middleware/ infra/`; realtime-examples: root, `src/`, `frontend/`, `cell-router/`; event-catalog: root and `src/admin/`; lvs: root, `ui/`, `packages/lvs-react/`), then count commits containing a line matching `^\+\s*"(@connorhoehn(slalom)?/[a-z-]+|distributed-core)"\s*:\s*"([^"]+)"` per dependency, with the set of distinct specs. (A first pass using `@@` as the commit marker collided with hunk headers and was discarded.)
- `[C7]` pin lag: for each pinned `$SHA`: `git -C $LIB rev-list --count $SHA..HEAD`, `git -C $LIB merge-base --is-ancestor $SHA HEAD`, `git -C $LIB log -1 --format=%cs $SHA`; tarball lag from the version in the `file:` name vs `package.json` version at HEAD; Docker pins from `aws-agentcore/scripts/docker/document-workspace-sources.json`.
- `[C8]` registry state: `cat ui-components/.github/workflows/publish.yml`; `git -C ui-components describe --tags --abbrev=0 origin/main` and `git rev-list --count v2.371.1..origin/main`; `git -C $LIB ls-files dist | wc -l`; `scripts`, `files`, `prepare` from each `package.json`; `ls $R/.npmrc`.
- `[C9]` release-only commits: `git -C $LIB log --since=2026-08-08 --format='COMMIT %h' --name-only`, counting commits whose files are all in `package.json`, `package-lock.json`, `CHANGELOG*`, `dist/`, `docs/`.
- `[C10]` surfaces: `[C3]` restricted with `git ls-files -- <dir>` for `realtime-modules/src/*`, `ui-components/src/integrations`, `distributed-core/src/applications/pipeline`, `distributed-core/src/messaging`; React files: `git -C realtime-modules grep -lE "from ['\"]react['\"]" -- src | awk -F/ '{print $2}' | sort | uniq -c`; `git -C platform-api grep -hE "from ['\"]distributed-core/applications/pipeline" -- src | wc -l` and the same for `@connorhoehn/pipeline-runtime`.
- `[C11]` import counts: `git -C $R grep -hE "from ['\"]<pkg>(/|['\"])" -- ':!dist' ':!**/dist/**' | wc -l` (and `-l ... | wc -l` for files) for `distributed-core`, `@connorhoehn/service-runtime`, `@connorhoehn/event-catalog`, `@connorhoehn/realtime-modules/client`, `ui-components/integrations`; LVS uses `require\(['\"]...` instead of `from`; cross-directory imports inside `realtime-modules/src/client`: `git grep -hoE "from ['\"]\.\./[a-z-]+" -- src/client | sort | uniq -c`.
- `[C12]` checkout and remotes: `git -C $R rev-list --count origin/main..HEAD` and `HEAD..origin/main`; `git -C $R status --porcelain | wc -l`; `git -C $R remote -v`; `git -C ui-components show origin/main:package.json`.
- `[C13]` edges to cut or confirm: `git -C aws-agentcore grep -nE "realtime-examples-cdk" -- infra/lib infra/bin`; `tar tzf aws-agentcore/infra/vendor/connorhoehn-realtime-examples-cdk-0.1.0.tgz`; `git -C ui-components merge-base --is-ancestor 325ec77d origin/main`; `git -C live-video-streaming grep -lE "require\(['\"](distributed-core|@connorhoehn/event-catalog)" | wc -l`.
