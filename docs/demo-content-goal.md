# Goal: demo content a peer believes

The user shows this app to peers for feedback, and the feedback on 2026-10-14
was: "a lot of it just isn't demoable because the content was off. Controls
are getting better though." The layout work is converging; the **content**
(the `dev:mock` fixtures, the program seed and its generator, the records the
mock derives, and the copy around them) is what stops a demo. This goal is
the definition of done for that content. `docs/demo-content-audit.md` is the
audit that set it: the story each tenant should tell in five minutes, every
finding ranked by how much it hurts that story, and the fix lanes.
`scripts/validate-demo-content.sh` is the only judge.

Out of scope: distillation and runbooks, its replacement (`/iq/distillation/*`,
`/iq/runbooks/*`, `middleware/src/mock/{distillation,runbooks}*.ts`). That
content is being rebuilt separately under `docs/distillation-runbooks-design.md`;
the probe skips its routes and the fixture checks skip its files.

## Running the judge

```bash
./scripts/validate-demo-content.sh            # the committed probe capture, the fixtures, the story logs
./scripts/validate-demo-content.sh --quick    # skip the fixture loaders (tsx) and the story logs
./scripts/validate-demo-content.sh --probe    # re-walk every tenant × role first (needs Vite :5183 + dev:mock :3001)
./scripts/validate-demo-content.sh --walk     # walk the demo story maps first (needs the stack)
```

The probe by hand, and folding its shards into the committed index:

```bash
cd portal && DEMO_PROBE_SHOTS=<dir> npx playwright test e2e/demo-content-probe.spec.ts --workers=3 --reporter=line
node scripts/demo-content/merge-probe.mjs <dir>          # -> docs/demo-content/probe-index.json
DEMO_PROBE_ONLY=social:moderator …                        # one walker (or one tenant); merges by walker
```

The probe signs in as a fresh **clone** of each role's seed persona
(`openAsClone`), refuses every non-GET the page sends, screenshots each page
into `DEMO_PROBE_SHOTS` (PNGs never enter the repo) and records each page's
visible text and rubric hits in `docs/demo-content/probe-index.json`.

## The rubric

Every page a peer is shown is read against seven questions. The judge checks
the mechanical half; the audit records the half that needs reading.

| | Question | Mechanical check |
|---|---|---|
| a | **Coherent story.** The cast, initiatives, runs, decisions, messages and documents refer to each other consistently: the owner on an initiative is the one in its discussion; a failed run has a cause someone discusses. | F3 cross-references; J story maps |
| b | **Realistic.** Names, titles, prose and numbers a peer believes; no filler ("fact N", "Load-corpus…", lorem, foo), no "(+1 more)" leaks, no glued sentences, no one sentence pasted over fifty rows. | D2 filler / glued / leaks / repeated lines; F1 filler; F2 repeated templates |
| c | **Numbers add up** across pages: spend vs runs, counts vs rows, percentages. | D2 impossible numbers; F4 counts derived |
| d | **No raw ids, slugs or ISO timestamps** where a name or a relative time belongs. | D2 raw ids / ISO times; J `LEAKS` |
| e | **Time-consistent with the mock clock.** Nothing "in 3 days" that already happened; no two-month-old "live" activity; no date that does not move. | F2 literal dates; J story facts |
| f | **No empty or near-empty demo page**, as a clone of the role that tells the story. | D3 demo pages |
| g | **Copy for a customer**, not a developer (no `dev:mock`, fixture, endpoint, env var, ticket-style "lane A2" talk). | D2 developer copy; J `LEAKS` |

## The checks

