// `orgiq:deck:<id>` presence asks GET /api/initiative-decks/:id's visibility
// (providers/initiative-decks.ts deckViewerFor + visibleDeck), fresh on every
// subscribe and every delivered frame: a deck built with budget figures is
// invisible below the budgets read tier, so its presence channel must not leak
// who views it or which slide they are on. Drives the real
// admitChannel + channelGuard and the installed LocalRealtimeRouter.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { LocalRealtimeRouter, baseChannel } from '@connorhoehn/realtime-modules/server';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';

import { channelGuard } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../social-chat.js';
import { initiativeDecksFixture } from '../../mock/initiative-decks.js';
import { deckViewerFor, getDeck } from '../../providers/initiative-decks.js';
import { admitChannel } from '../gateway/authority.js';

const BUDGET = 'idk-0b1c2d3e-0000-4000-8000-0000000000b1';
const PLAIN = 'idk-0b1c2d3e-0000-4000-8000-0000000000a1';
const UNKNOWN = 'idk-0b1c2d3e-0000-4000-8000-0000000000ff';
// `sme` holds no budget role but is granted ManageBudgets by policy (the
// isAllowed branch of the tier); `member` holds neither.
const POLICY: Record<string, string[]> = { member: [], sme: ['DispatchAgentRun'], 'org-leader': ['ManageBudgets'], treasurer: ['ManageBudgets'] };
let users: Map<string, UserInfo>;
let duringPolicy: (() => void) | null;
const user = (id: string, grants: Record<string, string[]>, epoch = 1): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch, grants });
const ctxOf = (userId: string, role: string, org = 'orgiq') =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const guards = { guard: channelGuard, baseChannel };
const ask = (c: ReturnType<typeof ctxOf>, channel: string, kind: 'subscribe' | 'publish' = 'subscribe') =>
  admitChannel({ kind, clientId: 'c', channel, ctx: c });
const wire = (id: string) => `presence:orgiq:deck:${id}`;
const row = (id: string, includesBudget: boolean) =>
  ({ id, projectId: 'p-soc2', title: 'T', includesBudget, createdBy: 'lee', createdAt: 'x', updatedAt: 'x', headRevisionId: null });

