export interface IngestSource {
  id: string;
  name: string;
  type: 'confluence' | 'jira' | 'slack' | 's3' | 'github';
  status: 'active' | 'configured' | 'syncing' | 'error';
  lastSync: string | null;
  documentCount: number;
  errorCount: number;
  nextSync: string | null;
}

export const mockIngestSources: IngestSource[] = [
  {
    id: 'src-001',
    name: 'Engineering Confluence',
    type: 'confluence',
    status: 'active',
    lastSync: '2026-05-08T09:15:00Z',
    documentCount: 1247,
    errorCount: 3,
    nextSync: '2026-05-08T15:15:00Z',
  },
  {
    id: 'src-002',
    name: 'Jira (Platform Team)',
    type: 'jira',
    status: 'active',
    lastSync: '2026-05-08T08:00:00Z',
    documentCount: 3842,
    errorCount: 0,
    nextSync: '2026-05-08T14:00:00Z',
  },
  {
    id: 'src-003',
    name: 'Meeting Transcripts',
    type: 's3',
    status: 'syncing',
    lastSync: '2026-05-07T22:00:00Z',
    documentCount: 589,
    errorCount: 0,
    nextSync: null,
  },
  {
    id: 'src-004',
    name: 'Slack (Public Channels)',
    type: 'slack',
    status: 'configured',
    lastSync: null,
    documentCount: 0,
    errorCount: 0,
    nextSync: null,
  },
  {
    id: 'src-005',
    name: 'GitHub PRs & Discussions',
    type: 'github',
    status: 'active',
    lastSync: '2026-05-08T10:30:00Z',
    documentCount: 2156,
    errorCount: 1,
    nextSync: '2026-05-08T16:30:00Z',
  },
];

export const mockIngestStats = {
  totalDocuments: 7834,
  activeSyncs: 1,
  dlqItems: 4,
  documentsLast24h: 127,
  avgProcessingMs: 2340,
};
