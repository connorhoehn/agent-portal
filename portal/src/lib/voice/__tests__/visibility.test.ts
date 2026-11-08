// Profile reads and DMs stay inside the UI's visibility (G14,
// docs/voice-navigator-gaps.md §2.5). Every planner and runner runs as two
// personas with different grants, each over its own world of fixtures (what
// that persona's own GETs of the backing reads answer). Property: no name, id
// or href in a refused, ambiguous or failed payload is absent from that
// persona's own reads, and nothing of the other persona's world appears in it
// at all. Plus the confirm-time DM: the resolver only names it, the runner
// opens it, and a refused open sends nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { accessRequestHref, BUDGET_READ_ITEM_ID, planPreparedCall, prepareToolCall, ResultMemory, runPreparedCall, type CallAccess, type ComputeAccess, type PresenceAccess, type SocialAccess, type ToolResult, type VoiceComputer } from '../tools.ts';
import { middlewareVoice, PALETTE, toolContext, type LoggedRequest } from './voiceHarness.ts';
import type { Action } from '../../capabilities';

interface World {
  /** What this persona's own GETs answer, by path prefix. */
  reads: Record<string, unknown>;
  computers: VoiceComputer[];
  roster: PresenceAccess;
  allow: Action[];
  social: boolean;
  socialRequestItemId: string | null;
}

const SID = (c: string) => c.repeat(40);

/** Sana: a Work member with a Social grant and the Computer Lab. */
const SANA: World = {
  allow: ['Search', 'ViewSocial', 'PostMessage', 'StartCall', 'ManageDevbox', 'OpenDevboxShell', 'ManageBots', 'VoiceNavigate'],
  social: true, socialRequestItemId: null,
  computers: [{ id: 'c-sana-alpha', label: 'sana-alpha-box', sessionId: SID('a'), status: 'running', projectId: 'p-sana-alpha', project: 'Sana Alpha Initiative' }],
  roster: { roster: () => [{ userId: 'u-sana-peer', name: 'Sana Peer Person', status: 'online' }], lobby: () => null },
  reads: {
    '/api/graph/projects': [{ id: 'p-sana-alpha', name: 'Sana Alpha Initiative' }, { id: 'p-sana-beta', name: 'Sana Beta Initiative' }],
    '/api/social/plane/resolve': { kind: 'person', match: null, candidates: [{ id: 'u-sana-ada1', name: 'Ada Sana-One' }, { id: 'u-sana-ada2', name: 'Ada Sana-Two' }] },
    '/api/social/plane/search': { results: [{ type: 'calllog', id: 'call-s|u-sana', title: 'Missed call from Sana Caller', href: '/social/calls', updatedAt: '2026-11-08T09:00:00Z' }], total: 1 },
    '/api/search': { results: [{ type: 'person', id: 'p-sana-x', title: 'Sana Search Hit', href: '/iq/search?selection=person%3Ap-sana-x' }], total: 1 },
    '/api/devbox/allowlist': { prefixes: ['git status'] },
    '/api/work/findings': { findings: [] },
    '/api/access-requests/mine': { items: [] },
    '/api/bots': { bots: [{ id: 'b-sana-1', name: 'sana-nightly-bot', enabled: true }, { id: 'b-sana-2', name: 'sana-nightly-check', enabled: true }, { id: 'b-sana-3', name: 'sana-parked-bot', enabled: false, pausedReason: 'Sana parked it' }] },
  },
};

/** Eli: a Work member with no Social grant and no Computer Lab. */
const ELI: World = {
  allow: ['Search', 'VoiceNavigate'],
  social: false, socialRequestItemId: 'role:social:moderator',
  computers: [],
  roster: { roster: () => [{ userId: 'u-eli-peer', name: 'Eli Lobby Person', status: 'online' }], lobby: () => ({ channel: 'orgiq:lobby', setStatus: () => {}, updateMetadata: () => {} }) },
  reads: {
    '/api/graph/projects': [{ id: 'p-eli-gamma', name: 'Eli Gamma Initiative' }],
    '/api/search': { results: [{ type: 'person', id: 'p-eli-x', title: 'Eli Search Hit', href: '/iq/search?selection=person%3Ap-eli-x' }], total: 1 },
    '/api/work/findings': { findings: [] },
    '/api/access-requests/mine': { items: [] },
  },
};

type Mode = 'world' | 'forbidden' | 'down';

