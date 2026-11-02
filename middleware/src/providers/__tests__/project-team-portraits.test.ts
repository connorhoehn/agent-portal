const send = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation(input => ({ input })),
}));
jest.mock('../aurora.js', () => ({ exec: jest.fn(), safeExec: jest.fn(), fetchAvatarsById: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false }, aurora: { clusterArn: 'cluster', secretArn: 'secret', database: 'orgiq' } } }));
import { fetchAvatarsById } from '../aurora.js';
import { listProjects } from '../projects.js';

const rows = (values: Record<string, string | number | null>[]) => ({
  columnMetadata: Object.keys(values[0] ?? {}).map(name => ({ name })),
  records: values.map(row => Object.values(row).map(value => value == null ? { isNull: true } : typeof value === 'number' ? { longValue: value } : { stringValue: value })),
});
beforeEach(() => { jest.clearAllMocks(); (fetchAvatarsById as jest.Mock).mockResolvedValue(new Map()); });

it('retains IDs, resolves photos in one batch, and never gives a namesake another photo', async () => {
  send.mockResolvedValueOnce(rows([
    { id: 'project-a', name: 'A', owner_id: 'p-a', owner_name: 'Alex', sme_people: JSON.stringify([{ personId: 'p-b', name: 'Alex' }, { personId: 'p-c', name: 'Name ||| with separator' }]), open_stories: 3 },
    { id: 'project-b', name: 'B', owner_id: 'p-a', owner_name: 'Alex', sme_people: null, open_stories: 2 },
  ]));
  (fetchAvatarsById as jest.Mock).mockResolvedValue(new Map([['p-a', '/a.jpg'], ['p-c', '/c.jpg']]));
  const projects = await listProjects({ limit: 100 });
  expect(fetchAvatarsById).toHaveBeenCalledTimes(1);
  expect(fetchAvatarsById).toHaveBeenCalledWith(['p-a', 'p-b', 'p-c']);
  expect(projects[0]?.team).toEqual([
    { personId: 'p-a', name: 'Alex', role: 'owner', avatarUrl: '/a.jpg' },
    { personId: 'p-b', name: 'Alex', role: 'sme', avatarUrl: null },
    { personId: 'p-c', name: 'Name ||| with separator', role: 'sme', avatarUrl: '/c.jpg' },
  ]);
  expect(projects[0]?.smeNames).toEqual(['Alex', 'Name ||| with separator']);
  expect(projects[0]?.openStories).toBe(3);
});

it('keeps rollups when no photos are available, and keeps the pre-rollup fallback usable', async () => {
  send.mockResolvedValueOnce(rows([{ id: 'a', name: 'A', owner_id: 'p-a', owner_name: 'Alex', open_stories: 4 }]));
  expect((await listProjects({}))[0]).toMatchObject({ openStories: 4, team: [{ personId: 'p-a', avatarUrl: null }] });
  send.mockRejectedValueOnce(new Error('owner_id does not exist')).mockResolvedValueOnce(rows([{ id: 'old', name: 'Legacy' }]));
  expect((await listProjects({}))[0]).toMatchObject({ id: 'old', team: [], ownerId: null, openStories: null });
});
