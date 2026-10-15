// The canned answers `mockAgentCore.invokeAgent` streams back in dev:mock.
//
// This is a lookup table, not a metric surface, so the floor's first rule has
// nothing to bite on here. The second and fourth do: the table goes behind the
// registry so an auditor can ask what the chat looks like when the fleet has
// nothing to say — until now the only way to see the fall-through answer was
// to type a question none of the keyword sets matched and hope.

import { defineFixture, fixtureRegistry } from './core/index.js';
import { documentEditReply } from './document-agent-edits.js';
import type { WorkItem } from '../providers/work-items.js';
import { presentationQuestionPreview } from './presentation-question.js';

export interface MockResponse {
  keywords: string[];
  toolCalls: Array<{ name: string; args: string; result: string }>;
  response: string;
}

function seedResponses(): MockResponse[] {
  return [
    {
      keywords: ['observability', 'p-observability', 'statsd', 'cardinality', 'dependency map'],
      toolCalls: [],
      response: 'Observability work summary',
    },
    // The Distillation demo's guide (mock/distillation-demo-script.ts): "Explain
    // this guide" on its Knowledge record sends the guide's title and steps
    // (portal knowledgeModel.guidePrompt), and this is the answer. FIRST so it
    // wins over the auth row below, whose 'login' would otherwise take it. No
    // tool calls: the guide is in the prompt, so nothing is retrieved, and the
    // answer claims no source it did not read. It describes the steps the
    // script produces and says nothing about the guide's run state, which the
    // answer cannot know.
    {
      keywords: ['smallest tenant first'],
      toolCalls: [],
      response: `Here is how to use **Cut over the smallest tenant first — one tenant a day**, in the order the guide gives:\n\n1. **Start with the smallest tenant, one tenant a day**, so a bad cutover reaches the fewest people.\n2. **Fix logout first**: expire the legacy shim cookie in the same response that ends the Cognito session, or a signed-out user can still reach shim-served pages.\n3. **Make a revoked grant terminal**: answer it with a 401 the client signs out on, rather than a 403 it retries — the retry is what looped.\n4. **Update the tenant's redirect before the flip**: point its hosted-UI callback at the Cognito domain, then flip the tenant's flag.\n5. **Keep the SAML shim behind the per-tenant flag until the last tenant is over** — flipping back is only a quick rollback while the shim still runs.\n\n**Why this order:** each step answers something that went wrong in the lab sessions the guide was distilled from — the shim cookie outliving logout, a refresh loop on revoked grants, and a redirect that still pointed at the old domain.\n\nI have not changed anything. The guide's Runs tab shows where it has been used.`,
    },
    // The Kubernetes-experts, auth, teams-overview and influence-leaderboard
    // rows that used to follow were fabricated: "who knows Kubernetes" named
    // Theo Chang (no Kubernetes skill) with a made-up score, the auth reply
    // cited decisions that exist nowhere in the seed, and the teams and
    // leaderboard tables were invented numbers — and they fired on keywords in
    // the attached search records, not the question (docs/user-search-goal.md
    // U10). Those questions are now answered from the search projection
    // (lib/search-index/answers.ts) or fall through to the honest default.
  ];
}

/**
 * Canned answers.
 *
 * `empty` — no keyword matches anything, so every question falls through to
 *           the generic "here is what I can help with" reply below. That is
 *           what a fleet with an empty knowledge base actually sounds like,
 *           and it is the state the chat's "no grounding" copy is written for.
 */
export const chatResponses = defineFixture<MockResponse>({
  key: 'chat-responses',
  scenarios: {
    default: seedResponses,
    empty: () => [],
  },
});

/**
 * The fall-through. Not a fixture row: it is not one of the answers, it is
 * what happens when none of them match, and a surface that counted the rows
 * would be wrong to include it.
 *
 * It used to open "I searched the knowledge base and graph…" over a seeded
 * `search_knowledge_base` call whose result was the string "2 documents
 * found" — so the Answer tab rendered a claim that a search ran beside a
 * provenance line reading "knowledge base searched — no documents matched",
 * and offered a menu of topics as if it had looked. Nothing was searched: this
 * is the offline demo agent, and it matched no canned answer. So it runs no
 * tool, says so, and names the question forms that DO get a real answer — the
 * local data assistant's (lib/local-answers, docs/local-answers.md), which
 * answers before this agent is ever asked, and the canned demo topics above.
 */
