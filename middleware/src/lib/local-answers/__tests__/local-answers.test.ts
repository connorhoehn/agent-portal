// The local data assistant over the dev:mock fixtures.
//
// The point of every figure assertion here: the answer's numbers are the
// Initiatives table's numbers for the same rows. Expected values are read from
// the providers the pages read (listProjects → the table, getProjectWorkItems →
// the Work tab, listSprints → the Sprints page) at test time — never typed — so
// a fixture change moves both sides together and a drift between them fails.

jest.mock('../../../providers/aurora.js', () => ({ exec: jest.fn(), safeExec: jest.fn(async () => []) }));
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {} } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => false) }));
jest.mock('../../mine.js', () => ({ mineViewer: jest.fn(async () => ({ userId: 'u-x', personId: mockPersonId })) }));

let mockPersonId: string | null = null;

import { answerLocally } from '../index.js';
import { matchIntent, initiativesNamed } from '../match.js';
import { budgetAnswer, sprintBehind, isBlocked, isOpen } from '../intents.js';
import { usd, pct } from '../format.js';
import { listProjects, type ProjectSummary } from '../../../providers/projects.js';
import { getProjectWorkItems } from '../../../providers/work-items.js';
import { listSprints } from '../../../providers/sprints.js';
import { getMaintenance30d } from '../../../providers/budgets.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { listFindings } from '../../../providers/org-sweeps.js';

type Who = Parameters<typeof answerLocally>[0]['session'];
const leader = { sub: 'u-release', tenant: 'orgiq', role: 'org-leader' } as Who;
const member = { sub: 'demo-user', tenant: 'orgiq', role: 'member' } as Who;
const ask = (question: string, session = leader, scope: Parameters<typeof answerLocally>[0]['scope'] = null) =>
  answerLocally({ question, scope, session });
const table = () => listProjects({ limit: 200 });
const burnOf = (p: ProjectSummary) => (p.allocatedUsd ? (p.agentSpendUsd ?? 0) / p.allocatedUsd : null);
const figure = (p: ProjectSummary) => `${usd(p.agentSpendUsd ?? 0)} of ${usd(p.allocatedUsd!)} (${pct(burnOf(p)!)})`;

afterEach(() => { fixtureRegistry.resetAll('default'); mockPersonId = null; });

describe('matching', () => {
  it.each([
    ['what project is over budget?', 'budget'],
    ['Which initiatives are near their allocation?', 'budget'],
    ['how much did Inference Platform spend this month?', 'spend'],
    ['which initiatives are blocked?', 'status'],
    ['what is critical?', 'status'],
    ['which projects are behind?', 'status'],
    ['who owns Auth Migration?', 'owners'],
    ["what's open on Observability Platform?", 'work'],
    ['how are the sprints going?', 'sprints'],
  ])('%s → %s', (q, intent) => {
    expect(matchIntent(q, null, /platform|migration/i.test(q))?.intent).toBe(intent);
  });

  it.each(['who knows auth best?', 'Who are the top contributors?', 'Show collaboration patterns', 'create a sprint for SOC2', 'Who helps?'])(
    'leaves %s to the agent', (q) => expect(matchIntent(q, null, false)).toBeNull());

  it('a scope makes an otherwise bare question local', () => {
    expect(matchIntent("what's blocked?", { kind: 'initiative', id: 'p-soc2' })?.intent).toBe('work');
    expect(matchIntent("what's blocked?", { kind: 'initiatives' })?.intent).toBe('status');
  });

  it('names initiatives by name, id or a distinctive first word', async () => {
    const all = await table();
    expect(initiativesNamed('is inference over?', all).map(p => p.id)).toEqual(['p-inference-platform']);
    expect(initiativesNamed('Design System API status', all).map(p => p.id)).toEqual(['p-design-system-api']);
    expect(initiativesNamed('what about design?', all)).toEqual([]);
  });
});

