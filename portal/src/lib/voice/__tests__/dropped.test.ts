// G35 (docs/voice-navigator-gaps.md, sessions closed `dropped`): the close
// says why; nothing in the voice path loads a full page; a dropped session is
// resumable for 60 s and the resume names the session it continues.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { RESUME_MS, RESUME_NOTE, VoiceController, type ResumeRecord, type ResumeStore } from '../controller.ts';
import { VoiceClient, type MediaHandlers } from '../client.ts';
import { VoiceJobTracker, type JobToastSink } from '../work.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const A = 'vs_00000000-0000-0000-0000-0000000000d1';
const B = 'vs_00000000-0000-0000-0000-0000000000d2';
type Call = { name: string; arguments: Record<string, unknown>; said: string };
const KUBE: Call = { name: 'search', arguments: { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null }, said: 'Find me the latest Kubernetes experts.' };

function memoryStore(): ResumeStore & { rec: ResumeRecord | null } {
  const s = { rec: null as ResumeRecord | null, load: () => s.rec, save: (r: ResumeRecord) => { s.rec = r; }, clear: () => { s.rec = null; } };
  return s;
}

/** A dock on the virtual clock; each mint answers the next id. `media` stands in for WebRTC (a real, non-mock mint). */
async function dock(opts: { ids: string[]; clock?: FakeClock; store?: ResumeStore; real?: boolean; hidden?: () => boolean; tenant?: () => string; links?: boolean }) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const clock = opts.clock ?? new FakeClock();
  const ids = [...opts.ids];
  const mintBody = () => {
    const id = ids.shift()!;
    return {
      sessionId: id, voiceSessionId: id, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: !opts.real,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['search'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      ...(opts.real ? {} : { mockScript: mockLiveScript(id, KUBE) }),
    };
  };
  const { fetch, log } = fakeFetch([
    (req) => (req.method === 'POST' && /\/api\/voice\/sessions\/vs_[^/]+\/(events|close)$/.test(req.url) ? { status: 201, body: {} } : undefined),
    // The server links a resume and echoes resumeOf (G44: the dock announces only a linked one).
    (req) => {
      if (req.method !== 'POST' || req.url !== '/api/voice/sessions') return undefined;
      const resumeOf = (req.body as Record<string, unknown> | null)?.['resumeOf'];
      return { status: 201, body: { ...mintBody(), ...(typeof resumeOf === 'string' && (opts.links ?? true) ? { resumeOf } : {}) } };
    },
    route('GET', '/api/search', 200, { results: [], total: 0 }),
  ]);
  let handlers: MediaHandlers | null = null;
  const media = opts.real ? async (h: MediaHandlers) => {
    handlers = h;
    return { offer: 'v=0', applyAnswer: async () => {}, send: () => true, levels: () => ({ input: 0, output: 0 }), setMuted: () => {}, close: () => {} };
  } : null;
  const c = new VoiceController({
    fetch, media, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...(opts.store ? { resume: opts.store } : {}), ...(opts.hidden ? { hidden: opts.hidden } : {}), ...(opts.tenant ? { tenant: opts.tenant } : {}),
  });
  return { c, clock, log, drop: (cause: Parameters<MediaHandlers['onDrop']>[0]) => handlers!.onDrop(cause) };
}

const closes = (log: Array<{ url: string; body: unknown }>) => log.filter((r) => r.url.endsWith('/close')).map((r) => r.body as Record<string, unknown>);

test('G35: a pagehide close records the cause, and a user end says user', async () => {
  const h = await dock({ ids: [A, B] });
  await h.c.start();
  await h.clock.advance(1500);
  await h.c.stop('dropped', 'pagehide');
  assert.deepEqual(closes(h.log).map((b) => [b['reason'], b['cause']]), [['dropped', 'pagehide']]);
  await h.c.start();
  await h.clock.advance(1500);
  const stopping = h.c.stop('closed');
  await h.clock.advance(300);
  await stopping;
  assert.deepEqual(closes(h.log).map((b) => [b['reason'], b['cause']]), [['dropped', 'pagehide'], ['closed', 'user']]);
  h.c.dispose();
});