beforeEach(() => {
  duringPolicy = null;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  initiativeDecksFixture.rows().unshift(row(BUDGET, true), row(PLAIN, false));
  users = new Map([
    ['mia', user('mia', { orgiq: ['member'] })],
    ['lee', user('lee', { orgiq: ['org-leader'] })],
    ['tess', user('tess', { orgiq: ['treasurer'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, a) => {
    const ok = (POLICY[p.role] ?? []).includes(a);
    duringPolicy?.();
    return ok;
  });
});
afterEach(() => { jest.clearAllMocks(); initiativeDecksFixture.reset(); setSocialChatBackend(null); });

describe('orgiq:deck presence follows the REST visibility', () => {
  it('denies a non-budget reader on a budget deck — the same deck REST hides from them', async () => {
    expect(await getDeck(BUDGET, await deckViewerFor({ sub: 'mia', tenant: 'orgiq', role: 'member' }))).toBeNull();
    expect(await ask(ctxOf('mia', 'member'), wire(BUDGET))).toBe(false);
    expect(await ask(ctxOf('mia', 'member'), wire(BUDGET), 'publish')).toBe(false);
  });

  it('admits a non-budget reader on a non-budget deck', async () => {
    expect(await ask(ctxOf('mia', 'member'), wire(PLAIN))).toBe(true);
    expect(await ask(ctxOf('mia', 'member'), wire(PLAIN), 'publish')).toBe(true);
  });

  it('admits budget readers by role and by the ManageBudgets policy', async () => {
    expect(await ask(ctxOf('lee', 'org-leader'), wire(BUDGET))).toBe(true);
    expect(await ask(ctxOf('tess', 'treasurer'), wire(BUDGET))).toBe(true);
    expect(await ask(ctxOf('tess', 'treasurer'), wire(BUDGET), 'publish')).toBe(true);
  });

  it('refuses an unknown deck exactly as a hidden one, for every viewer', async () => {
    for (const [who, role] of [['mia', 'member'], ['lee', 'org-leader']] as const) {
      expect(await ask(ctxOf(who, role), wire(UNKNOWN))).toBe(false);
    }
    // A shape-valid but non-deck id never reaches the store either.
    expect(await ask(ctxOf('lee', 'org-leader'), 'presence:orgiq:deck:idk-1')).toBe(false);
  });

  it('refuses a budget reader standing in another tenant', async () => {
    users.set('lee', user('lee', { orgiq: ['org-leader'], assessment: ['assessor'] }));
    expect(await ask(ctxOf('lee', 'assessor', 'assessment'), wire(BUDGET))).toBe(false);
  });

  it('denies when the grant is revoked or the epoch bumped while the policy/row I/O is pending', async () => {
    duringPolicy = () => { users.set('tess', user('tess', {})); };
    expect(await ask(ctxOf('tess', 'treasurer'), wire(BUDGET))).toBe(false);
    users.set('tess', user('tess', { orgiq: ['treasurer'] }));
    duringPolicy = () => { users.get('tess')!.epoch = 2; };
    expect(await ask(ctxOf('tess', 'treasurer'), wire(BUDGET))).toBe(false);
    // The deck re-filed as a budget deck after admission is hidden on the next ask.
    expect(await ask(ctxOf('mia', 'member'), wire(PLAIN))).toBe(true);
    initiativeDecksFixture.rows().find(r => r.id === PLAIN)!.includesBudget = true;
    expect(await ask(ctxOf('mia', 'member'), wire(PLAIN))).toBe(false);
  });
});

describe('the router rechecks every delivered frame', () => {
  type Msg = Record<string, unknown>;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  function setup() {
    const contexts = new Map<string, Msg>();
    const sent: Array<{ to: string; message: Msg }> = [];
    // A socket in `smuggled` skips its next decision (it got into the member
    // set some other way); the per-frame recheck must still withhold.
    const smuggled = new Set<string>();
    const router = new LocalRealtimeRouter({
      logger,
      authorize: ({ kind, clientId, channel, ctx }) =>
        smuggled.delete(clientId) ? true : admitChannel({ kind, clientId, channel, ctx: ctx as Msg | null }),
    });
    (router as unknown as { _setHandle(h: unknown): void })._setHandle({
      getClientContext: (id: string) => contexts.get(id) ?? null,
      sendToClient: (to: string, message: Msg) => { sent.push({ to, message }); return true; },
      listClients: () => [...contexts.keys()],
    });
    const got = (to: string) => sent.filter(s => s.to === to && s.message['type'] === 'presence:update');
    return { router, contexts, got, smuggled };
  }

  it('withholds frames from a non-budget socket smuggled into the member set, and from a reader revoked after subscribing', async () => {
    const { router, contexts, got, smuggled } = setup();
    const ch = wire(BUDGET);
    contexts.set('lee-s', ctxOf('lee', 'org-leader'));
    contexts.set('mia-s', ctxOf('mia', 'member'));
    expect(await router.subscribeToChannel('lee-s', ch)).not.toBe(false);
    expect(await router.subscribeToChannel('mia-s', ch)).toBe(false);
    smuggled.add('mia-s'); expect(await router.subscribeToChannel('mia-s', ch)).not.toBe(false);

    await router.sendToChannel(ch, { type: 'presence:update', slide: 3 });
    expect(got('lee-s')).toHaveLength(1);
    expect(got('mia-s')).toHaveLength(0);

    users.get('lee')!.epoch = 2; // signed out elsewhere
    await router.sendToChannel(ch, { type: 'presence:update', slide: 4 });
    expect(got('lee-s')).toHaveLength(1);
  });
});
