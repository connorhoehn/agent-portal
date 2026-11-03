# Work / Social UI handoff — 2026-11-02

Start with [the current checklist](work-social-ui-todo.md), then
[the verification report](work-social-ui-verification-2026-11-02.md). The latest
Connections redesign is documented in [this follow-up](connections-layout-2026-11-02.md):
one shell inspector, compact relationship/team facets, hidden graph settings,
and a Force/Radial radio group beside the canvas. Older selection/detail links
still work; an explicit `pane=closed` preserves a dismissed inspector.

The preceding nested workspace search implementation is committed in
`b1805b6e`: a scoped visit opens Work,
record-type navigation selects one collection, and All is one ranked list.
Initiative scope survives every switch; expanding scope stops at people rather
than pulling in unrelated work through a contributor.

The earlier Storymaker/episode requests on port 7331 were explicitly for another
chat. Do not work on them here.

**Local only: the user explicitly said not to use AWS.** Do not request AWS
credentials, run cloud checks or deploy for this task. Earlier read-only checks
made no AWS changes; they are not a remaining blocker or a continuation task.

The portal pin is **ui-components 2.499.7-audit.0**, realtime **0.141.0**.
App implementation commit **`8ff773f4`** is pushed on main.
Library UI fixes are on main through `a33f309f`; audit packaging is source
`2c9136b2`, release `081fc21a` on `codex/audit-package-release-20261102`.
[Draft PR #1](https://github.com/connorhoehnslalom/ui-components/pull/1) contains
only the packaging source change. It was isolated because another session is
publishing composer work from the shared library checkout. All 339 runtime files
match verified UI 2.499.6; the archive additionally includes the audit skill.
Integrate the source-only PR when advancing the shared package, preserving the
other session's composer changes. The isolated checkout is
`/Users/connorhoehn/Projects/ui-components-audit-release`.

## What to preserve

- Use shared ui-components layout, typography and controls. The portable
  `ui-dom-audit` skill owns DOM contracts and source/installed-package checks;
  the app adapter owns routes, personas, composer policy and app ratchets.
  Automation resolves the installed, versioned skill first. Set
  `UI_DOM_AUDIT_SKILL` only when intentionally testing library source changes.
- Document contents, sources and assembly details stay inside the same reading
  surface. Runbooks and proposals use concise titles, numbered sections and
  previous/next/contents navigation. Brief preview has its own document pane.
- Overview, attention, upcoming and Work lists share two-line title/slug rows,
  aligned people and metrics. Catalog rails use consistent label headings and
  measured ordinary, combined and folded width profiles.
- The composer can collapse while retaining its draft. Hangout calls use a
  bounded gallery and right People/Conversation sidebar, including one person.
- Portraits resolve by canonical IDs. Never infer identity from a display name,
  overwrite custom photographs or substitute another person's picture.

## Verification and environment

The Tilt stack is shared: portal `http://localhost:5183`, middleware
`http://127.0.0.1:3001`. Do not kill/recreate it, reset demo state or sign browser
tests in as seeded users. Use `openAsClone` from `portal/e2e/realSession.ts`, with
a scoped world for mutating journeys. A two-user gallery test uses synthetic
camera/microphone devices over the actual local SFU; it owns and archives its
room and deletes its clones.

Evidence lives in `.scratch/work-social-followup-2026-11-02/`; the checked-in
verification report distinguishes final runs from failed attempts. Full library
tests, lint and build passed. Targeted app and middleware tests cover capability
presentation, canonical design identities, document formatting and rail profiles.
All 26 final walks pass and are sealed: Search, Decisions and Sprints across
five Work roles, plus eleven runbook journeys. Journey logs must be sealed only
after an actual passing walk and fresh measurements; never copy a digest to
bypass freshness. The local UI checklist and handoff are complete; the debt below
remains open.

Useful commands, from the app root unless a prefix is shown:

```sh
node scripts/audit-ui-inheritance.cjs --check
bash scripts/validate-component-discipline.sh
npm --prefix portal run typecheck
node --test scripts/lib/ui-audit-skill.test.cjs scripts/lib/list-rail-profile.test.mjs
REAL_AVATAR_POSTGRES=1 node --test scripts/avatars/backfill-postgres.test.mjs
node scripts/avatars/prepare-backfill.mjs --check
node scripts/avatars/verify-hosted.mjs http://localhost:5183
bash scripts/journeys/measure.sh
node scripts/journeys/run-maps.mjs walk work --only search --no-seal
node scripts/journeys/run-maps.mjs walk runbooks --no-seal
```

The live gallery test is `portal/e2e/hangout-gallery-live.spec.ts`, enabled with
`REAL_MEDIA_ACCEPTANCE=1` when running Playwright from `portal`. It creates a
test-owned call, so keep its cleanup intact. Full schema migration unit tests
run from `schema` with `../.venv-synth/bin/python -m unittest test_migrate`;
the macOS system Python is too old for this repository.

## Remaining technical debt

1. **Portrait verification is local.** All 80 locally served assets pass SHA-256
   checks. The prepared migration handles 59 people and 12 unlinked accounts and
   preserves custom/concurrent photos. Its disposable PostgreSQL preservation
   and idempotence test passes. It remains unapplied; do not turn it into an AWS
   deployment task.
2. **Design persistence remains mock-first.** Signed posts and approvals now
   carry canonical IDs and reject body spoofing. The additive SQL author columns
   are prepared, but Aurora provider wiring and trusted historical identity
   backfill remain. Unlinked `user:<id>` signers need a durable representation
   because the existing sign-off table requires a person FK. Name-only historical
   approvals cannot count toward distinct-person quorum; rejections still block.
3. **Assessment contributor JSON has no canonical IDs.** Resolve real identity
   before propagating portraits there. Separately, the broad layout sweep exposes
   missing breadcrumbs on `/assessment`, `/assessment/teams` and
   `/assessment/submissions`; these surfaces have independently owned edits.
   No baseline was relaxed to conceal them.
4. **Bundle size is measured, not repaired.** Initial entry closure is 4,485,082
   bytes / 1,345,718 gzip. Use `scripts/profile-portal-bundle.mjs`; evaluate lazy
   terminal, graph, document-editor and camera-effects boundaries. Do not raise
   the warning threshold.
5. **Call follow-ups:** screen-share presentation, WAN reconnects and real-device
   permissions are outside the gallery acceptance. Older deployment handoffs
   are historical background, not authorization for cloud work in this task.
6. **Global journey coverage is not all green.** The full Work validator has
   66 of 125 historical logs invalidated by changed contract/spec fingerprints (including the
   independently owned huddle tests) and an unmapped `orgiq:admin` role. Refresh
   those with real walks when the corresponding work settles. The scoped walks
   and seals in this report do not certify all 125 Work journeys.

## Shared checkout discipline

There is independent uncommitted Assessment/huddle work. In particular, do not
absorb or revert middleware call-access/package edits, portal `app.css`,
ConversationPane/HuddleChat/SocialFooter, breadcrumbResolve, Assessment components,
their tests, or the huddle fixture/tarball additions. Inspect `git status` and each
diff before staging. This session's commits must include only its owned changes.

ui-components source and release commits remain separate. Verify the packed
archive against the consumer install, move Vite's optimized cache aside and
restart only the portal resource after changing its pin. Do not patch installed
node_modules. Read the current package manifests for versions; older handoff
pins are historical.
