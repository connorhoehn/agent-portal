interface MockResponse {
  keywords: string[];
  toolCalls: Array<{ name: string; args: string; result: string }>;
  response: string;
}

const responses: MockResponse[] = [
  {
    keywords: ['kubernetes', 'k8s', 'container'],
    toolCalls: [
      { name: 'query_graph', args: '{"sql": "SELECT p.name, p.expertise_score FROM people p JOIN person_skills ps ON ps.person_id = p.id JOIN skills s ON s.id = ps.skill_id WHERE LOWER(s.name) = \'kubernetes\' ORDER BY p.expertise_score DESC LIMIT 5"}', result: '3 people found with Kubernetes expertise' },
    ],
    response: `Based on the knowledge graph analysis, **Alex Chen** (Staff Engineer, Platform Engineering) is your top Kubernetes expert with an influence score of 89/100.\n\n**Top Kubernetes specialists:**\n\n1. **Alex Chen** — Staff Engineer, Platform Eng (Score: 89)\n   - Designed the current EKS cluster architecture\n   - Authored the service mesh migration guide\n   - Mentors 2 engineers on K8s topics\n\n2. **Ben Foster** — SRE Lead, Platform Eng (Score: 74)\n   - Manages production cluster operations\n   - Built the incident response playbooks for K8s\n\n3. **Priya Patel** — Senior Engineer, Platform Eng (Score: 68)\n   - Contributed to the Kafka-on-K8s deployment\n   - Cross-team collaboration with Data Platform\n\n**Recommendation:** For Kubernetes architecture decisions, Alex Chen is the primary expert. For operational concerns, loop in Ben Foster.`,
  },
  {
    keywords: ['auth', 'authentication', 'identity', 'login', 'sso'],
    toolCalls: [
      { name: 'search_knowledge_base', args: '{"query": "authentication migration decisions"}', result: '4 relevant documents found' },
      { name: 'query_graph', args: '{"sql": "SELECT p.name, d.topic, d.summary FROM people p JOIN decision_participants dp ON dp.person_id = p.id JOIN decisions d ON d.id = dp.decision_id WHERE d.topic ILIKE \'%auth%\'"}', result: '2 decisions found with 5 participants' },
    ],
    response: `I found relevant information about auth across documents and the knowledge graph.\n\n**Key Decisions:**\n\n1. **Auth Middleware Rewrite** (2026-03-15)\n   - Decision: Migrate from session-based to JWT + refresh tokens\n   - Participants: Alex Chen, Sophie Turner, David Kim\n   - Status: In progress (Phase 2 of 3)\n\n2. **SSO Provider Selection** (2026-02-01)\n   - Decision: Adopt AWS Cognito with SAML federation\n   - Participants: Sophie Turner, David Kim, Nina Kowalski\n   - Status: Completed\n\n**Subject Matter Experts:**\n- **Sophie Turner** (Security Engineer) — Led the security assessment\n- **Alex Chen** — Implementing the middleware changes\n- **David Kim** — Executive sponsor\n\n**Related Documents:**\n- "Auth Migration PRD" (Confluence, last updated 2026-04-28)\n- "Zero Trust Architecture Proposal" (Confluence)\n- "Cognito Integration Guide" (GitHub Wiki)`,
  },
  {
    keywords: ['team', 'who', 'people', 'expert', 'find'],
    toolCalls: [
      { name: 'query_graph', args: '{"sql": "SELECT p.team AS department, COUNT(*) AS count, AVG(p.expertise_score) AS avg_influence FROM people p GROUP BY p.team"}', result: '4 departments, 24 people total' },
    ],
    response: `Here's an overview of your organization based on the knowledge graph:\n\n**Teams & Key People:**\n\n| Department | Headcount | Avg Influence | Top Expert |\n|---|---|---|---|\n| Platform Engineering | 7 | 71 | Alex Chen (89) |\n| Product | 5 | 61 | Nina Kowalski (91) |\n| Data Platform | 6 | 71 | Raj Mehta (93) |\n| Design Systems | 5 | 62 | Diana Martinez (88) |\n\n**Cross-team Collaboration Hubs:**\n- Alex Chen ↔ Carlos Rivera (Platform × Data)\n- Sarah Johnson ↔ Olivia Park (Product × Design)\n- James Wright ↔ Jordan Lee (Platform × Design)\n\n**Knowledge Silos Detected:**\n- ML/LLM expertise concentrated in Ahmed Hassan (Data Platform) — no redundancy\n- Accessibility knowledge isolated to Kevin Nguyen — bus factor risk\n\nWould you like me to dive deeper into any team or identify expertise gaps?`,
  },
  {
    keywords: ['score', 'rank', 'leaderboard', 'influence', 'top'],
    toolCalls: [
      { name: 'compute_pagerank', args: '{"metric": "influence", "limit": 5}', result: 'PageRank computed for 24 nodes' },
    ],
    response: `**Influence Leaderboard** (based on PageRank + betweenness centrality):\n\n| # | Name | Department | Composite Score |\n|---|---|---|---|\n| 1 | Raj Mehta | Data Platform | 89 |\n| 2 | Nina Kowalski | Product | 81 |\n| 3 | Alex Chen | Platform Eng | 85 |\n| 4 | Diana Martinez | Design Systems | 82 |\n| 5 | Carlos Rivera | Data Platform | 85 |\n\n**Scoring Methodology:**\n- PageRank (40%): Network centrality in collaboration graph\n- Betweenness (20%): Bridge between different clusters\n- Expertise depth (20%): Skill breadth × document contributions\n- Velocity (10%): Recent activity recency\n- Quality (10%): Peer feedback signals\n\n**Notable Trends:**\n- Raj Mehta's influence grew 12% this quarter due to cross-team mentoring\n- Ingestion agent detected 3 new collaboration edges for Carlos Rivera this week`,
  },
];

const defaultResponse: MockResponse = {
  keywords: [],
  toolCalls: [
    { name: 'search_knowledge_base', args: '{"query": "user query"}', result: '2 documents found' },
  ],
  response: `I searched the knowledge base and graph for relevant information.\n\nBased on available data, I can help you explore:\n- **People & expertise** — "Who knows X best?"\n- **Decisions & context** — "What was decided about Y?"\n- **Team dynamics** — "Show collaboration patterns"\n- **Scores & rankings** — "Who are the top contributors?"\n\nCould you provide more specifics about what you're looking for? I can search across documents, the organizational graph, and historical decisions.`,
};

export function selectMockResponse(message: string): MockResponse {
  const lower = message.toLowerCase();
  return responses.find(r => r.keywords.some(k => lower.includes(k))) ?? defaultResponse;
}
