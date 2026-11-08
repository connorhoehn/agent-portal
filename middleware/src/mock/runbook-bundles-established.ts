// Established procedures as org-wide skills (R8): the walks and releases this
// project repeats every day, written down once with the helpers that make
// their mechanical steps one command. Like the captured tools beside them
// (runbook-bundles.ts) each is self-contained — SKILL.md + scripts/ + data/ —
// and every box gets it; the commands name the consumer repository through
// shell variables, and this project's values live in the bundle's data/ or in
// a labelled paragraph of the notes.
//
//   rb-journey-walk             write an executable journey map, walk it as a
//                               clone, triage the failures, seal the directory
//   rb-ui-components-release    release a packed-tarball library and move every
//                               consumer pin to it, proved against the installed dist
//
// Files: mock/runbook-bundles/<id>/ (packed by scripts/runbooks/pack-bundles.mjs).
// Every Verify command runs offline against the bundled data
// (mock/__tests__/runbook-bundles.test.ts).
import type { RunbookDoc } from '../lib/runbooks/types.js';

export const JOURNEY_WALK_RUNBOOK_ID = 'rb-journey-walk';
export const LIBRARY_RELEASE_RUNBOOK_ID = 'rb-ui-components-release';

const bash = (...lines: string[]) => ({ lang: 'bash' as const, text: lines.join('\n') });

