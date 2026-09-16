// The canned answers `mockAgentCore.invokeAgent` streams back in dev:mock.
//
// This is a lookup table, not a metric surface, so the floor's first rule has
// nothing to bite on here. The second and fourth do: the table goes behind the
// registry so an auditor can ask what the chat looks like when the fleet has
// nothing to say — until now the only way to see the fall-through answer was
// to type a question none of the keyword sets matched and hope.

import { defineFixture } from './core/index.js';

export interface MockResponse {
  keywords: string[];
  toolCalls: Array<{ name: string; args: string; result: string }>;
  response: string;
}

function seedResponses(): MockResponse[] {
  return [
    {
      keywords: ['kubernetes', 'k8s', 'container'],
      toolCalls: [
        { name: 'query_graph', args: '{"sql": "SELECT p.name, p.expertise_score FROM people p JOIN person_skills ps ON ps.person_id = p.id JOIN skills s ON s.id = ps.skill_id WHERE LOWER(s.name) = \'kubernetes\' ORDER BY p.expertise_score DESC LIMIT 5"}', result: '3 people found with Kubernetes expertise' },
      ],
      response: `Based on the knowledge graph analysis, **Theo Chang** (Staff Engineer, Platform Engineering) is your top Kubernetes expert with an influence score of 89/100.\n\n**Top Kubernetes specialists:**\n\n1. **Theo Chang** — Staff Engineer, Platform Eng (Score: 89)\n   - Designed the current EKS cluster architecture\n   - Authored the service mesh migration guide\n   - Mentors 2 engineers on K8s topics\n\n2. **James Thompson** — SRE Lead, Platform Eng (Score: 74)\n   - Manages production cluster operations\n   - Built the incident response playbooks for K8s\n\n3. **Nora DaSilva** — Senior Engineer, Platform Eng (Score: 68)\n   - Contributed to the Kafka-on-K8s deployment\n   - Cross-team collaboration with Data Platform\n\n**Recommendation:** For Kubernetes architecture decisions, Theo Chang is the primary expert. For operational concerns, loop in James Thompson.`,
    },
    {
      keywords: ['auth', 'authentication', 'identity', 'login', 'sso'],
      // `search_knowledge_base`'s result used to be the bare string '4 relevant
      // documents found' — no URIs, so answerSources.ts's retrieval branch
      // (documentsFromResult) could extract nothing from it, and the answer's
      // own "Related Documents" prose named three documents ("Auth Migration
      // PRD", "Zero Trust Architecture Proposal", "Cognito Integration Guide")
      // that exist NOWHERE in this corpus — not in mock/knowledge-base.ts's
      // seeded rows, not on Confluence or a GitHub Wiki this product has no
      // integration with either. Demo-tested by asking "Who knows auth best?"
      // as a member: the chat rendered those three fabricated citations
      // un-linked, directly above a provenance line reading "knowledge base
      // searched — no documents matched" — the flagship answer to the
      // product's founding question contradicting its own honesty check.
      //
      // Fixed by shaping the result the way agents/search/main.py's real
      // `query_knowledge_base` actually does ({content, score, source: s3://…}
      // per result — see agents/search/main.py:116-123) and citing the two
      // documents mock/knowledge-base.ts actually seeds about the auth
      // migration project (`postmortem-p-auth-migration`,
      // `slack-p-auth-migration-00`) via `*Source: …*`, the pattern
      // answerSources.ts's readProse recognizes. routes/agents.ts's
      // annotateToolResult resolves each s3:// URI to its real `documents`
      // title server-side, same as it would for a live retrieval, so the
      // rendered chips read as "Postmortem: auth token cache invalidation
      // race (Auth Migration)" / "#proj-auth-migration — weighing two
      // competing library choices" rather than a filename.
      toolCalls: [
        {
          name: 'search_knowledge_base',
          args: '{"query": "authentication migration decisions"}',
          result: JSON.stringify([
            {
              content: 'Auth token cache invalidation race during the JWT + refresh-token migration — root cause and remediation.',
              score: 0.91,
              source: 's3://orgiq-documents-647757222309-us-east-1/synth/internal/postmortem/postmortem-p-auth-migration.md',
            },
            {
              content: 'Thread weighing two competing auth library choices for the migration off session-based auth.',
              score: 0.84,
              source: 's3://orgiq-documents-647757222309-us-east-1/synth/internal/slack/slack-p-auth-migration-00.md',
            },
          ]),
        },
        { name: 'query_graph', args: '{"sql": "SELECT p.name, d.topic, d.summary FROM people p JOIN decision_participants dp ON dp.person_id = p.id JOIN decisions d ON d.id = dp.decision_id WHERE d.topic ILIKE \'%auth%\'"}', result: '2 decisions found with 5 participants' },
      ],
      response: `I found relevant information about auth across documents and the knowledge graph.\n\n**Key Decisions:**\n\n1. **Auth Middleware Rewrite** (2026-03-15)\n   - Decision: Migrate from session-based to JWT + refresh tokens\n   - Participants: Theo Chang, Sarah Thompson, Sienna Garcia\n   - Status: In progress (Phase 2 of 3)\n\n2. **SSO Provider Selection** (2026-02-01)\n   - Decision: Adopt AWS Cognito with SAML federation\n   - Participants: Sarah Thompson, Sienna Garcia, Tara Chen\n   - Status: Completed\n\n**Subject Matter Experts:**\n- **Sarah Thompson** (Security Engineer) — Led the security assessment\n- **Theo Chang** — Implementing the middleware changes\n- **Sienna Garcia** — Executive sponsor\n\n*Sources: s3://orgiq-documents-647757222309-us-east-1/synth/internal/postmortem/postmortem-p-auth-migration.md, s3://orgiq-documents-647757222309-us-east-1/synth/internal/slack/slack-p-auth-migration-00.md*`,
    },
    {
      keywords: ['team', 'who', 'people', 'expert', 'find'],
      toolCalls: [
        { name: 'query_graph', args: '{"sql": "SELECT p.team AS department, COUNT(*) AS count, AVG(p.expertise_score) AS avg_influence FROM people p GROUP BY p.team"}', result: '4 departments, 24 people total' },
      ],
      response: `Here's an overview of your organization based on the knowledge graph:\n\n**Teams & Key People:**\n\n| Department | Headcount | Avg Influence | Top Expert |\n|---|---|---|---|\n| Platform Engineering | 7 | 71 | Theo Chang (89) |\n| Product | 5 | 61 | Tara Chen (91) |\n| Data Platform | 6 | 71 | Hiro Green (93) |\n| Design Systems | 5 | 62 | Henry Hassan (88) |\n\n**Cross-team Collaboration Hubs:**\n- Theo Chang ↔ Eli Garcia (Platform × Data)\n- Maria Johnson ↔ Tara Wright (Product × Design)\n- Marcus O'Brien ↔ Daniel Chang (Platform × Design)\n\n**Knowledge Silos Detected:**\n- ML/LLM expertise concentrated in Caleb Turner (Data Platform) — no redundancy\n- Accessibility knowledge isolated to Lena Dubois — bus factor risk\n\nWould you like me to dive deeper into any team or identify expertise gaps?`,
    },
    {
      keywords: ['score', 'rank', 'leaderboard', 'influence', 'top'],
      toolCalls: [
        { name: 'compute_pagerank', args: '{"metric": "influence", "limit": 5}', result: 'PageRank computed for 24 nodes' },
      ],
      response: `**Influence Leaderboard** (based on PageRank + betweenness centrality):\n\n| # | Name | Department | Composite Score |\n|---|---|---|---|\n| 1 | Hiro Green | Data Platform | 89 |\n| 2 | Tara Chen | Product | 81 |\n| 3 | Theo Chang | Platform Eng | 85 |\n| 4 | Henry Hassan | Design Systems | 82 |\n| 5 | Eli Garcia | Data Platform | 85 |\n\n**Scoring Methodology:**\n- PageRank (40%): Network centrality in collaboration graph\n- Betweenness (20%): Bridge between different clusters\n- Expertise depth (20%): Skill breadth × document contributions\n- Velocity (10%): Recent activity recency\n- Quality (10%): Peer feedback signals\n\n**Notable Trends:**\n- Hiro Green's influence grew 12% this quarter due to cross-team mentoring\n- Ingestion agent detected 3 new collaboration edges for Eli Garcia this week`,
    },
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
 */
const defaultResponse: MockResponse = {
  keywords: [],
  toolCalls: [
    { name: 'search_knowledge_base', args: '{"query": "user query"}', result: '2 documents found' },
  ],
  response: `I searched the knowledge base and graph for relevant information.\n\nBased on available data, I can help you explore:\n- **People & expertise** — "Who knows X best?"\n- **Decisions & context** — "What was decided about Y?"\n- **Team dynamics** — "Show collaboration patterns"\n- **Scores & rankings** — "Who are the top contributors?"\n\nCould you provide more specifics about what you're looking for? I can search across documents, the organizational graph, and historical decisions.`,
};

export function selectMockResponse(message: string): MockResponse {
  const lower = message.toLowerCase();
  return chatResponses.rows().find((r) => r.keywords.some((k) => lower.includes(k))) ?? defaultResponse;
}
