export const config = {
  port: parseInt(process.env['PORT'] ?? '3001', 10),
  mockMode: process.env['MOCK_MODE'] !== 'false' && !process.env['AGENTCORE_ENDPOINT'],
  agentcoreEndpoint: process.env['AGENTCORE_ENDPOINT'] ?? '',
  neptuneGraphId: process.env['NEPTUNE_GRAPH_ID'] ?? '',
  region: process.env['AWS_REGION'] ?? 'us-east-1',
} as const;