| Id | Section | Passes when |
|---|---|---|
| D0 | documents | this file, the audit, `docs/demo-journeys/PROTOCOL.md`, the probe spec and the rubric exist; the CLAUDE.md docs map lists this goal and the judge |
| D1 | probe capture | `docs/demo-content/probe-index.json` covers all 18 walkers (every role of every tenant, `scripts/demo-content/judge.mjs` `WALKERS`), no capture errored, and it is newer than the last commit touching the fixtures (`middleware/src/mock`, less `core/`, tests, distillation and runbooks), `schema/seed.sql`, `schema/seed_program.sql`, `schema/seeds` or `scripts/dev/social-sim.mjs` |
| D2 | rendered text | over every captured page: zero filler, `(+N more)`, glued sentences, `undefined`/`NaN`/`null`, lines repeated more than five times on one page, raw ids/slugs/lobby keys, ISO timestamps, impossible numbers, developer copy (`scripts/demo-content/rubric.mjs` `RENDERED_RULES`) |
| D3 | demo pages | each page of the stories (`judge.mjs` `DEMO_PAGES`, 42 pages) renders at least its word floor and no empty-state sentence **as a clone** — a demo may not depend on signing in as the one seed user whose id the rows are keyed by |
| F1 | fixture filler | no filler pattern in a string literal of `middleware/src/mock/*.ts`, `schema/seed_program.sql` or `schema/seeds/generate_program_seed.py` (`rubric.mjs` `SOURCE_RULES`) |
| F2 | fixture prose | across every registered fixture's default rows: no sentence template (digits and quoted words folded) repeated more than 5× in one fixture, and no literal calendar date in copy (`scripts/demo-content/prose.mts`) |
| F3 | cross-references | every person, user, initiative, work item, decision, sprint, design, team, access request/policy/review, catalog item and channel id that any fixture row mentions — in an id field or inside its prose — exists in its owning fixture, and every name stored beside an id (`stewardPersonId` + `stewardName`) is that record's name (`scripts/demo-content/xref.mts`) |
| F4 | counts derived | no literal count/total/rate beside fixture rows (`docs/mock-floor.md` rule 1, held at **zero** here rather than at its ratchet, plus the inline `childCount`-style shapes the floor's line regex misses) |
| J | story maps | `run-maps.mjs check --family demo` is clean, and each map in `docs/journeys/maps/demo/` has a log in `docs/demo-journeys/` with `verdict: pass`, `story-facts: pass`, `cross-links: pass` |

What the judge cannot see, and the audit owns: whether a sentence is
*plausible* (a CVE bot writing a design analysis passes every regex), whether
two records that never name each other *should* (a failed run nobody
mentions), and whether a page's numbers agree with another page's. The story
maps encode the most important of those as facts; the rest are audit
findings a fix lane closes by hand.

## The stories (what the maps assert)

The full narrative, and why each tenant's story was chosen, is in the audit.

| Tenant | Narrator (cloned) | The story |
|---|---|---|
| Work | Vera Green, org-leader; Mia Singh for the money | Auth Migration: Vera owns it; the legacy SSO decommission is blocked on the escalated decision "Cutover order for legacy SSO tenants", which Sienna Garcia (release manager) must make; `#auth-migration` discusses the same blocker; agent runs did its work and one failed for a reason someone discussed; Mia's budget is being spent by those runs |
| Assessment | Jonas Lindqvist, lead-assessor | Northstar Payments claimed level 5 on CI but the evidence shows 2; a not-applicable request waits for Jonas; a failed ingestion run on another team has an owned follow-up; the report rolls up the same scores |
| Social | Sana Iqbal, participant | `#incidents` carries Rachel's Sev 3 and Theo's root cause; `#auth-migration` matches the Work board; Sana's DMs, calls and the recording she was in agree with the chat |
| Pipelines | Kofi Mensah, operator | Kofi operates definitions Ines Moreau authored; the ledger has real outcomes with one failure traced to its definition and owner; the approvals ask about work that is actually pending; the bots that ran today are enabled |
| Access | Rhea → Omar → Priya | Rhea asks for SME in Work; Omar, her manager, decides; the steward after him is a person who can decide; Priya's quarterly review has a deadline, a policy has caught a request, and the audit reads as sentences |

## Rules that do not bend

1. **Fix the rows, not the page.** A raw id on screen is fixed by resolving it
   to a name where the page renders it *and* by not storing prose that embeds
   ids; never by a regex that hides it.
2. **The program seed is generated.** `schema/seed_program.sql` comes from
   `schema/seeds/generate_program_seed.py`; change the generator and
   regenerate, then mirror the fixture (`docs/mock-floor.md`). Never
   hand-edit the SQL.
3. **The mock contract holds** (`docs/mock-floor.md`): rows and selectors,
   never stored counts; every timestamp from `mock/core/clock.ts` inside the
   rows factory; wire strings from captured responses; writes on registered
   fixtures. `scripts/validate-mock-floor.sh` must stay green.
4. **Clones see the persona's world.** A clone shares its persona's grants,
   person link and name; a "mine" view keyed by the seed user id must resolve
   a clone to its persona (or key by person), so the probe and the maps judge
   what a demo shows. Never walk as the seed personas to make a page pass.
5. **One cast.** Every name on screen is either in the sign-in cast
   (`middleware/src/providers/identity.ts`) or in the org graph
   (`mock/people.ts` / `schema/seed.sql`), and no two people a peer meets in
   one story share a first name.
6. **Budgets only ratchet down.** Nothing here has an exemption file; a check
   that cannot pass yet stays red in the judge's output.

## Done when

`./scripts/validate-demo-content.sh --probe --walk` prints ALL PASS, and a
peer shown each tenant's story for five minutes asks about the product, not
the data.