describe('budget — the budgets read tier sees the table\'s own figures', () => {
  it('over / closest / unbudgeted read exactly what the Initiatives table shows', async () => {
    const rows = await table();
    const a = (await ask('what project is over budget?', leader, { kind: 'initiatives' }))!;
    expect(a.intent).toBe('budget');
    for (const r of a.rows) {
      const p = rows.find(x => x.id === r['initiativeId'])!;
      expect(r['spendMtdUsd']).toBe(p.agentSpendUsd ?? 0);
      expect(r['allocatedUsd']).toBe(p.allocatedUsd);
      if (p.allocatedUsd != null) expect(r['maintenance30dUsd']).toBe((await getMaintenance30d(p.id)).costUsd);
    }
    const over = rows.filter(p => p.allocatedUsd != null && (p.agentSpendUsd ?? 0) > p.allocatedUsd);
    if (over.length === 0) {
      const closest = rows.filter(p => burnOf(p) != null).sort((x, y) => burnOf(y)! - burnOf(x)!)[0]!;
      expect(a.text).toMatch(/^No initiative is over its \w+ allocation; the closest is /);
      expect(a.text).toContain(`${closest.name} [1] at ${figure(closest)}`);
    } else {
      for (const p of over) expect(a.text).toContain(`${p.name} [`);
    }
    for (const p of rows.filter(x => x.allocatedUsd == null && (x.agentSpendUsd ?? 0) > 0)) {
      expect(a.text).toContain(p.name);
      expect(a.text).toContain(usd(p.agentSpendUsd ?? 0));
    }
    expect(a.records.every(r => r.type === 'initiative' && r.href === `/iq/projects/${r.id}`)).toBe(true);
  });

  it('an initiative scope answers for that initiative only', async () => {
    const p = (await table()).find(x => x.id === 'p-observability')!;
    const a = (await ask("what's over budget?", leader, { kind: 'initiative', id: p.id }))!;
    expect(a.rows).toHaveLength(1);
    expect(a.text).toContain(`${p.name} [1] is within its`);
    expect(a.text).toContain(figure(p));
    expect(a.text).toContain(`${usd(p.allocatedUsd! - (p.agentSpendUsd ?? 0))} left`);
  });

  it('says plainly when one is over, from the rows it is handed', () => {
    const base = { id: 'p-x', name: 'X', status: 'in_progress', ownerName: null, smeNames: [] } as unknown as ProjectSummary;
    const over = { ...base, agentSpendUsd: 12.5, allocatedUsd: 10 };
    const a = budgetAnswer({ match: { intent: 'budget', facets: { blocked: false, critical: false, behind: false } },
      viewer: { canReadBudgets: true, role: 'org-leader' }, asOf: new Date('2026-10-13T12:00:00Z'),
      initiatives: [over], initiativesCapped: false, focus: [] });
    expect(a.text).toMatch(/^1 initiative is over its October allocation: X \[1\] at \$12\.50 of \$10\.00 \(125%\)\./);
  });

  it('a member gets no dollar figures, and is told why', async () => {
    const a = (await ask('what project is over budget?', member, { kind: 'initiatives' }))!;
    expect(a.intent).toBe('budget');
    expect(a.text).not.toMatch(/\$\d/);
    expect(a.rows).toEqual([]);
    expect(a.text).toContain('budgets read tier');
    expect(a.text).toContain('signed in as member');
    expect(a.action).toMatchObject({ kind: 'request-access', itemId: 'capability:orgiq:budgets-read' });
    const spend = (await ask('how much did Inference Platform spend this month?', member))!;
    expect(spend.text).not.toMatch(/\$\d/);
  });

  it('ManageBudgets outside the named roles is the tier too', async () => {
    const { isAllowed } = jest.requireMock('../../authz.js') as { isAllowed: jest.Mock };
    isAllowed.mockResolvedValueOnce(true);
    const a = (await ask('what project is over budget?', { sub: 'u-x', tenant: 'orgiq', role: 'sme' } as Who))!;
    expect(a.text).toMatch(/\$\d/);
  });
});

describe('spend', () => {
  it('one initiative reads its table figure; the portfolio total is summed from rows', async () => {
    const rows = await table();
    const inf = rows.find(p => p.id === 'p-inference-platform')!;
    const one = (await ask('how much did Inference Platform spend this month?'))!;
    expect(one.text).toContain(`has spent ${usd(inf.agentSpendUsd ?? 0)} on agents so far in`);
    const all = (await ask('how much have the initiatives spent this month?'))!;
    const total = Math.round(rows.reduce((n, p) => n + Math.round((p.agentSpendUsd ?? 0) * 10_000), 0) / 100) / 100;
    expect(all.text).toContain(`is ${usd(total)} across`);
  });
});