/**
 * The user's question inside an invoke message. routes/agents.ts prepends the
 * selected records as a `<search_context>` block (lib/search-context.ts); the
 * canned table must route on what was ASKED, never on words that happen to
 * appear in an attached record (an Observability record in context used to
 * turn every question into the Observability work list).
 */
export function questionOf(message: string): string {
  const end = message.lastIndexOf('</search_context>');
  return (end >= 0 ? message.slice(end + '</search_context>'.length) : message).trim();
}

const defaultResponse: MockResponse = {
  keywords: [],
  toolCalls: [],
  response: `I can't answer that here. This is the offline demo agent (no AgentCore runtime is connected), it has no canned answer for this question, and nothing was searched — no knowledge base, no org graph.

Questions about the program's own data are answered from the same rows the pages show, with or without an agent:
- **Budgets** — "Which initiatives are over budget?", "How much did Inference Platform spend this month?"
- **Status** — "Which initiatives are blocked?", "Which are critical?", "Which sprints are behind?"
- **People** — "Who owns Auth Migration?", "Who's on RAG Knowledge Search?"
- **Work** — "What's open on Observability Platform?", "What's blocked on SOC2 Compliance?"
- **Sprints** — "How are the sprints going?"

People and decisions are answered from the search index:
- **Experts** — "Who knows Kubernetes?", "Terraform skills"
- **Teams** — "Who is on the platform team?"
- **Collaborators** — "Who works closely with Nora DaSilva?"
- **Decisions** — "Which decisions are still open?", "Who decided on self-hosted OTel collectors?"
- **Your work** — "What am I working on?"`,
};

export function selectMockResponse(message: string, structuredInput?: Record<string, unknown>): MockResponse {
  const presentation = presentationQuestionPreview(structuredInput?.presentationQuestion);
  if (presentation) return presentation;
  // A document's composer dock sends the drafter's document-command payload
  // (the runtime's structured input); its reply is the drafter's edit
  // envelope, with no tool calls (the drafter emits its validated answer as
  // one text message).
  const edit = documentEditReply(structuredInput ?? message);
  if (edit !== null) return { keywords: [], toolCalls: [], response: edit };
  const lower = questionOf(message).toLowerCase();
  const selected = chatResponses.rows().find(r => r.keywords.some(keyword =>
    new RegExp(`(?:^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(lower))) ?? defaultResponse;
  if (selected.response !== 'Observability work summary') return selected;
  // Read the already registered fixture at request time. Importing its provider
  // here reverses the ESM bootstrap order through projects → agentcore.
  const rows = (fixtureRegistry.get('work-items')?.rows() as WorkItem[] | undefined ?? [])
    .filter(item => item.projectId === 'p-observability' && item.type !== 'epic');
  if (!rows.length) return { ...selected, response: 'There are no Observability work items in this demo scenario.' };
  const relevant = /dependency|outage|alert/.test(lower) ? rows.filter(item => /dependency|outage|alert/.test(`${item.title} ${item.blockedReason ?? ''}`.toLowerCase()))
    : /statsd|bridge|rollback|collector/.test(lower) ? rows.filter(item => /statsd|collector|sampling/.test(item.title.toLowerCase())) : rows;
  return { ...selected, response: `**Observability Platform**\n\n${(relevant.length ? relevant : rows).slice(0, 6).map(item =>
    `- **${item.key ?? item.title} — ${item.title}**: ${item.status.replace(/_/g, ' ')}${item.assigneeName ? ` · ${item.assigneeName}` : ''}.${item.blockedReason ? ` ${item.blockedReason}` : ''}`).join('\n')}\n\nReview the selected work item's acceptance criteria and capture the next decision in the initiative conversation.` };
}
