# Capability id reconciliation

`middleware/.env.aws` rots on every rebuild, silently. This is the runbook and
the tooling for that.

## The failure

`OrgIQ-AgentCoreCapabilities` mints a fresh id every time it is recreated, and
nothing regenerates `.env.aws`. `BROWSER_ID`, `BROWSER_PROFILE_ID`,
`CODE_INTERPRETER_ID` and `MEMORY_ID` keep pointing at resources that no longer
exist — and so do the three per-role `GUARDRAIL_ID_*`, on the same schedule.

What makes it expensive is not that it breaks, but that each one breaks
*differently* and none of the symptoms mentions configuration:

| id | what you see |
|---|---|
| `CODE_INTERPRETER_ID` | "not found", naming an id nobody recognises |
| `BROWSER_PROFILE_ID` | "Browser profile not found", surfaced as a bare 500 |
| `BROWSER_ID` | `site-survey`'s browser fallback fails **soft** — indistinguishable from "this site has no JavaScript-only pages" |
| `MEMORY_ID` | memory reads/writes fail; conversations lose continuity |
| `GUARDRAIL_ID_*` | answers go out without the role's guardrail attached |

Three of those were diagnosed separately in one afternoon before anyone
connected them.

## Where the reconciliation lives

**`schema/reconcile_capabilities.py`** — the operator-facing tool.

```bash
.venv-synth/bin/python -m schema.reconcile_capabilities            # report
.venv-synth/bin/python -m schema.reconcile_capabilities --write    # offer the fix
.venv-synth/bin/python -m schema.reconcile_capabilities --json     # machine-readable
```

Read-only unless you pass `--write`. It makes `List*` and `GetCallerIdentity`
calls and nothing else. Exit code is 1 when anything is stale, so it can gate a
deploy script.

### Why it stands beside `schema/dump-stack-outputs.sh`, not inside it

`dump-stack-outputs.sh` is a *generator*: it reads CloudFormation outputs and
rewrites the whole file unconditionally. Three reasons that is the wrong home:

1. **It is destructive by construction.** The live `.env.aws` carries keys the
   generator does not emit at all — `SESSION_SIGNING_SECRET_ARN`, `CANARY_NAME`,
   `BROWSER_PROFILE_ID` — so running it to fix one stale id silently drops them.
   A diagnostic has to be safe to run before you know what is wrong.
2. **It answers a different question.** The generator tells you what CFN says.
   It cannot tell you that the id you are already running with is dead, and the
   whole finding is that nobody *knows* the file has rotted.
3. **These ids are not reliably CFN outputs.** They come from the AgentCore
   control plane, which is the only authority on what currently exists.

The two compose: reconcile to learn what is stale; regenerate when you want the
whole file rebuilt from a fresh stack.

### What it classifies, and how

For each env var it compares the configured id against a live `List*` of that
resource kind:

| verdict | meaning |
|---|---|
| `ok` | the id is in the account's listing |
| `STALE` | the listing came back and the id is not in it |
| `unset` | the var is empty — unavailable, which is not the same as broken |
| `?` | the `List*` call failed — **verdict withheld** |

The `STALE` / `?` distinction is the point. An empty list is a definite "this
account has none of these"; a *failed* list says nothing at all. Reporting the
second as the first turns an expired laptop credential into "your entire fleet
is gone". Nothing is ever rewritten on a `?`.

Two more guards:

- **Account mismatch.** If `sts get-caller-identity` disagrees with the file's
  `AWS_ACCOUNT_ID`, every id will read as stale. That is called out *above* the
  table, because "you are in the wrong account" is a different fix from "the
  resource was deleted".
- **Ambiguity.** A stale id with exactly one live candidate is an unambiguous
  replacement and is offered. Two or more is a choice, and the script refuses to
  make it — picking the first would be a coin flip that looks like a fix.

`--write` is line-surgical: it replaces only the specific lines it can justify
and leaves comments, ordering and every unrelated key byte-identical.

## What a stale id looks like now

At the console, `--write` withheld:

