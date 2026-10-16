// The assessment and access fixed-fact answers (docs/user-search-goal.md S4).
// Facts are computed from the fixtures at request time, so these tests derive
// their expectations from the same providers instead of naming a title.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
import { fixtureRegistry } from '../../../mock/core/index.js';
import { listExceptions, listSubmissions, listTeams } from '../../../providers/assessment.js';
import { __resetSearchIndex } from '../../search-index/registry.js';
import { answerTenant } from '../index.js';

const asha = { sub: 'u-asha', tenant: 'assessment', role: 'assessor' };
const jonas = { sub: 'u-jonas', tenant: 'assessment', role: 'lead-assessor' };
const omar = { sub: 'u-omar', tenant: 'access', role: 'approver' };
const priya = { sub: 'u-priya', tenant: 'access', role: 'access-admin' };
const rhea = { sub: 'u-rhea', tenant: 'access', role: 'requester' };

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

const ask = (tenant: 'assessment' | 'access', who: { sub: string; tenant: string; role: string }, q: string) => answerTenant(tenant, who, q);

describe('assessment', () => {
  test('teams without a lead: the count and names come from the team rows', async () => {
    const teams = await listTeams();
    const bare = teams.filter(t => !t.assessment_lead?.trim());
    for (const q of ['teams without a lead', 'unassigned teams', 'which teams have no lead', 'show unassigned teams']) {
      const a = await ask('assessment', asha, q);
      expect(a?.intent).toBe('assessment:unassigned-teams');
      if (bare.length) for (const t of bare) expect(a!.text).toContain(t.name);
      else expect(a!.text).toMatch(new RegExp(`Every team has an assessment lead.*${teams.length}`));
      expect(a!.records.map(r => r.id).sort()).toEqual(bare.map(t => t.id).sort());
    }
  });

  test('who approved an exception names the approver the team row holds, and says so when undecided', async () => {
    const team = (await listTeams()).find(t => t.name.startsWith('Northstar'))!;
    const rows = (await listExceptions(team.id))?.exceptions ?? [];
    const decided = rows.find(x => x.status !== 'requested' && x.approved_by)!;
    for (const q of ['who approved the security testing exception for Northstar', 'who approved the TEAM-001 N/A', 'approver of Northstar dimension 6 exception']) {
      const a = await ask('assessment', asha, q);
      expect(a?.intent).toBe('assessment:who-approved-exception');
      expect(a!.text).toContain(decided.approved_by);
    }
    const pending = await ask('assessment', asha, `who approved the Northstar dimension 7 exception`);
    expect(pending!.text).toMatch(/has not been decided yet/);
  });

  test('open exceptions list what waits, not what is decided', async () => {
    const team = (await listTeams()).find(t => t.name.startsWith('Northstar'))!;
    const waiting = ((await listExceptions(team.id))?.exceptions ?? []).filter(x => x.status === 'requested');
    const a = await ask('assessment', jonas, 'which exceptions need approval');
    expect(a?.intent).toBe('assessment:open-exceptions');
    expect(a!.records.length).toBeGreaterThanOrEqual(waiting.length);
    for (const q of ['open exception reviews', 'pending N/A exceptions']) expect((await ask('assessment', jonas, q))?.intent).toBe('assessment:open-exceptions');
  });

  test('staged submissions are the staged envelopes', async () => {
    const all = await listSubmissions();
    const staged = (all.envelopes ?? []).filter((e: { status: string }) => e.status === 'staged');
    for (const q of ['staged submissions', 'submissions not committed', 'show staged submissions']) {
      const a = await ask('assessment', jonas, q);
      expect(a?.intent).toBe('assessment:staged-submissions');
      expect(a!.records).toHaveLength(staged.length);
    }
  });

  test('an answered question is found by what the answer said; an unrelated phrase answers nothing', async () => {
    const a = await ask('assessment', jonas, 'what did Sam Okafor confirm');
    expect(a?.intent).toBe('assessment:answered-question');
    expect(a!.text).toMatch(/Sam Okafor/);
    expect((await ask('assessment', jonas, 'answered questions about deploys'))?.intent).toBe('assessment:answered-question');
    expect(await ask('assessment', jonas, 'quarterly zebra budget')).toBeNull();
  });

  test('a standards document is found by its name', async () => {
    for (const q of ['N/A exception policy', 'what counts as evidence', 'CI/CD standards']) {
      const a = await ask('assessment', asha, q);
      expect(a?.intent).toBe('assessment:standard-doc');
      expect(a!.records.length).toBeGreaterThan(0);
    }
  });
});

