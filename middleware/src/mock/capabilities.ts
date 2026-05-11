export const mockGuardrail = {
  id: 'gr-mock-001',
  name: 'orgiq-guardrail',
  status: 'READY',
  version: '1',
  updatedAt: new Date(Date.now() - 86400000).toISOString(),
  piiFilters: [
    { type: 'EMAIL', action: 'ANONYMIZE', enabled: true },
    { type: 'PHONE', action: 'ANONYMIZE', enabled: true },
    { type: 'SSN', action: 'BLOCK', enabled: true },
    { type: 'NAME', action: 'ANONYMIZE', enabled: false },
  ],
  contentPolicy: {
    hateEnabled: true,
    violenceEnabled: true,
    sexualEnabled: true,
    insultsEnabled: true,
    misconductEnabled: true,
    promptAttackEnabled: true,
  },
  deniedTopics: [
    { name: 'Competitor Analysis', definition: 'Requests about specific competitor products', enabled: true },
    { name: 'Salary Disclosure', definition: 'Requests to reveal individual salary information', enabled: true },
    { name: 'Legal Advice', definition: 'Requests for legal counsel or binding legal opinions', enabled: false },
  ],
  groundingThreshold: 0.75,
  relevanceThreshold: 0.70,
};

export interface CodeSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
  startedAt: string;
  lastActivityAt: string;
  executionCount: number;
  lastCode: string;
  lastOutput: string;
  memoryUsageMb: number;
}

export const mockCodeSessions: CodeSession[] = [
  {
    sessionId: 'cs-a1b2c3d4',
    agentName: 'graph-builder',
    status: 'ACTIVE',
    startedAt: new Date(Date.now() - 300000).toISOString(),
    lastActivityAt: new Date(Date.now() - 15000).toISOString(),
    executionCount: 7,
    lastCode: 'import json\nentities = extract_ner(doc_text)\nprint(json.dumps(entities, indent=2))',
    lastOutput: '{"people": ["Alice Smith", "Bob Jones"], "skills": ["Kubernetes", "Python"]}',
    memoryUsageMb: 128,
  },
  {
    sessionId: 'cs-e5f6g7h8',
    agentName: 'scoring',
    status: 'IDLE',
    startedAt: new Date(Date.now() - 900000).toISOString(),
    lastActivityAt: new Date(Date.now() - 420000).toISOString(),
    executionCount: 3,
    lastCode: 'pagerank = compute_pagerank(graph, damping=0.85, iterations=20)\nprint(sorted(pagerank.items(), key=lambda x: -x[1])[:10])',
    lastOutput: "[('alice_smith', 0.89), ('bob_jones', 0.73), ('carol_wu', 0.61)]",
    memoryUsageMb: 64,
  },
];

export interface BrowserSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  startedAt: string;
  lastActivityAt: string;
  currentUrl: string;
  pageTitle: string;
  requestCount: number;
  profileId: string;
}

export const mockBrowserSessions: BrowserSession[] = [
  {
    sessionId: 'bs-m1n2o3p4',
    agentName: 'search',
    status: 'ACTIVE',
    startedAt: new Date(Date.now() - 120000).toISOString(),
    lastActivityAt: new Date(Date.now() - 5000).toISOString(),
    currentUrl: 'https://linkedin.com/in/alice-smith',
    pageTitle: 'Alice Smith | LinkedIn',
    requestCount: 12,
    profileId: 'bp-default',
  },
  {
    sessionId: 'bs-q5r6s7t8',
    agentName: 'advisor',
    status: 'IDLE',
    startedAt: new Date(Date.now() - 600000).toISOString(),
    lastActivityAt: new Date(Date.now() - 300000).toISOString(),
    currentUrl: 'about:blank',
    pageTitle: '',
    requestCount: 4,
    profileId: 'bp-default',
  },
];
