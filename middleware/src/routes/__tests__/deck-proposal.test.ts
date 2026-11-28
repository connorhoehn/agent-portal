// The composer's operations mode (lib/deck-shared/propose.ts) through the
// initiative tenant's deck routes: a proposal is validated and never saved,
// Apply saves it through the operations route, a refused list says why, and
// the money hold never leaks (booked on an answer, released on a throw, absent
// on a refused spend).

// Sessions here are hand-built (no directory rows): the deck write rule's fresh
// directory re-read (live-principal.ts) is the identity, its Cedar decisions stay real.
jest.mock('../../lib/live-principal.js', () => ({
  ...jest.requireActual('../../lib/live-principal.js'),
  currentLiveSession: async (session: unknown) => session,
}));
// Who is on the initiative (sweep 11): the org-wide roles everywhere, every
// other hand-built session on PID only, and `u-off` on nothing.
jest.mock('../../lib/initiative-scope.js', () => ({
  ...jest.requireActual('../../lib/initiative-scope.js'),
  stewardsInitiative: async (session: { sub?: string; role?: string } | null, id: string) =>
    ['org-leader', 'hr-admin', 'admin'].includes(session?.role ?? '') || (id === 'p-auth-migration' && !!session?.sub && session.sub !== 'u-off'),
}));
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
// The money chokepoint, observed: a hold before the call, a booked row after it, a release when the call throws.
jest.mock('../../lib/agent-invoke-spend.js', () => ({
  holdAgentInvoke: jest.fn(async () => ({ kind: 'held', holdId: 'hold-1' })),
  recordAgentInvoke: jest.fn(async () => undefined),
  releaseAgentInvokeHold: jest.fn(async () => undefined),
  usageFromEvent: () => null,
}));
// The seed matrix for the two actions these routes ask (member: none; sme: dispatch
// but no budgets; program-owner / org-leader / hr-admin: both; admin: wildcard).
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['Search'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['Search', 'DispatchAgentRun', 'ManageSprints'] },
    { id: 'program-owner', tenant: 'orgiq', label: 'PO', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'OL', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
    { id: 'hr-admin', tenant: 'orgiq', label: 'HR', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { initiativeDecksRouter } from '../initiative-decks.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { initiativeDecksFixture, initiativeDeckRevisionsFixture } from '../../mock/initiative-decks.js';
import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { holdAgentInvoke, recordAgentInvoke, releaseAgentInvokeHold } from '../../lib/agent-invoke-spend.js';

const PID = 'p-auth-migration';
const BASE = '/api/initiative-decks';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());
beforeEach(() => { initiativeDecksFixture.reset(); initiativeDeckRevisionsFixture.reset(); jest.clearAllMocks(); });
const setMock = (v: boolean) => { (config.mock as { agentcore: boolean }).agentcore = v; };
afterEach(() => { setMock(true); jest.restoreAllMocks(); });

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use(BASE, requireTenant('orgiq'), initiativeDecksRouter);
  app.use(errorHandler);
  return app;
}
const as = (role: string) => appAs({ role: role as Session['role'], tenant: 'orgiq', sub: `u-${role}` });

async function build(app: express.Express) {
  const res = await request(app).post(`${BASE}/projects/${PID}`).send({});
  expect(res.status).toBe(201);
  const spec: DeckSpec = (await request(app).get(`${BASE}/${res.body.deckId}/revisions/${res.body.revisionId}/spec`)).body;
  return { ...res.body, spec } as { deckId: string; revisionId: string; spec: DeckSpec };
}
const propose = (app: express.Express, deckId: string, baseRevisionId: string, instruction: string, slideId?: string) =>
  request(app).post(`${BASE}/${deckId}/operations/proposal`).send({ baseRevisionId, instruction, ...(slideId ? { slideId } : {}) });
const headOf = async (app: express.Express, deckId: string): Promise<string> => (await request(app).get(`${BASE}/${deckId}`)).body.activeRevisionId;