```
Capability reconciliation — middleware/.env.aws

  [ok   ] MEMORY_ID                orgiq_memory-LIVE
  [STALE] BROWSER_ID               orgiq_browser-DEAD
                                   orgiq_browser-DEAD does not exist in this account.
                                   when stale: site-survey's browser fallback fails SOFT — reads as 'no JS-only pages'
                                   live now: orgiq_browser-NEW
  [ok   ] BROWSER_PROFILE_ID       orgiq_browser_profile-LIVE
  ...

2 stale id(s): BROWSER_ID, CODE_INTERPRETER_ID

Proposed rewrite:
  BROWSER_ID: orgiq_browser-DEAD -> orgiq_browser-NEW
Re-run with --write to apply. Nothing has been changed.
```

At middleware boot (`middleware/src/config.ts`), one line per dead id:

```
[capabilities] BROWSER_ID=orgiq_browser-DEAD (from middleware/.env.aws) does not exist in this account — site-survey's browser fallback fails SOFT, reading as "this site has no JavaScript-only pages".
[capabilities] Fix: .venv-synth/bin/python -m schema.reconcile_capabilities --write
```

And on demand, `/api/capabilities/reconcile` behind the portal's Capabilities
page (`middleware/src/providers/capability-reconcile.ts`) — which pre-dates this
work and is what the boot check calls.

## The startup check, and why it cannot break a boot

`config.ts` fires a check at load. Its constraints, in order of how much damage
getting them wrong would do:

- **Silent under `npm run dev:mock`.** `DEV_OFFLINE=true` or `MOCK_AGENTCORE=true`
  skips it entirely. Offline, none of these ids means anything and every one
  would report broken — which is how a boot warning earns its way into a filter
  and then into the bin.
- **Silent under jest** (`NODE_ENV=test` or `JEST_WORKER_ID`), so it never adds
  noise or an AWS call to the suite.
- **Cannot fail the process.** It runs on a deferred `unref`'d timer, so it can
  neither delay `listen()` nor hold the process open; the AWS SDK arrives via
  dynamic `import()`, so an offline run never loads it; and every error is
  swallowed.
- **Only `missing` is reported.** `unknown` (AWS unreachable) and `unconfigured`
  are not problems and are not logged.
- `CAPABILITY_STARTUP_CHECK=off` disables it outright.

## The shell-shadow trap

`config.ts` only fills vars that are `undefined`, so **anything exported in the
launching shell shadows `.env.aws` entirely**. Both tools account for it, because
a fixer that claims a fix it did not make is worse than no fixer:

- the script judges the value the *process* would use, lists shadowed keys under
  a `SHADOWED BY THE SHELL` heading, and after `--write` prints an explicit
  `WARNING: <KEY> is still exported in your shell … run \`unset <KEY>\``;
- the boot line says where the value came from — `(from middleware/.env.aws)`
  versus `(exported by your shell, overriding .env.aws)` — and appends
  `and \`unset <KEY>\` first, or the file edit will have no effect.`

## Tests, and what is not covered

```bash
.venv-synth/bin/python -m unittest schema.test_reconcile_capabilities   # 37 tests
cd middleware && npx jest src/__tests__/config-capability-check.test.ts # 14 tests
```

Everything that decides anything is pure and runs offline: parse, compare,
classify, render, rewrite. The Python tests cover the round trip — classify a
rotten file, propose the fix, rewrite, re-classify, assert nothing is stale.

Two things are **not** verified without a live account:

1. **The round trip to AWS itself** (`live_inventory()` shelling out to the AWS
   CLI). The response *parsing* is not guessed, though: `test_spec_table_matches_botocore`
   asserts every operation name, array member, id field and `nextToken` input
   against the real botocore service model, so a typo in `browserSummaries` or
   `codeInterpreterId` fails offline rather than in a live run.
2. **Whether a real stale id produces a `STALE` verdict end to end.** The
   comparison is fixture-driven; only the listing is unexercised.

Note the script paginates on `nextToken`. `capability-reconcile.ts` does not — it
passes `maxResults: 50` and reads one page, which is the same bug CLAUDE.md
already records for `ListPrompts`. Under 50 resources of a kind the two agree;
past that the portal page can report a live id as missing while the script does
not.
