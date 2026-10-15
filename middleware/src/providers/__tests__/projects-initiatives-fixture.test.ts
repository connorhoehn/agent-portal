// The initiatives fixture (mock/initiatives.ts) and the numbers read off it.
//
// What is pinned:
//   * `activeAgentRuns` is COUNTED from `running` bot_runs rows, not typed —
//     the fixture used to carry `activeAgents: 2` for Observability over a run
//     table with no running row, so the rail said "2 agents" while the Agents
//     tab, the active-runs badge and the concurrency ceiling saw nothing. Now
//     finishing a run moves the number and a new dispatch moves it back,
//   * every other initiative reads 0 ("Idle"), because only Observability has
//     in-flight rows (decision D3),
//   * the list and the detail read ONE number for one initiative,
//   * `empty` means no initiatives AND no initiative exists (404-able), and
//     `error` throws "does not exist" rather than rendering as empty,
//   * a linked person on no initiative (u-release → p-005) gets an empty Mine.

jest.mock('../aurora.js', () => ({ exec: jest.fn(), safeExec: jest.fn(async () => []) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { listProjects, getProject, mockProjectExists, mockProjectName, mockActiveAgentRuns } from '../projects.js';
import { countRunningRuns, finalizeBotRun, createBotRun, listActiveRuns, listMarketplaceRuns } from '../bots.js';
import { initiatives } from '../../mock/initiatives.js';
import { botRuns } from '../../mock/bots.js';
import { fixtureRegistry } from '../../mock/core/index.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('initiatives fixture — default', () => {
  it('serves the fourteen seeded initiatives, count read from rows', async () => {
    const list = await listProjects({ limit: 200 });
    expect(list).toHaveLength(initiatives.rows().length);
    expect(new Set(list.map((p) => p.id))).toEqual(new Set(initiatives.rows().map((p) => p.id)));
  });

  it('carries no typed live-agent count on a row', () => {
    for (const row of initiatives.rows()) {
      expect(row).not.toHaveProperty('activeAgents');
      expect(row).not.toHaveProperty('activeHoursAgo');
    }
  });

  it('counts Observability\'s two in-flight marketplace runs and reads every other initiative Idle', async () => {
    const running = botRuns.rows().filter((r) => r.status === 'running');
    expect(running).toHaveLength(2);
    const list = await listProjects({ limit: 200 });
    for (const p of list) {
      expect(p.activeAgentRuns).toBe(p.id === 'p-observability' ? 2 : 0);
    }
  });

  it('moves the count when a run finishes and when a new one is dispatched', async () => {
    await finalizeBotRun('run-inflight-obs-e1-s3', { status: 'done', costUsd: 0.12 });
    expect(mockActiveAgentRuns('p-observability')).toBe(1);

    await createBotRun({ botId: null, trigger: 'marketplace', workItemId: 'wi-obs-e1-s3' });
    expect(mockActiveAgentRuns('p-observability')).toBe(2);
  });

  it('agrees between list and detail for every initiative', async () => {
    for (const row of await listProjects({ limit: 200 })) {
      const detail = await getProject(row.id);
      expect(detail?.activeAgentRuns).toBe(row.activeAgentRuns);
      expect(detail?.allocatedUsd).toBe(row.allocatedUsd);
      expect(detail?.agentSpendUsd).toBe(row.agentSpendUsd);
    }
  });

  it('lets the seeded runs reach every fleet-wide reader, as one bot_runs table would', async () => {
    // The global concurrency ceiling counts them (2 of 3), so a third dispatch fits…
    expect(await countRunningRuns()).toBe(2);
    expect(await createBotRun({ botId: null, trigger: 'marketplace', workItemId: 'wi-obs-e1-b5', ceiling: 3 })).not.toBeNull();
    // …and a fourth is refused.
    expect(await createBotRun({ botId: null, trigger: 'marketplace', workItemId: 'wi-obs-e1-b5', ceiling: 3 })).toBeNull();
    fixtureRegistry.resetAll('default');

    const active = await listActiveRuns();
    expect(active.map((r) => r.workItemId).sort()).toEqual(['wi-obs-e1-b5', 'wi-obs-e1-s3']);
    const market = await listMarketplaceRuns('p-observability');
    // Two in flight, plus the two dispatches that already finished this month.
    expect(market.filter((r) => r.status === 'running')).toHaveLength(2);
    expect(market).toHaveLength(4);
    // Auth Migration's envelope holder has spent against it too (all finished).
    const auth = await listMarketplaceRuns('p-auth-migration');
    expect(auth).toHaveLength(4);
    expect(auth.every((r) => r.status === 'done')).toBe(true);
  });

  it('does not let a cost-less in-flight run move the initiative\'s last activity', async () => {
    // Aurora's last_agent_activity_at predicate starts `cost_usd IS NOT NULL`.
    const [obs] = await listProjects({ limit: 200 }).then((l) => l.filter((p) => p.id === 'p-observability'));
    const inFlightStarts = botRuns.rows().filter((r) => r.status === 'running').map((r) => r.startedAt);
    expect(inFlightStarts).not.toContain(obs!.lastAgentActivityAt);
  });

  it('gives a linked person on no initiative an empty Mine', async () => {
    expect(await listProjects({ mineOnly: true, personId: 'p-005' })).toEqual([]);
    const nora = await listProjects({ mineOnly: true, personId: 'p-004' });
    expect(nora.map((p) => p.id).sort()).toEqual(['p-auth-migration', 'p-observability']);
  });
});

describe('initiatives fixture — empty', () => {
  beforeEach(() => fixtureRegistry.resetAll('empty'));

  it('lists nothing and treats every id as absent', async () => {
    expect(await listProjects({ limit: 200 })).toEqual([]);
    expect(mockProjectExists('p-observability')).toBe(false);
    expect(mockProjectName('p-observability')).toBeNull();
    expect(await getProject('p-observability')).toBeNull();
  });
});

describe('initiatives fixture — error', () => {
  beforeEach(() => fixtureRegistry.resetAll('error'));

  it('fails the list and the detail loudly instead of reading as empty', async () => {
    await expect(listProjects({ limit: 200 })).rejects.toThrow(/does not exist/);
    await expect(getProject('p-observability')).rejects.toThrow(/does not exist/);
  });
});
