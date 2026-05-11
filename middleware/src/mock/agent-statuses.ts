export interface AgentDef {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'deploying';
  protocol: 'ag-ui' | 'a2a';
  model: string;
  tools: string[];
  guardrails: string[];
  endpoint: string;
  latencyP50Ms: number;
  latencyP99Ms: number;
  invocationsLast24h: number;
  errorsLast24h: number;
  tokensLast24h: number;
}

export const mockAgents: AgentDef[] = [
  {
    id: 'orgiq-supervisor',
    name: 'Supervisor',
    status: 'healthy',
    protocol: 'ag-ui',
    model: 'nova-pro-v1',
    tools: ['route_to_agent', 'synthesize_responses'],
    guardrails: ['pii-filter', 'content-policy'],
    endpoint: 'https://runtime.agentcore.us-east-1.amazonaws.com/orgiq-supervisor',
    latencyP50Ms: 1200,
    latencyP99Ms: 4500,
    invocationsLast24h: 847,
    errorsLast24h: 3,
    tokensLast24h: 245000,
  },
  {
    id: 'orgiq-search',
    name: 'Search',
    status: 'healthy',
    protocol: 'a2a',
    model: 'nova-pro-v1',
    tools: ['search_knowledge_base', 'query_graph', 'vector_search'],
    guardrails: ['pii-filter', 'grounding'],
    endpoint: 'https://runtime.agentcore.us-east-1.amazonaws.com/orgiq-search',
    latencyP50Ms: 890,
    latencyP99Ms: 3200,
    invocationsLast24h: 1523,
    errorsLast24h: 7,
    tokensLast24h: 412000,
  },
  {
    id: 'orgiq-scoring',
    name: 'Scoring',
    status: 'healthy',
    protocol: 'a2a',
    model: 'nova-lite-v1',
    tools: ['compute_pagerank', 'calculate_centrality', 'update_scores'],
    guardrails: ['content-policy'],
    endpoint: 'https://runtime.agentcore.us-east-1.amazonaws.com/orgiq-scoring',
    latencyP50Ms: 650,
    latencyP99Ms: 2100,
    invocationsLast24h: 312,
    errorsLast24h: 0,
    tokensLast24h: 87000,
  },
  {
    id: 'orgiq-advisor',
    name: 'Advisor',
    status: 'healthy',
    protocol: 'a2a',
    model: 'nova-pro-v1',
    tools: ['analyze_graph_patterns', 'identify_gaps', 'recommend_pairings'],
    guardrails: ['pii-filter', 'content-policy', 'grounding'],
    endpoint: 'https://runtime.agentcore.us-east-1.amazonaws.com/orgiq-advisor',
    latencyP50Ms: 2100,
    latencyP99Ms: 6800,
    invocationsLast24h: 156,
    errorsLast24h: 2,
    tokensLast24h: 198000,
  },
  {
    id: 'orgiq-ingestion',
    name: 'Ingestion',
    status: 'degraded',
    protocol: 'a2a',
    model: 'nova-lite-v1',
    tools: ['process_document', 'extract_entities', 'trigger_graph_builder'],
    guardrails: ['content-policy'],
    endpoint: 'https://runtime.agentcore.us-east-1.amazonaws.com/orgiq-ingestion',
    latencyP50Ms: 3400,
    latencyP99Ms: 12000,
    invocationsLast24h: 89,
    errorsLast24h: 12,
    tokensLast24h: 156000,
  },
  {
    id: 'orgiq-graph-builder',
    name: 'Graph Builder',
    status: 'healthy',
    protocol: 'a2a',
    model: 'nova-lite-v1',
    tools: ['merge_nodes', 'merge_edges', 'generate_embeddings', 'validate_schema'],
    guardrails: ['content-policy'],
    endpoint: 'https://runtime.agentcore.us-east-1.amazonaws.com/orgiq-graph-builder',
    latencyP50Ms: 1800,
    latencyP99Ms: 7500,
    invocationsLast24h: 67,
    errorsLast24h: 1,
    tokensLast24h: 134000,
  },
];