describe('the composer\'s operations proposal', () => {
  it('validates the proposal and saves nothing; Apply on the operations route then saves it', async () => {
    const app = as('sme');
    const made = await build(app);
    const res = await propose(app, made.deckId, made.revisionId, 'make slide 2 a KPI slide');
    expect(res.status).toBe(200);
    // A KPI slide needs its chart: the proposer fills it from a report this caller may read, in the same list.
    const slideId = made.spec.slides[1]!.id;
    expect(res.body).toMatchObject({ baseRevisionId: made.revisionId, engine: 'offline', destructive: false,
      operations: [{ op: 'change_layout', slideId, layout: 'kpi' }, { op: 'set_chart', slideId, kind: 'line', report: { report: expect.any(String) } }] });
    expect(res.body.lines[0]).toMatch(/^Change slide 2 from \S+ to kpi/);
    expect(res.body.lines[1]).toMatch(/^Set a line chart on slide 2 from /);
    expect(res.body.refusal).toBeUndefined();
    // Not applied: the head is the one the proposal was checked on.
    expect(await headOf(app, made.deckId)).toBe(made.revisionId);
    const applied = await request(app).post(`${BASE}/${made.deckId}/operations`).send({ baseRevisionId: res.body.baseRevisionId, operations: res.body.operations });
    expect(applied.status).toBe(201);
    const spec: DeckSpec = (await request(app).get(`${BASE}/${made.deckId}/revisions/${applied.body.revision.id}/spec`)).body;
    expect(spec.slides[1]).toMatchObject({ layout: 'kpi', chart: { kind: 'line' } });
  });

  it('marks a removal destructive and still saves nothing', async () => {
    const app = as('sme');
    const made = await build(app);
    const res = await propose(app, made.deckId, made.revisionId, 'remove slide 2');
    expect(res.body).toMatchObject({ destructive: true, operations: [{ op: 'remove_slide' }] });
    expect(res.body.lines[0]).toMatch(/^Remove slide 2/);
    expect(await headOf(app, made.deckId)).toBe(made.revisionId);
  });

  it('a layout that needs a chart, with no report to read, is refused with the validator\'s plain reason', async () => {
    setMock(false);
    const app = as('sme');
    const made = await build(app);
    jest.spyOn(agentcore, 'invokeAgent').mockResolvedValue({ text: JSON.stringify({ reply: 'Done.', operations: [{ op: 'change_layout', slideId: made.spec.slides[1]!.id, layout: 'kpi' }] }) } as never);
    const res = await propose(app, made.deckId, made.revisionId, 'make slide 2 a KPI slide');
    expect(res.body.refusal).toEqual({ reason: 'the edited deck is not valid', errors: ["slides[1]: a 'kpi' slide needs a chart"] });
    expect(res.body.lines).toEqual([]);
  });

  it('a style request proposes set_style', async () => {
    const app = as('sme');
    const made = await build(app);
    const res = await propose(app, made.deckId, made.revisionId, 'switch to the editorial style');
    expect(res.body.operations).toEqual([{ op: 'set_style', style: 'editorial' }]);
    expect(res.body.lines).toEqual(['Set the style to editorial']);
  });

  it('a list the validator refuses comes back with the plain reason, and is booked so no hold is left', async () => {
    setMock(false);
    const app = as('sme');
    const made = await build(app);
    jest.spyOn(agentcore, 'invokeAgent').mockResolvedValue({ text: JSON.stringify({ reply: 'Removing it.', operations: [{ op: 'remove_slide', slideId: 's-nothere' }] }) } as never);
    const res = await propose(app, made.deckId, made.revisionId, 'remove the risks slide');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ engine: 'agent', reply: 'Removing it.', lines: [], destructive: true });
    expect(res.body.refusal.reason).toMatch(/operation 1 \(remove_slide\): no slide s-nothere in this deck/);
    expect(holdAgentInvoke).toHaveBeenCalledTimes(1);
    expect(recordAgentInvoke).toHaveBeenCalledTimes(1);
    expect((recordAgentInvoke as jest.Mock).mock.calls[0][0]).toMatchObject({ feature: 'deck:orgiq:propose', initiativeId: PID, actorId: 'u-sme' });
    expect(releaseAgentInvokeHold).not.toHaveBeenCalled();
    expect(await headOf(app, made.deckId)).toBe(made.revisionId);
  });

  it('sends the outline and the schema in the tenant\'s own mode; a thrown call releases its hold', async () => {
    setMock(false);
    const app = as('sme');
    const made = await build(app);
    const spy = jest.spyOn(agentcore, 'invokeAgent').mockRejectedValue(new Error('down'));
    const res = await propose(app, made.deckId, made.revisionId, 'switch to the minimal style');
    expect(res.body).toMatchObject({ engine: 'fallback', operations: [{ op: 'set_style', style: 'minimal' }] });
    const sent = (spy.mock.calls[0]?.[1] as { structuredInput: Record<string, any> }).structuredInput;
    expect(sent).toMatchObject({ tenant: 'orgiq', mode: 'operate-initiative-status-deck', auth: { tenant: 'orgiq', sub: 'u-sme' }, instruction: 'switch to the minimal style' });
    expect(sent['outline'].slides[0]).toMatchObject({ position: 1, slideId: made.spec.slides[0]!.id, layout: made.spec.slides[0]!.layout });
    expect(sent['schema']).toMatchObject({ maxOperations: 10, styles: expect.arrayContaining(['editorial']) });
    expect(releaseAgentInvokeHold).toHaveBeenCalledWith('hold-1');
    expect(recordAgentInvoke).not.toHaveBeenCalled();
  });

  it('a refused spend calls no agent, takes the deterministic proposer and says why', async () => {
    setMock(false);
    (holdAgentInvoke as jest.Mock).mockResolvedValueOnce({ kind: 'refused', reason: 'the monthly cap is reached' });
    const app = as('sme');
    const made = await build(app);
    const spy = jest.spyOn(agentcore, 'invokeAgent');
    const res = await propose(app, made.deckId, made.revisionId, 'switch to the playful style');
    expect(spy).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ engine: 'fallback', reason: 'spend refused: the monthly cap is reached', operations: [{ op: 'set_style', style: 'playful' }] });
    expect(recordAgentInvoke).not.toHaveBeenCalled();
    expect(releaseAgentInvokeHold).not.toHaveBeenCalled();
  });

  it('an unclear request proposes nothing, with a reply that says what works', async () => {
    const app = as('sme');
    const made = await build(app);
    const res = await propose(app, made.deckId, made.revisionId, 'make it sing');
    expect(res.body).toMatchObject({ operations: [], lines: [] });
    expect(res.body.reply).toMatch(/could not turn that into deck changes/);
  });

  it('a stale base is 409 with the head; a member who may not save is refused before any agent call', async () => {
    const app = as('sme');
    const made = await build(app);
    await request(app).post(`${BASE}/${made.deckId}/operations`).send({ baseRevisionId: made.revisionId, operations: [{ op: 'set_style', style: 'bold' }] });
    const stale = await propose(app, made.deckId, made.revisionId, 'switch to the editorial style');
    expect(stale.status).toBe(409);
    expect(typeof stale.body.activeRevisionId).toBe('string');
    const spy = jest.spyOn(agentcore, 'invokeAgent');
    const member = await propose(as('member'), made.deckId, stale.body.activeRevisionId, 'switch to the editorial style');
    expect(member.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect(holdAgentInvoke).not.toHaveBeenCalled();
  });

  it('refuses an empty instruction', async () => {
    const app = as('sme');
    const made = await build(app);
    expect((await propose(app, made.deckId, made.revisionId, '  ')).status).toBe(400);
  });
});
