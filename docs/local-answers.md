# Local answers — the program data assistant

Questions about the app's own structured data — budgets, blocked work, owners,
sprints — are answered by the BFF from the same providers the pages read, with
no AgentCore runtime and no Bedrock call. It works the same in `dev:mock` and
against Aurora. Anything it does not recognise falls through to the agent path
exactly as before.

Why: asked "what project is over budget?" from the Initiatives composer, the
Work assistant used to answer with the mock's canned "Based on available data,
I can help you explore…" blurb above "knowledge base searched — no documents
matched", while the table on the same page held the answer ($4.28 of $85.00 on
LLM Application Platform; $0.89 and no allocation on Inference Platform). An
LLM is the wrong tool for reading a column back; the rows are already here.

## Where it sits

`POST /api/agents/:agentId/invoke` (`middleware/src/routes/agents.ts`) asks the
local assistant **first**, before any agent call, when all of these hold:

- `LOCAL_ANSWERS` is not `false` (default on);
- the agent is a read agent — supervisor, search or advisor (never a write
  agent, the devbox, or an assessment agent);
- the session's tenant is `orgiq`;
- the body is a plain question (no `presentationContext`, no structured
  `payload` such as a document command);
- `matchIntent` (`lib/local-answers/match.ts`, pure, no provider imports) finds
  one of the intents below.

If the matched intent can be answered (`answerLocally`, `lib/local-answers/index.ts`)
the route streams it and returns; otherwise the request continues to the agent
(real AgentCore when configured, the dev:mock agent otherwise), with the
composer's scope and stance rebuilt as prose for the model.

The answer streams in the AG-UI shape the Search Answer tab and the initiative
Agent pane already render:

1. `STEP_STARTED` / `STEP_FINISHED` named `local data: <intent>`;
2. a `local_answer` tool call — args `{intent, scope, stance}`, result
   `{intent, sources, rows}`: the structured rows every figure was computed from;
3. a `search_context` tool call — the cited records (`initiative` / `work`,
   numbered `n`, with `href`s), which become the Answer's evidence list and
   Connections; the prose cites them as `[n]`;
4. the text message.

The turn is recorded to Memory (`recordTurn`) like an agent turn so the
conversation resumes with its evidence. No agent run or invocation is recorded:
no agent ran. The portal labels `local_answer` as "read program data"
(`toolCallSummary.ts`) and chips it as a `program data` source
(`answerSources.ts`), so it never reads as a knowledge-base search.

## Intents

| Intent | Example | Reads |
|---|---|---|
| `budget` | "what project is over budget?", "anything near its allocation?" | `listProjects` (spend MTD + allocation — the Initiatives table's own columns), `getMaintenance30d` (`v_initiative_maintenance_30d`) |
| `spend` | "how much did Inference Platform spend this month?" | `listProjects` |
| `status` | "which initiatives are blocked / critical / behind?" | `listProjects` (priority badge), `getProjectWorkItems` (open items with a blocked reason or `blocked` label), `listSprints` |
| `owners` | "who owns Auth Migration?", "who's on RAG Knowledge Search?" | `listProjects` (owner, SMEs), `getProject` (contributors) |
| `work` | "what's open on Observability Platform?", "what's blocked?" on an initiative page | `getProjectWorkItems`, `getWorkItem` |
| `sprints` | "how are the sprints going?", "which sprints are behind?" | `listSprints` |

Rules the answers apply, each stated in the answer when it matters:

- **Over** = spend MTD > allocation. **Near** = at least 80% spent.
  **Unbudgeted** = spend with no allocation row. Spend is month-to-date, the
  same window as the Initiatives table and the Budgets ledger.
- **Maintenance floor** = cron-triggered spend over the trailing 30 days,
  read against the allocation (`docs/program-operating-model.md`): at 80% or
  more there is little room for new work.
- **Blocked** = an open (open / in progress / in review), non-epic item with a
  `blocked_reason` or a `blocked` label — the predicate Search uses.
- **Critical** = the initiative's highest open work priority is `critical` —
  the Initiatives table's priority badge.
- **Behind** = an active sprint whose share of points done trails its share of
  days elapsed (end date inclusive) by more than 25 points.

Every number is computed from rows at request time; nothing is typed. When
nothing matches, the answer says so and names the closest case ("No initiative
is over its October allocation; the closest is …").

The initiative a question is about comes from, in order: initiatives the text
names (exact name, id, or a distinctive first word such as "inference"), else
the scope. A question that is a request to change something ("create a sprint
…", "assign …") is never answered locally.

## Scope and stance

The composer's context chip reaches the server as data, not prose:

- invoke body `scope`: `{kind:'initiatives'}`, `{kind:'initiative', id}` or
  `{kind:'work', id}`, and `stance: 'advise'` (every composer ask is
  advise-only). Validated before the stream opens
  (`lib/local-answers/scope.ts`); a malformed value is a 400.
- Search URL `about=initiatives | initiative:<id> | work:<id>`
  (`portal/src/lib/askScope.ts`). `askHref` builds it, `SearchPage` parses it,
  and `InvokePage` sends it with every turn of that conversation.
- The question shown in Search's breadcrumb, title and transcript is the
  question as typed. The "About … Advise only; do not change anything." prose is
  rebuilt server-side (`scopeContextLine`) and appended only to the message an
  LLM agent receives on the fall-through.

## Authority

The assistant never widens what a caller can read:

- **Money** — spend, allocation, maintenance floor, sprint envelopes — only for
  the budgets read tier: org-leader, hr-admin, program-owner, admin, or anyone
  Cedar grants `ManageBudgets` (`lib/budget-read-tier.ts`, the same predicate
  the initiative status decks use). Below it, a money question gets an answer
  with no dollar figures and no rows that says why and what can be asked instead.
- **Sprints** — the whole board for the tier, the caller's own sprints
  otherwise (stewarded, granted, or with their work) — the split
  `GET /api/sprints` makes.
- **Initiatives, work items, contributors** — open to the orgiq tenant, as the
  Initiatives page and `/api/graph/*` are.

⚠️ Known gap, not changed here: `GET /api/graph/projects` (the Initiatives
table) returns `agentSpendUsd` and `allocatedUsd` to every orgiq session,
including members, so the table shows figures the assistant withholds. Whether
to redact those columns below the tier is an open decision.

## The dev:mock agent's fall-through

`middleware/src/mock/responses.ts`'s unmatched reply used to claim a search
("I searched the knowledge base and graph…") over a seeded
`search_knowledge_base` call that returned "2 documents found". It now runs no
tool, says it is the offline demo agent with no answer for the question, and
lists the question forms the local assistant answers.

## Tests

- `middleware/src/lib/local-answers/__tests__/local-answers.test.ts` — every
  intent over the mock fixtures; expected figures are read from the same
  providers the pages read (never typed), plus the money gate.
- `middleware/src/routes/__tests__/agents-local-answers.test.ts` — routing
  order (local first, fall-through with rebuilt prose, `LOCAL_ANSWERS=false`,
  write/assessment agents and other tenants excluded, 400 on a bad scope) and
  the member answer without figures.
- `portal/src/lib/__tests__/askScope.test.ts`,
  `portal/src/pages/project-detail/__tests__/composerPrompts.test.ts`,
  `portal/src/pages/projects/__tests__/initiativeAgentRequest.test.ts`,
  `portal/src/components/chat/__tests__/localAnswerSources.test.ts` — scope
  plumbing and how a local answer is labelled.
