# Presentation-consistency audit — 2026-09-16

**Lens.** The same thing should look the same everywhere. Status vocabulary
and tone, time, money, entity links, empty-state voice, and section labels
were catalogued across both tenants, page by page.

## What was found

**Status colour disagrees for the same job.** The work queue's map is the
canonical one; local compute declares its own and picks a different tone for
`running` and `awaiting_review` — so one job reads one colour on the queue and
another on the machine that is running it. Underneath that, the run-state map
is written independently in about nine places, several of them byte-identical
twins (bot runs in two files, ingestion in two, change review in two, harness
in two). Severity is mapped five separate times, three of them inline in one
file. An enabled-but-idle bot is green on the bots page and grey on the queue
pulse, because only the pulse models `idle`. Promotion status carries two
parallel tone tables that disagree on `approved`, and two assessment files
each declare a `STATUS_STATE` with the same name and different meanings.

**Two live timezone bugs.** `pages/local-compute/localComputeFormat.ts` and
`pages/admin/kb/kbFormat.ts` format raw Aurora timestamps with
`new Date(...)`, bypassing `lib/pgTimestamp.ts`. That is the exact bug class
the devbox fleet already lost a day to: the Data API returns a naive string
and the browser reads it as local time. Around thirty further sites hand-roll
`toLocaleString()` instead of the shared helpers, concentrated in
observability, and four pages carry near-identical private chart-axis
formatters — two of which disagree about which parser to trust.

**Money is written eight or nine times.** Four definitions are
byte-identical; two more drop the thousands separator, so the same amount
reads `$1234.56` in distillation and `$1,234.56` in budgets; one shows a
job's estimated cost at two decimals while the shared helper shows the same
field at four. Fifteen more sites format inline with no helper at all.
Percentages, by contrast, are clean everywhere, and `—` for unknown is
followed at over a hundred sites with two assessment outliers saying `N/A`.

**Nine entity dead ends.** The agent runtime name is not a link on the agent
leaderboard page itself. People are plain text in every sprint and grant
table although a `PersonRef` component exists one directory over. The bot
name is unlinked inside the work queue and on local compute, one click from
three pages that link it correctly. The same repo field points at GitHub on
one page and an internal route on another.

**Voice is already consistent.** Empty states are uniformly statement-phrased
with a domain explainer and a gated action; two put a whole instruction
sentence in the title, and one is missing the action its twin page has.
Section labels are well adopted except in observability and harness, where
the same hand-tuned caption class appears fourteen-plus times — once nine
lines below a real `SectionLabel` in the same file.

## Resolution

See the commit carrying this document: `portal/src/lib/statusTone.ts` and
`portal/src/lib/format.ts` are the shared maps, and the two timezone bugs are
routed through the existing time helpers.