export const journeyWalkDoc: RunbookDoc = {
  title: 'Write a journey map, walk it as a clone and seal its log',
  summary: 'Plan, write, walk, triage and seal executable journey maps in the order that wastes no walk: measure first, iterate on one map, seal a whole directory once.',
  use_when: [
    'A surface or role needs a new or changed journey map and a walked, sealed log',
    'A journey judge reports logs stale, unsealed or unmeasured and you must decide what to measure and re-walk',
    'A walk failed and you need to know whether the page, the map or the stack is at fault',
  ],
  not_for: [
    'Driving the user\'s own Chrome tab (walks run headless, as clones)',
    'One-off screenshots or a recorded demo (use the demo recording procedure)',
  ],
  triggers: {
    work_item_labels: ['journeys', 'audit', 'ui'], repos: [], tools: ['playwright'],
    keywords: ['journey', 'map', 'walk', 'seal', 'measure', 'contract', 'clone', 'stale', 'run-maps', 'audit'],
  },
  preconditions: [
    'The shared stack is up: Vite on :5183 and the middleware in dev:mock on :3001.',
    'Your shell sets `REPO` (the repository root), `FAMILY` (work, access, runbooks, …) and `ROLE` (the log directory you will walk).',
    'No other walk or audit of yours is running as the same persona, and you know the PID of every walk you start.',
  ],
  steps: [
    {
      do: "Open this skill's folder so the bundled helpers and data resolve.",
      command: bash('cd ~/.claude/skills/rb-journey-walk'),
      expect: '`ls` to list `scripts` and `data`.',
    },
    {
      do: 'Plan the walk before opening a browser, so you measure and walk only what is owed.',
      command: bash('node scripts/walk-plan.mjs --repo "$REPO" --family "$FAMILY" --role "$ROLE"'),
      expect: 'a stack line, the logs counted by verdict, and a numbered plan or `nothing owed`.',
      why: 'A log walked before a measurement that moves its contract fails the seal\'s walk proof, so the walk is wasted.',
    },
    {
      do: 'Copy the bundled map template when the surface has no map yet, then write its steps for this role.',
      command: bash('cp data/map-template.ts.txt "$REPO/docs/journeys/maps/$FAMILY/$ROLE/$SURFACE.ts"'),
      expect: 'a map that default-exports one JourneyMap ending in `satisfies JourneyMap`, every step asserting the state it produced.',
    },
    {
      do: 'Check every map in the family without a browser.',
      command: bash('(cd "$REPO" && node scripts/journeys/run-maps.mjs check "$FAMILY")'),
      expect: '`N map(s) valid, 0 problem(s)`.',
    },
    {
      do: 'Walk one map at a time without sealing until it passes.',
      command: bash('(cd "$REPO" && node scripts/journeys/run-maps.mjs walk "$FAMILY" --only "$ROLE/$SURFACE" --no-seal)'),
      expect: 'a check mark before the log path and `1/1 walks passed`; screenshots per step under .scratch/journeys.',
    },
    {
      do: 'Run the triage on a failed walk before you touch the map.',
      command: bash('node scripts/walk-triage.mjs --out "$REPO/.scratch/journeys/$FAMILY" --only "$ROLE/"'),
      expect: 'one PASS or FAIL line per map, the causes most frequent first, shared defects, and which directories are ready to seal.',
      why: 'Most failures are page defects or stack trouble, and loosening the map to pass hides a real defect.',
    },
    {
      do: 'Fix each page defect the walk found in the page, or upstream in the library and then move the pin.',
      expect: 'the same step passes on the next single-map walk.',
    },
    {
      do: 'Measure the rendered contracts once every page fix and pin move for this round has landed.',
      command: bash('(cd "$REPO" && scripts/journeys/measure.sh)'),
      expect: 'three check lines (rail, cascade, type scale) after about fifteen minutes; a cross still records the contract.',
      why: 'The contracts are keyed on the source digest, so measuring before the last page edit means measuring again.',
    },
    {
      do: 'Walk the whole role directory in one run so the runner can seal it.',
      command: bash('(cd "$REPO" && exec node scripts/journeys/run-maps.mjs walk "$FAMILY" --role "$ROLE") &', 'WALK_PID=$!; wait "$WALK_PID"'),
      expect: '`N/N walks passed` and a `seal docs/<family>-journeys/<role>: sealed …` line.',
    },
    {
      do: 'Seal by hand only a directory whose logs a passing walk wrote after the last measurement.',
      command: bash('(cd "$REPO" && scripts/journeys/seal.sh "docs/$FAMILY-journeys/$ROLE")'),
      expect: '`sealed N log(s) under …`; a refusal names the log and the reason and writes nothing.',
    },
    {
      do: 'Regenerate the coverage map and run the family judge before committing.',
      command: bash('(cd "$REPO" && node scripts/journeys/run-maps.mjs coverage && node scripts/journeys/journeys.mjs judge "docs/$FAMILY-journeys" docs/$FAMILY-journeys/$ROLE/*.md | cut -f2 | sort | uniq -c)'),
      expect: 'every walked log counted as `fresh` and a `MEASURED ok` line.',
    },
    {
      do: 'Commit the maps, logs, screenshots, seals and coverage together, staging only your own paths.',
      command: bash('git -C "$REPO" add "docs/journeys/maps/$FAMILY/$ROLE" "docs/$FAMILY-journeys/$ROLE" "docs/$FAMILY-journeys/.contract-sha" docs/journeys/coverage.md'),
      expect: '`git -C "$REPO" diff --cached --stat` lists only this family and role.',
    },
  ],
  verify: [
    {
      check: 'Replay the bundled judge output through the planner and compare the plan.',
      command: bash('node scripts/walk-plan.mjs --tsv data/judge-sample.tsv --family work | diff - data/expected-plan.txt && echo plan-ok'),
    },
    {
      check: 'Triage the bundled walk results and compare the report.',
      command: bash('node scripts/walk-triage.mjs --results data/sample-results.json | diff - data/expected-triage.txt && echo triage-ok'),
    },
  ],
  failure_modes: [
    { symptom: 'The seal refuses: the rendered contracts are not measured on the current source', cause: 'A page edit or pin move landed after the last measurement', response: 'Run measure.sh, rerun the plan, then walk only what it lists' },
    { symptom: 'The seal refuses a log as not written since its contract last changed', cause: 'You measured after walking and a contract part moved', response: 'Walk that directory again; never touch a log or its screenshot to pass the proof' },
    { symptom: '`not sealed — N log(s) in it have no map in this run`', cause: 'The final walk used --only', response: 'Walk the whole directory with --role' },
    { symptom: 'The same audit rule fails on every step of every map (rail.item-label in all 34 access maps)', cause: 'One defect in a shared frame, or the audit contract clashing with a layout burn-down', response: 'Fix it once in the shell or the library, move the pin, then walk everything again' },
    { symptom: 'A tab click fails with `stable: … moved`', cause: 'The page changes header density per tab (the initiative header went from 214 to 96px on Activity)', response: 'Keep one header density for every tab; never drop the stable target' },
    { symptom: 'The log notes a second walk, or the walk fails with `setup failed`', cause: 'Tilt restarted the BFF after a middleware edit and dropped the in-memory clones and scopes', response: 'Leave the middleware alone while walking; the runner retries once' },
    { symptom: '`the action tried to write (blocked)`', cause: 'A read-only map clicked a control that writes', response: 'Run the map under a default scope with writes: true, and read the write back after a reload' },
    { symptom: 'A clone sees empty lists where the persona has records', cause: 'Records keyed by user id belong to the persona, never to its clone', response: 'Prove the gate and the empty state, or set identity persona with a reason (it waits while an audit runs)' },
    { symptom: 'A count asserted as a constant drifts between walks (the Computer Lab fleet)', cause: 'Other walks grow a registry no scope covers', response: 'Assert numbers that agree with expect.numbers instead of a constant' },
    { symptom: 'A record shows an id such as p-004 where a name belongs', cause: 'The mock provider returned the id without resolving the name', response: 'Fix the provider to resolve the name and keep the noText leak list on the step' },
    { symptom: '`identity u-… is in use by run-maps pid N`', cause: 'Another walk holds that persona', response: 'Wait for it to finish; never run two browser processes as one fixture identity' },
  ],
  rollback: [
    { do: 'Stop only the walk you started, by its PID, with the Playwright run it spawned.', command: bash('ps -o pid,command -p "$WALK_PID" && pkill -P "$WALK_PID"; kill "$WALK_PID"') },
    { do: 'Restore the logs and seals a failed or abandoned walk rewrote.', command: bash('git -C "$REPO" checkout -- "docs/$FAMILY-journeys/$ROLE" "docs/$FAMILY-journeys/.contract-sha"') },
    { do: 'Drop a request scope a killed walk left behind, by its id.', command: bash('curl -s 127.0.0.1:3001/api/__mock/scope', 'curl -s -X DELETE "127.0.0.1:3001/api/__mock/scope/$SCOPE_ID"') },
  ],
  notes: [
    'Hard rules: walk only as clones (openAsClone in portal/e2e/realSession.ts mints a clone with the persona\'s grants, its own id and session epoch); never run two browser processes as one fixture identity, because a tenant switch revokes the other cookie; never seal to clear a digest mismatch (measure, walk again, then seal); stop only PIDs you started, never by pattern; never call the shared mock reset, ask for an empty or error world with a scope step instead.',
    '',
    'The order that wastes no walk: plan, write maps, check, walk single maps with --no-seal until they pass, fix pages, then measure once, then walk each whole directory once (the runner seals it). A library pin move changes the source digest too, so release and pin before measuring.',
    '',
    'Map steps: navigate, click, press, fill, back, wait, tab-walk, reload, viewport, theme, scope (a request-scoped mock world: empty, error, long-text, many, loading, or per fixture) and api (a non-GET in a read-only map is a refusal probe and must expect a 4xx). Use stable boxes on every tab click, expect.numbers for counts that must agree, noSettle for a loading skeleton, and walk --video <dir> for a slowed recording that writes no logs. The DOM audit runs at every step; a finding fails it unless a person owns it in docs/journeys/audit-burndown.tsv (run-maps.mjs burndown prints candidates).',
    '',
    'A new family needs its log kinds in PROFILES (scripts/journeys/maps.mjs), its seal rules in FAMILIES (scripts/journeys/journeys.mjs) and a docs/<family>-journeys/PROTOCOL.md before its first map walks. A route the inventory does not hold has no contract: add it to OBSERVED_ROUTES in portal/e2e/route-inventory.ts.',
    '',
    'This project (aws-agentcore): Work personas are member u-theo, sme u-nora, program-owner u-mia, org-leader u-vera (u-release for the release manager) and hr-admin u-rachel; the Work judge is scripts/validate-work-journeys.sh (--quick for the static checks).',
  ].join('\n'),
};