/** The persona's fetch: its own reads (or every read 403 / 500), logging what it answered. */
function worldFetch(world: World, mode: Mode) {
  const answered: unknown[] = [];
  const log: LoggedRequest[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    log.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (mode !== 'world') return new Response('{}', { status: mode === 'forbidden' ? 403 : 500 });
    const key = Object.keys(world.reads).find((k) => url === k || url.startsWith(`${k}?`));
    if (!key) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
    answered.push(world.reads[key]);
    return new Response(JSON.stringify(world.reads[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, answered, log };
}

function compute(world: World): ComputeAccess | null {
  if (!world.allow.includes('ManageDevbox')) return null;
  return {
    canManage: true, computers: () => world.computers,
    create: async () => { throw new Error('the property never confirms a start'); },
    openShell: () => ({ ok: false, reason: 'at-capacity' }),
    runCommand: async () => { throw new Error('not allowlisted in safe mode'); },
  };
}

const social = (world: World): SocialAccess | null => (world.social
  ? { api: '/api/social/plane', unavailable: null, send: async () => { throw new Error('no receipt'); }, presence: null, deliveries: new Map() } : null);
const calls: CallAccess = { unavailable: null, active: () => null, callConversation: () => {}, callPeople: () => {} };

/** Arguments that drive each tool to a refusal, an ambiguity or a failure. */
const VARIANTS: Record<string, unknown[]> = {
  open: [{ page: 'bots' }, { page: 'nowhere' }, { page: 'search', params: { q: 'x' } }, { ref: 'person:p-not-kept' }, { ref: '1' }, { ref: 'initiative:p-sana-alpha' },
    { kind: 'initiative', name: 'Initiative' }, { kind: 'initiative', name: 'Nothing Like It' }, { kind: 'bot', name: 'sana' }, { kind: 'channel', name: 'x' }, { page: 'search', ref: '1' }],
  search: [{ query: 'kubernetes', type: 'person' }, { query: 'alpha', type: 'initiative' }, { query: 'x', type: 'not-a-type' }, { query: 'who decided it', answer: true }],
  list: [{ kind: 'initiative', filter: { q: 'nothing like it' } }, { kind: 'bot' }, { kind: 'channel' }, { kind: 'not-a-kind' }, { kind: 'finding', filter: { since: 'soon' } }],
  get: [{ ref: '1' }, { ref: 'initiative:p-unknown' }, { ref: 'bot:b-x', part: 'runs' }, { ref: 'person:p-sana-x' }, { ref: 'Sana Alpha Initiative' }],
  start_computer: [{ initiativeIds: ['Unknown Initiative'] }],
  open_shell: [{ computerId: 'unknown-box' }],
  run_command: [{ computerId: 'unknown-box', phrase: 'status' }, { computerId: 'unknown-box', phrase: 'commits-since', since: 'soon' }],
  budget: [{ scope: 'me' }, { scope: 'initiative', initiative: 'Nobody Initiative' }, { scope: 'initiative', initiative: 'Initiative' }, { scope: 'org' }, { scope: 'allocations' }, { scope: 'cost' }],
  summary: [{ kind: 'sweeps', since: 'whenever' }, { kind: 'sweeps', since: 'yesterday' }, { kind: 'fleet' }, { kind: 'live' }, { kind: 'ingest' }, { kind: 'rollup' }, { kind: 'today' }],
  send_chat_message: [{ target: { kind: 'dm', name: 'Ada' }, text: 'hello' }, { target: { kind: 'team', name: 'nobody' }, text: 'x' }],
  start_call: [{ target: { kind: 'dm', name: 'Ada' } }],
  set_status: [{ status: 'away', message: 'out' }],
  access_request_status: [{ scope: 'approvals' }, { query: 'budget' }],
  queue_work: [{ kind: 'sweep', target: 'vibes' }, { kind: 'bot-run', target: 'nightly' }, { kind: 'bot-run', target: 'unknown thing' }, { kind: 'bot-run', target: 'sana parked' }, { kind: 'pipeline', target: 'ingest' }],
  activity: [{ scope: 'missed-calls' }, { scope: 'online', who: 'nobody' }, { scope: 'recent', since: 'tomorrow' }, { scope: 'work', who: 'Someone' }],
};

/** Keys whose values name a row: a person, a record, a link. */
const IDENT_KEYS = new Set(['id', 'name', 'title', 'label', 'href', 'ref', 'path', 'initiative', 'initiativeId', 'computerId', 'userId', 'channel', 'item', 'requester', 'for', 'decidedBy', 'bot', 'sweep', 'to', 'with', 'in', 'computer']);

function strings(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

function identifiers(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => identifiers(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (IDENT_KEYS.has(k) && typeof x === 'string') out.push(x);
      else identifiers(x, out);
    }
  }
  return out;
}

const capped = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

async function runAs(world: World, mode: Mode, name: string, args: unknown): Promise<{ results: ToolResult[]; universe: Set<string> }> {
  const { fetch, answered } = worldFetch(world, mode);
  const ctx = toolContext({
    role: 'member', allow: world.allow, fetch, compute: compute(world), social: social(world), calls, presence: world.roster,
    socialRequestItemId: world.socialRequestItemId, results: new ResultMemory(), jobs: { track: () => {} },
  });
  const results: ToolResult[] = [];
  const prepared = prepareToolCall(name, args, ctx);
  if (!prepared.ok) results.push(prepared.result);
  else {
    const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
    if (planned && 'result' in planned) results.push(planned.result);
    else results.push(await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned?.plan.data));
  }
  // What this persona may be told: its own reads, the providers its own shell holds, its own words, and the
  // request link its own capabilities read named.
  const universe = strings([answered, world.computers, world.roster.roster(), args]);
  // The dock's own fixed words for that link are not a row.
  if (world.socialRequestItemId) for (const s of [world.socialRequestItemId, accessRequestHref(world.socialRequestItemId), 'Request Social access']) universe.add(s);
  // And the budgets tier's own request link (budget's offer): fixed words and the catalog item, never a row.
  for (const s of [BUDGET_READ_ITEM_ID, accessRequestHref(BUDGET_READ_ITEM_ID), 'Request budget visibility']) universe.add(s);
  // The palette's own pages (open's nearest page) are the UI the persona already sees, not rows.
  for (const p of PALETTE.pages) { universe.add(p.label); if (p.pageId) universe.add(p.pageId); }
  return { results, universe };
}

test('property: a refused, ambiguous or failed payload names only rows that persona\'s own reads returned, and nothing of the other persona', async () => {
  // Every tool an orgiq session is offered, from the catalogue the session is minted with.
  const mw = await middlewareVoice<{ toolsForTenant(t: string): Array<{ name: string }> }>('catalogue.ts');
  const names = mw.toolsForTenant('orgiq').map((t) => t.name);
  for (const tool of names) assert.ok(VARIANTS[tool], `${tool} has variants in this property`);
  const worlds = [['sana', SANA, ELI], ['eli', ELI, SANA]] as const;
  let checked = 0;
  for (const [who, mine, other] of worlds) {
    const foreign = new Set([...strings([Object.values(other.reads), other.computers, other.roster.roster()])].filter((s) => s.length > 3 && !strings([Object.values(mine.reads), mine.computers, mine.roster.roster()]).has(s)));
    for (const tool of names) {
      for (const args of VARIANTS[tool]!) {
        for (const mode of ['world', 'forbidden', 'down'] as const) {
          const { results, universe } = await runAs(mine, mode, tool, args);
          for (const r of results) {
            if (r.outcome === 'done' || r.outcome === 'cancelled') continue;
            checked++;
            const where = `${who} ${tool} ${JSON.stringify(args)} ${mode}`;
            for (const id of identifiers(r.output)) {
              // A typed ref (`kind:id`, catalogue v2) names a row by the id the persona's own read returned.
              const typed = /^[a-z][a-z-]*:(.+)$/.exec(id)?.[1];
              const known = (x: string) => universe.has(x) || [...universe].some((u) => capped(u) === x);
              // A portal link the dock built from such an id (kinds.ts href) names the same row: one of its segments is the id.
              const linked = id.startsWith('/') && decodeURIComponent(id).split(/[/?=&]/).some((seg) => seg.length > 2 && known(seg.replace(/^[a-z][a-z-]*:/, '')));
              assert.ok(known(id) || (typed != null && known(typed)) || linked, `${where}: "${id}" is not in this persona's own reads`);
            }
            const text = JSON.stringify(r.output) + r.summary;
            for (const f of foreign) assert.ok(!text.includes(f), `${where}: names the other persona's "${f}"`);
          }
        }
      }
    }
  }
  assert.ok(checked > 60, `the property saw ${checked} refusals, ambiguities and failures`);
});

test('confirm-time DM: a refused or mismatched open sends nothing; an ambiguous name opens nothing', async () => {
  const channel = 'social:dm:u-ada:u-me';
  const resolved = { kind: 'person', match: { id: 'u-ada', name: 'Ada', channelId: channel, channel }, candidates: [{ id: 'u-ada', name: 'Ada' }] };
  for (const [status, body, outcome] of [[403, {}, 'refused'], [200, { channel: 'social:dm:u-ada:u-other' }, 'failed'], [500, {}, 'failed']] as const) {
    const sends: unknown[] = [];
    const log: LoggedRequest[] = [];
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      log.push({ method: init?.method ?? 'GET', url, body: init?.body });
      if (url.includes('/resolve')) return new Response(JSON.stringify(resolved), { status: 200 });
      return new Response(JSON.stringify(body), { status });
    };
    const s: SocialAccess = { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async (x) => { sends.push(x); } };
    const ctx = toolContext({ fetch, social: s, socialRequestItemId: 'role:social:moderator' });
    const prepared = prepareToolCall('send_chat_message', { target: { kind: 'dm', name: 'Ada' }, text: 'hi' }, ctx);
    assert.ok(prepared.ok);
    const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
    assert.ok(planned && 'plan' in planned);
    const r = await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned.plan.data);
    assert.equal(r.outcome, outcome, `${status}`);
    assert.equal(sends.length, 0, `${status}: nothing sent`);
    assert.deepEqual(log.filter((l) => l.method === 'POST').map((l) => l.url), ['/api/social/dms']);
  }
  // Several Adas: candidates go back, no card, no POST at all.
  const log: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify({ kind: 'person', match: null, candidates: [{ id: 'u1', name: 'Ada A' }, { id: 'u2', name: 'Ada B' }] }), { status: 200 });
  };
  const ctx = toolContext({ fetch, social: { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async () => {} } });
  const prepared = prepareToolCall('send_chat_message', { target: { kind: 'dm', name: 'Ada' }, text: 'hi' }, ctx);
  assert.ok(prepared.ok);
  const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
  assert.ok(planned && 'result' in planned && planned.result.output['kind'] === 'ambiguous');
  assert.ok(log.every((l) => l.startsWith('GET ')));
});