describe('access', () => {
  test('sensitive items are the catalog rows flagged sensitive', async () => {
    for (const q of ['sensitive roles', 'which roles need extra approval', 'show sensitive']) {
      const a = await ask('access', rhea, q);
      expect(a?.intent).toBe('access:sensitive-items');
      expect(a!.records.length).toBeGreaterThan(0);
      expect(a!.text).toMatch(/sensitive/);
    }
  });

  test("a report's requests and my reports' requests", async () => {
    const a = await ask('access', omar, "Rhea's requests");
    expect(a?.intent).toBe('access:report-requests');
    expect(a!.text).toMatch(/Rhea Castellanos has \d+ requests?/);
    expect((await ask('access', omar, 'what has Rhea asked for'))?.records.length).toBe(a!.records.length);
    const mine = await ask('access', omar, 'requests from my reports');
    expect(mine?.intent).toBe('access:report-requests');
    expect(mine!.text).toMatch(/^Your reports have/);
    // a requester has no reports: nothing is claimed about people she cannot open
    expect((await ask('access', rhea, 'requests from my reports'))!.text).toMatch(/no requests/);
  });

  test('policy overrides say none when the audit trail holds none', async () => {
    for (const q of ['overrides in the audit log', 'show override events', 'policy overrides']) {
      const a = await ask('access', priya, q);
      expect(a?.intent).toBe('access:policy-overrides');
      expect(a!.text).toMatch(/override/);
    }
  });

  test('a question no intent recognises answers null', async () => {
    expect(await ask('access', priya, 'zebra quarterly budget')).toBeNull();
    expect(await ask('access', priya, '')).toBeNull();
  });
});

describe('access: my requests', () => {
  test('a requester asks about her own requests by state, id and item; the facts are the request rows', async () => {
    const open = await ask('access', rhea, 'what am I waiting on');
    expect(open?.intent).toBe('access:my-requests');
    expect(open!.records.length).toBeGreaterThan(0);
    for (const q of ['my pending access requests', 'my open requests']) expect((await ask('access', rhea, q))!.records.map(r => r.id)).toEqual(open!.records.map(r => r.id));
    const rejected = await ask('access', rhea, 'why was my org leader request rejected');
    expect(rejected!.records).toHaveLength(1);
    expect(rejected!.text).toMatch(/rejected/i);
    expect((await ask('access', rhea, 'rejected requests'))!.records.map(r => r.id)).toEqual(rejected!.records.map(r => r.id));
    const withdrawn = await ask('access', rhea, 'requests I withdrew');
    expect(withdrawn!.records.length).toBeGreaterThan(0);
    expect((await ask('access', rhea, 'my moderator request'))!.records.map(r => r.id)).toEqual(withdrawn!.records.map(r => r.id));
    const one = await ask('access', rhea, `status of ${open!.records[0]!.id}`);
    expect(one!.records.map(r => r.id)).toEqual([open!.records[0]!.id]);
    expect((await ask('access', rhea, 'where is my auth migration request'))!.records).toHaveLength(1);
  });

  test('an id the reader cannot open is said so, never guessed', async () => {
    expect((await ask('access', rhea, 'status of req-9999'))!.text).toMatch(/No request req-9999/);
  });
});