export const libraryReleaseDoc: RunbookDoc = {
  title: 'Release a packed-tarball library and move every consumer pin to it',
  summary: 'Release a library (ui-components and kin) and move each consumer pin onto the packed tarball, then prove the new API against the installed dist, not the source.',
  use_when: [
    'A library change must reach a consumer that installs it from a packed tarball in a vendor folder',
    'A consumer pin must move to a library release another session already pushed',
    'A browser says a library export is missing right after a pin moved',
  ],
  not_for: [
    'Libraries published to an npm registry (bump the semver range instead)',
    'Writing the library change itself (land it on the library\'s main first)',
  ],
  triggers: {
    work_item_labels: ['release', 'ui-components', 'dependencies'], repos: ['ui-components', 'realtime-modules'], tools: ['npm', 'tilt'],
    keywords: ['release', 'tarball', 'pack', 'pin', 'vendor', 'changelog', 'dist', 'vite', 'ui-components', 'realtime-modules'],
  },
  preconditions: [
    'The library change is on the library\'s main with its tests green, and nobody else is building, packing or installing this library right now.',
    'Your shell sets `LIB`, `REPO`, `PKG` and `VENDOR` (step 2 exports them for a project listed in data/projects.json).',
  ],
  steps: [
    {
      do: "Open this skill's folder so the bundled helpers and data resolve.",
      command: bash('cd ~/.claude/skills/rb-ui-components-release'),
      expect: '`ls` to list `scripts` and `data`.',
    },
    {
      do: 'Load the library and consumer paths for a project the bundle knows.',
      command: bash('eval "$(node scripts/pin-tarball.mjs --env data/projects.json --project aws-agentcore --lib ui-components)"'),
      expect: '`echo "$LIB $PKG $VENDOR"` prints the library checkout, the package name and the vendor folder.',
    },
    {
      do: 'Check the library release state before bumping anything.',
      command: bash('scripts/release-preflight.sh "$LIB" --fetch --bump minor'),
      expect: 'a clean tree, `behind 0`, the CHANGELOG state and a `next:` version.',
      why: 'Another session may have released while you worked, and rebasing before the bump avoids a version collision and a dist conflict.',
    },
    {
      do: 'Rebase the library on origin/main when the preflight reports it behind, then rerun the preflight.',
      command: bash('git -C "$LIB" pull --rebase origin main && scripts/release-preflight.sh "$LIB" --bump minor'),
      expect: '`behind 0` and `ready:`.',
    },
    {
      do: 'Write the CHANGELOG section for the next version and commit it with the feature, without dist.',
      command: bash('NEXT=$(scripts/release-preflight.sh "$LIB" --bump minor --print-next)', 'git -C "$LIB" commit -m "<feature>: <what a consumer can now do>" -- CHANGELOG.md src'),
      expect: '`head -12 "$LIB/CHANGELOG.md"` shows `## $NEXT` with what a consumer can now do.',
    },
    {
      do: 'Bump the library version to the next release.',
      command: bash('(cd "$LIB" && npm version "$NEXT" --no-git-tag-version)'),
      expect: '`v<next>` printed, with package.json and package-lock.json changed.',
    },
    {
      do: 'Build the library and run its tests against the fresh dist as separate commands.',
      command: bash('(cd "$LIB" && npm run build)', '(cd "$LIB" && npm test)'),
      expect: 'both exit 0, and the packaging suite is no longer skipped now that dist/ exists.',
      why: 'A release chained through a pipe once hid a failed build and shipped two version-only releases.',
    },
    {
      do: 'Commit the release with the version, lockfile and the rebuilt dist.',
      command: bash('git -C "$LIB" add package.json package-lock.json dist && git -C "$LIB" commit -m "Release $NEXT: <what changed>"'),
      expect: 'one commit touching package.json, package-lock.json and dist/ only.',
    },
    {
      do: 'Push the release, rebasing once more if origin moved while you built.',
      command: bash('git -C "$LIB" pull --rebase origin main && git -C "$LIB" push origin HEAD:main'),
      expect: 'the push lands; a conflict in dist/ means take origin\'s dist, rebuild, bump again if the version collided, and amend.',
    },
    {
      do: "Create the release tarball in the consumer's vendor folder.",
      command: bash('TGZ=$(cd "$LIB" && npm pack --pack-destination "$VENDOR" | tail -1)'),
      expect: '`echo "$TGZ"` prints a new file name with the next version in it; never overwrite a tarball in place.',
    },
    {
      do: 'Point every consumer manifest that pins the library at the new tarball, and the pins line of the doc.',
      command: bash('node scripts/pin-tarball.mjs --consumer "$REPO" --package "$PKG" --tarball "$VENDOR/$TGZ" --doc CLAUDE.md'),
      expect: 'one `pinned` line per manifest, a pin-line update for the doc, and one `next:` install line per consumer folder.',
    },
    {
      do: 'Install in every consumer folder the pin step listed, so each lockfile follows the tarball.',
      command: bash('(cd "$REPO/portal" && npm install --prefer-offline --no-audit --no-fund)'),
      expect: 'npm reports one changed package; repeat in each other folder the pin step listed (middleware for realtime-modules).',
    },
    {
      do: "Clear the consumer's Vite prebundle cache and restart its dev server.",
      command: bash('rm -rf "$REPO/portal/node_modules/.vite" && tilt trigger portal'),
      expect: 'Tilt rebuilds the portal; without Tilt, stop the Vite you started and start it again.',
    },
    {
      do: 'Verify the new API against the installed dist, never the library source or CHANGELOG.',
      command: bash('node scripts/verify-installed.mjs --consumer "$REPO/portal" --package "$PKG" --version "$NEXT" --export MeetingToolbar --dts popoverLabel'),
      expect: 'OK lines for the version, the lockfile, each export and each declaration, and for the Vite cache.',
    },
    {
      do: "Commit the consumer's pin move with the tarball, every changed manifest and lockfile, and the pins line.",
      command: bash('git -C "$REPO" add "$VENDOR/$TGZ" portal/package.json portal/package-lock.json CLAUDE.md && git -C "$REPO" commit -m "Consume <library> $NEXT: <why>"'),
      expect: '`git -C "$REPO" show --stat HEAD` lists the tarball, the manifests, the lockfiles and CLAUDE.md.',
    },
  ],
  verify: [
    {
      check: 'Pin the bundled consumer fixture and compare the result.',
      command: bash('node scripts/pin-tarball.mjs --fixture data/sample-consumer.json | diff - data/expected-pin.txt && echo pin-ok'),
    },
    {
      check: 'Judge the bundled install fixture and compare the verdicts, including the two lies it carries.',
      command: bash('node scripts/verify-installed.mjs --fixture data/sample-install.json --package @acme/ui --version 1.4.0 --export MeetingToolbar --export useConsentDismissal@video --dts popoverLabel --dts reactionPicker | diff - data/expected-verify.txt && echo verify-ok'),
    },
  ],
  failure_modes: [
    { symptom: 'The browser says a module does not provide an export named X after the bump', cause: 'Vite serves the old prebundled dist until node_modules/.vite is cleared and the server restarts', response: 'Redo the Vite step, then check with verify-installed before reimplementing anything' },
    { symptom: 'npm is satisfied but nothing new is installed', cause: 'The spec did not change: a short sha, or a tarball overwritten under the same name', response: 'Pin a new tarball name (or a full 40-character sha), then install again' },
    { symptom: 'A version check passes but the import fails', cause: 'npm folders a dependency under its key, so the folder exists for a package you cannot import', response: 'Judge the install with verify-installed --export, which imports instead of reading a version' },
    { symptom: 'The CHANGELOG and tests describe a prop the consumer cannot use (2.275.0)', cause: 'The release was built from a tree that did not carry it', response: 'Check the shipped .d.ts with --dts and fix it forward with a patch release' },
    { symptom: 'The push is rejected, or the rebase conflicts in dist/ chunk files', cause: 'Another session released while you built', response: 'Take origin\'s dist, rebuild, bump past origin\'s version if it collided, amend, push' },
    { symptom: 'A github: install dies with early EOF after minutes', cause: 'Git installs of the library are slow and fragile', response: 'Use the packed tarball; never clean the npm cache mid-install, and batch library changes into one release' },
    { symptom: 'A subpath fails to import under Node without an optional peer', cause: 'Barrel re-exports pull the peer in even though it is optional', response: 'List the peer the consumer needs as its own direct dependency' },
  ],
  rollback: [
    { do: 'Point the consumer back at the previous tarball.', command: bash('node scripts/pin-tarball.mjs --consumer "$REPO" --package "$PKG" --tarball "$VENDOR/$PREV_TGZ" --doc CLAUDE.md') },
    { do: 'Install the previous tarball again and clear the Vite cache.', command: bash('(cd "$REPO/portal" && npm install --prefer-offline --no-audit --no-fund) && rm -rf "$REPO/portal/node_modules/.vite" && tilt trigger portal') },
    { do: 'Fix a bad library release forward with a patch release, never by rewriting a pushed commit.' },
  ],
  notes: [
    'Order matters: preflight and rebase before the bump, so a release another session pushed is never reused; the feature commit carries src and the CHANGELOG, the release commit carries the version and dist only (dist chunks are content-hashed, so a dist in a feature commit conflicts with every later release); keep build, pack and install under one owner at a time.',
    '',
    'The consumer is not done until the installed dist proves the API: a version string, a CHANGELOG line or the library source proves nothing about what the browser loads. A pin move also changes the consumer\'s source digest, so any journey contracts must be measured again afterwards.',
    '',
    'This project (aws-agentcore, data/projects.json): ui-components is @connorhoehn/ui-components from ~/Projects/ui-components (origin connorhoehn), packed into portal/vendor and pinned only by the portal; realtime-modules is pinned by both the portal and the middleware (file:../portal/vendor/…), its tarball calls itself @connorhoehn/realtime-modules while the dependency key is @connorhoehn/realtime-modules, and its canonical repository is connorhoehn/realtime-modules. Both pins are written on the Pins line of CLAUDE.md; the Tilt resources are portal and middleware.',
  ].join('\n'),
};