test('G35: a transport drop records the ICE or channel cause, and a hidden page turns it into visibilitychange with the transport kept', async () => {
  let hidden = false;
  const h = await dock({ ids: [A, B], real: true, hidden: () => hidden });
  await h.c.start();
  await h.clock.advance(100);
  h.drop('ice-failed');
  await h.clock.advance(100);
  hidden = true;
  await h.c.start();
  await h.clock.advance(100);
  h.drop('channel-closed');
  await h.clock.advance(1000);
  assert.deepEqual(closes(h.log).map((b) => [b['reason'], b['cause'], b['transport'] ?? null]), [['dropped', 'ice-failed', null], ['dropped', 'visibilitychange', 'channel-closed']]);
  const dropped = loggedEvents(h.log).filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'dropped').map((e) => (e['data'] as Record<string, unknown>)['reason']);
  assert.deepEqual(dropped, ['ice-failed', 'channel-closed']);
  h.c.dispose();
});

test('G35: a dropped session is resumable for 60 s after a reload; the resume mints with resumeOf and tells the voice', async () => {
  const store = memoryStore();
  const clock = new FakeClock();
  const first = await dock({ ids: [A], clock, store });
  await first.c.start();
  await clock.advance(1500);
  void first.c.stop('dropped', 'pagehide');
  // The id is kept at once, before the close's answer: the page that is unloading never sees it.
  assert.equal(store.rec?.sessionId, A);
  first.c.dispose();

  // The reload: a new dock on the same tab's storage, 20 s later.
  await clock.advance(20_000);
  const thinking: string[] = [];
  const proto = VoiceClient.prototype;
  const orig = proto.appendThinking;
  proto.appendThinking = function (t: string) { thinking.push(t); return orig.call(this, t); };
  try {
    const second = await dock({ ids: [B], clock, store });
    assert.equal(second.c.getSnapshot().resumable, A, 'the dock offers Resume');
    await second.c.start({ resume: true });
    await clock.advance(1500);
    const mints = second.log.filter((r) => r.url === '/api/voice/sessions');
    assert.deepEqual(mints.map((m) => (m.body as Record<string, unknown>)['resumeOf']), [A]);
    assert.equal(store.rec, null, 'a resume uses the kept id up');
    assert.equal(second.c.getSnapshot().resumable, null);
    assert.ok(thinking.includes(RESUME_NOTE));
    assert.ok(loggedEvents(second.log).some((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'resumed'));
    second.c.dispose();
  } finally { proto.appendThinking = orig; }
});

test('G35: the Resume offer lapses after 60 s, and a session the user ended is never resumable', async () => {
  const store = memoryStore();
  const clock = new FakeClock();
  const h = await dock({ ids: [A, B], clock, store });
  await h.c.start();
  await clock.advance(1500);
  await h.c.stop('dropped', 'pagehide');
  assert.equal(h.c.getSnapshot().resumable, A);
  await clock.advance(RESUME_MS - 1000);
  assert.equal(h.c.getSnapshot().resumable, A);
  await clock.advance(1100);
  assert.equal(h.c.getSnapshot().resumable, null, 'gone after 60 s');
  assert.equal(store.rec, null);
  // A plain start after a lapse sends no resumeOf; the user's own end keeps nothing.
  await h.c.start();
  await clock.advance(1500);
  const stopping = h.c.stop('closed');
  await clock.advance(300);
  await stopping;
  assert.equal(store.rec, null);
  assert.equal(h.c.getSnapshot().resumable, null);
  assert.deepEqual(h.log.filter((r) => r.url === '/api/voice/sessions').map((m) => (m.body as Record<string, unknown>)['resumeOf'] ?? null), [null, null]);
  // A record older than the window, found at load, is forgotten.
  store.save({ sessionId: A, at: clock.t - RESUME_MS - 1 });
  const later = await dock({ ids: [B], clock, store });
  assert.equal(later.c.getSnapshot().resumable, null);
  assert.equal(store.rec, null);
  h.c.dispose(); later.c.dispose();
});

test('G35: no voice module loads a full page (location.assign, location.href =, location.reload, window.open)', () => {
  const root = new URL('../../../', import.meta.url);
  const files = [
    ...readdirSync(new URL('lib/voice/', root)).filter((f) => f.endsWith('.ts')).map((f) => `lib/voice/${f}`),
    ...readdirSync(new URL('pages/voice/', root)).filter((f) => /\.tsx?$/.test(f)).map((f) => `pages/voice/${f}`),
    'components/shell/VoiceFooterPane.tsx', 'components/shell/voiceDockModel.ts',
    'lib/localNotifications.ts', 'lib/toastStore.ts',
  ];
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(new URL(f, root), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/location\.(assign|replace|reload)\s*\(|location\.href\s*=[^=]|window\.open\s*\(/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
  assert.ok(files.length > 15);
});

test('G35: the job toast\'s link goes through the router (the library\'s onNavigate, 2.514.1), never a full page load', () => {
  type ToastOpts = Parameters<JobToastSink['toastJob']>[0];
  const tracker = (navigate?: (href: string) => void) => {
    const shown: ToastOpts[] = [];
    const jobs = new VoiceJobTracker({
      fetch: () => Promise.reject(new Error('no reads')), toast: { toastJob: (o) => { shown.push(o); }, dismissJobToast: () => {} },
      notify: () => {}, speak: () => {}, toastSeconds: () => 8, ...(navigate ? { navigate } : {}),
    });
    return { jobs, shown };
  };
  const routed: string[] = [];
  const { jobs, shown } = tracker((href) => { routed.push(href); });
  jobs.finished({ jobId: 'doc-1', kind: 'doc', title: 'Draft a document from Observability Platform', href: '/iq/projects/p-obs' }, 'done');
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.href, '/iq/projects/p-obs');
  assert.equal(shown[0]!.hrefLabel, 'Open');
  assert.equal(typeof shown[0]!.onNavigate, 'function', 'every toast routes its link through the host');
  shown[0]!.onNavigate!('/iq/projects/p-obs');
  assert.deepEqual(routed, ['/iq/projects/p-obs']);
  // Without a router (a host that never wired one) the link stays the library's plain anchor.
  const bare = tracker();
  bare.jobs.finished({ jobId: 'doc-2', kind: 'doc', title: 'x', href: '/iq/projects/p-obs' }, 'done');
  assert.equal(bare.shown[0]!.onNavigate, undefined);
  // The pane wires the router into the tracker and no longer intercepts document clicks.
  const pane = readFileSync(new URL('../../../components/shell/VoiceFooterPane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /navigate: \(href\) => \{ void live\.current\.navigate\(href\); \}/);
  assert.doesNotMatch(pane, /addEventListener\('click'/);
});

test('G44: a session dropped in one workspace is not resumable in another; a resume the server did not link is not announced', async () => {
  const store = memoryStore();
  const clock = new FakeClock();
  let tenant = 'assessment';
  const first = await dock({ ids: [A], clock, store, tenant: () => tenant });
  await first.c.start();
  await clock.advance(1500);
  void first.c.stop('dropped', 'beforeunload');
  assert.equal(store.rec?.tenant, 'assessment');
  first.c.dispose();
  tenant = 'social';
  const elsewhere = await dock({ ids: [B], clock, store, tenant: () => tenant });
  assert.equal(elsewhere.c.getSnapshot().resumable, null, 'no resume across workspaces');
  await elsewhere.c.start({ resume: true });
  await clock.advance(1500);
  assert.deepEqual(elsewhere.log.filter((r) => r.url === '/api/voice/sessions').map((m) => (m.body as Record<string, unknown>)['resumeOf'] ?? null), [null]);
  elsewhere.c.dispose();

  // Same workspace, but the server answers without linking: no `resumed`, no resume note.
  store.save({ sessionId: A, at: clock.t, tenant: 'social' });
  const unlinked = await dock({ ids: [B], clock, store, tenant: () => 'social', links: false });
  await unlinked.c.start({ resume: true });
  await clock.advance(1500);
  const events = loggedEvents(unlinked.log).map((e) => (e['data'] as Record<string, unknown> | undefined)?.['event']);
  assert.ok(!events.includes('resumed'));
  assert.ok(events.includes('resume-unlinked'));
  unlinked.c.dispose();
});

test('G44: a tenant switch closes the session as tenant-switch and keeps nothing to resume', async () => {
  const store = memoryStore();
  const h = await dock({ ids: [A], store, tenant: () => 'assessment' });
  await h.c.start();
  await h.clock.advance(1500);
  const stopping = h.c.stop('tenant-switch', 'tenant-switch');
  await h.clock.advance(300);
  await stopping;
  assert.deepEqual(closes(h.log).map((b) => [b['reason'], b['cause']]), [['tenant-switch', 'tenant-switch']]);
  assert.equal(store.rec, null);
  h.c.dispose();
});