describe('status', () => {
  it('critical is the table\'s priority badge', async () => {
    const rows = await table();
    const a = (await ask('which initiatives are critical?'))!;
    const critical = rows.filter(p => p.priority === 'critical');
    expect(a.rows.map(r => r['initiativeId']).sort()).toEqual(critical.map(p => p.id).sort());
  });

  it('blocked counts open work items with a blocked reason or label', async () => {
    const rows = await table();
    const a = (await ask('which initiatives are blocked?'))!;
    const expected: string[] = [];
    for (const p of rows) if ((await getProjectWorkItems(p.id)).some(w => isOpen(w) && isBlocked(w))) expected.push(p.id);
    expect(a.rows.map(r => r['initiativeId']).sort()).toEqual(expected.sort());
    if (!expected.length) expect(a.text).toContain('no open work item is blocked');
  });

  it('behind is judged from the sprint board at the given instant', async () => {
    const asOf = new Date('2026-10-12T12:00:00Z');
    const a = (await answerLocally({ question: 'which projects are behind?', scope: null, session: leader, asOf }))!;
    const sprints = await listSprints({ limit: 500 });
    expect(a.rows.map(r => r['sprintId']).sort()).toEqual(sprints.filter(s => sprintBehind(s, asOf)).map(s => s.id).sort());
  });
});

describe('owners and work', () => {
  it('who owns X names the table\'s owner', async () => {
    const p = (await table()).find(x => x.id === 'p-auth-migration')!;
    const a = (await ask('who owns Auth Migration?'))!;
    expect(a.intent).toBe('owners');
    expect(a.text).toContain(`${p.name} [1] is owned by ${p.ownerName}.`);
  });

  it("what's open on X lists the Work tab's open items", async () => {
    const open = (await getProjectWorkItems('p-observability')).filter(isOpen);
    const a = (await ask("what's open on Observability Platform?", member))!;
    expect(a.intent).toBe('work');
    expect(a.rows).toHaveLength(open.length);
    expect(a.text).toContain(`has ${open.length} open work item`);
    expect(a.records[0]).toMatchObject({ type: 'initiative', id: 'p-observability' });
    expect(a.records.slice(1).every(r => r.type === 'work' && r.href.startsWith('/iq/projects/p-observability?tab=work&item='))).toBe(true);
  });

  it('a work-item scope answers on that item\'s initiative', async () => {
    const item = (await getProjectWorkItems('p-observability')).find(isOpen)!;
    const a = (await ask("what's blocked?", member, { kind: 'work', id: item.id }))!;
    expect(a.intent).toBe('work');
    expect(a.records.some(r => r.type === 'work' && r.id === item.id)).toBe(true);
  });
});

describe('sprints', () => {
  it('the tier sees every active sprint with envelopes', async () => {
    const active = (await listSprints({ limit: 500 })).filter(s => s.status === 'active');
    const a = (await ask('how are the sprints going?'))!;
    expect(a.rows.map(r => r['sprintId']).sort()).toEqual(active.map(s => s.id).sort());
    expect(a.rows.every(r => 'grantedUsd' in r)).toBe(true);
  });

  it('"which sprints are behind?" lists only the behind ones', async () => {
    const asOf = new Date('2026-10-12T12:00:00Z');
    const behind = (await listSprints({ limit: 500 })).filter(s => sprintBehind(s, asOf));
    const a = (await answerLocally({ question: 'which sprints are behind?', scope: null, session: leader, asOf }))!;
    expect(a.intent).toBe('sprints');
    expect(a.rows.map(r => r['sprintId']).sort()).toEqual(behind.map(s => s.id).sort());
    expect(a.rows.every(r => r['behind'] === true)).toBe(true);
  });

  it('a member sees only their own sprints and no money', async () => {
    const a = (await ask('how are the sprints going?', member))!;
    expect(a.rows).toEqual([]);
    expect(a.text).toContain('No active sprint you steward, hold a grant on or have work in');
    expect(a.text).not.toMatch(/\$\d/);
  });
});

it('a question no intent matches is not answered locally', async () => {
  expect(await ask('who knows auth best?')).toBeNull();
  expect(await ask('summarize the auth migration postmortem')).toBeNull();
});

describe('single-threaded — the open bus-factor findings', () => {
  it.each(['where are we single-threaded', 'bus factor risks', 'knowledge held by only one person'])('%s', async q => {
    expect(matchIntent(q, null, false)?.intent).toBe('single-threaded');
    const open = await listFindings({ status: 'open', sweep: 'bus_factor', limit: 100 });
    const a = await ask(q);
    expect(a?.intent).toBe('single-threaded');
    expect(a!.rows).toHaveLength(open.length);
    expect(a!.text).toMatch(/single-threaded|bus-factor/i);
    for (const f of open) expect(a!.text).toContain(f.title);
  });
});
