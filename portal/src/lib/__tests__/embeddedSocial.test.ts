import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbeddedSocialSession, EmbeddedSocialRequestError, createEmbeddedSocialClient, readEmbeddedSocialSnapshot, embeddedTokenMatchesSource,
  type EmbeddedSocialClient, type EmbeddedSocialScope, type EmbeddedSocialSnapshot } from '../embeddedSocial.ts';

const scope: EmbeddedSocialScope = { userId: 'rachel', tenant: 'orgiq', role: 'hr-admin', actorId: null, asUserId: null };
const vera = { userId: 'vera', displayName: 'Vera Green' }, nora = { userId: 'nora', displayName: 'Nora Chang' };
const snapshot = (patch: Partial<EmbeddedSocialSnapshot> = {}): EmbeddedSocialSnapshot => ({
  me: { userId: 'rachel', displayName: 'Rachel' }, canSend: true, people: [vera, nora].map(person => ({ ...person, roles: ['participant'] })),
  conversations: [{ channel: 'social:dm:rachel:vera', peers: [vera], lastMessageAt: null, lastMessagePreview: null, lastMessageUserId: null, unreadCount: 2 }],
  authorityKey: 'validated-authority-one', source: { userId: 'rachel', tenant: 'orgiq', role: 'hr-admin', epoch: 1, actor: null }, ...patch,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};
const dm = (userId: string) => ({ channel: `social:dm:${['rachel', userId].sort().join(':')}`, peers: [userId === 'vera' ? vera : nora] });
async function ready(patch: Partial<EmbeddedSocialClient> = {}, timeout = 100) {
  const model = new EmbeddedSocialSession({ read: async () => snapshot(), openDm: async userId => dm(userId), markRead: async () => {}, ...patch }, timeout);
  model.setScope(scope); await model.refresh(); return model;
}

test('embedded client sends only exact peer/channel bodies and retains source authority', async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const client = createEmbeddedSocialClient(async (path, init) => {
    requests.push({ path: String(path), init });
    return new Response(JSON.stringify(String(path).endsWith('/embedded') ? snapshot() : String(path).endsWith('/read') ? { ok: true } : dm('vera')));
  });
  const signal = new AbortController().signal;
  assert.equal((await client.read(signal)).source.tenant, 'orgiq');
  await client.openDm('vera', signal); await client.markRead('social:dm:rachel:vera', signal);
  assert.deepEqual(requests.map(request => request.path), ['/api/social/embedded', '/api/social/dms', '/api/social/dms/read']);
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { userId: 'vera' });
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), { channel: 'social:dm:rachel:vera' });
  assert.ok(requests.every(request => request.init?.credentials === 'include'));
});
test('snapshot rejects forged actor/name correlation and noncanonical or unrelated DM channels', () => {
  assert.ok(readEmbeddedSocialSnapshot(snapshot()));
  assert.equal(readEmbeddedSocialSnapshot(snapshot({ me: { userId: 'someone', displayName: 'Rachel' } })), null);
  assert.equal(readEmbeddedSocialSnapshot(snapshot({ conversations: [{ ...snapshot().conversations[0]!, channel: 'social:dm:vera:rachel' }] })), null);
  assert.equal(readEmbeddedSocialSnapshot(snapshot({ conversations: [{ ...snapshot().conversations[0]!, channel: 'orgiq:huddle:one' }] })), null);
  assert.equal(readEmbeddedSocialSnapshot({ ...snapshot(), source: { ...snapshot().source, epoch: -1 } }), null);
});
test('transport bearer must match the validated source including exact epoch and masquerade actor', () => {
  const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const source = snapshot().source, claims = { sub: source.userId, org: source.tenant, role: source.role, epoch: source.epoch };
  assert.equal(embeddedTokenMatchesSource(token(claims), source), true);
  for (const patch of [{ epoch: 0 }, { sub: 'vera' }, { org: 'social' }, { role: 'member' }, { act: { sub: 'admin', epoch: 0 } }]) {
    assert.equal(embeddedTokenMatchesSource(token({ ...claims, ...patch }), source), false);
  }
  const masquerade = { ...source, actor: { userId: 'admin', epoch: 3 } };
  assert.equal(embeddedTokenMatchesSource(token({ ...claims, act: { sub: 'admin', epoch: 3 } }), masquerade), true);
  assert.equal(embeddedTokenMatchesSource(token({ ...claims, act: { sub: 'admin', epoch: 2 } }), masquerade), false);
  assert.equal(embeddedTokenMatchesSource('opaque-session-handle', source), false);
});
test('same authenticated authority refresh and close/reopen preserve destination drafts', async () => {
  const model = await ready(); await model.openDm('vera');
  const draft = { html: '<p>Keep this</p>', files: [] as never[] }; model.setDraft(dm('vera').channel, draft);
  model.closeMessage(); model.setScope({ ...scope }); await model.refresh(); model.openMessage();
  assert.equal(model.getSnapshot().selected, dm('vera').channel); assert.equal(model.getSnapshot().drafts[dm('vera').channel], draft);
});
test('actor or tenant changes discard private drafts and delayed snapshots cannot restore them', async () => {
  const old = deferred<EmbeddedSocialSnapshot>(); let delayed = false;
  const model = await ready({ read: () => delayed ? old.promise : Promise.resolve(snapshot()) });
  await model.openDm('vera'); model.setDraft(dm('vera').channel, { html: '<p>Private</p>', files: [] });
  delayed = true; const refresh = model.refresh(); model.setScope({ ...scope, tenant: 'social', role: 'participant' });
  old.resolve(snapshot()); assert.equal(await refresh, false); assert.equal(model.getSnapshot().snapshot, null);
  assert.deepEqual(model.getSnapshot().drafts, {}); assert.equal(model.getSnapshot().selected, null);
});
test('validated epoch and masquerade authority changes discard prior private state', async () => {
  let next = snapshot(); const model = await ready({ read: async () => next });
  await model.openDm('vera'); model.setDraft(dm('vera').channel, { html: '<p>Private</p>', files: [] });
  next = snapshot({ authorityKey: 'validated-authority-two', source: { ...next.source, epoch: 2 } }); await model.refresh();
  assert.deepEqual(model.getSnapshot().drafts, {}); assert.equal(model.getSnapshot().selected, null);
  model.setScope({ ...scope, actorId: 'admin', asUserId: 'rachel' });
  assert.equal(await model.refresh(), false); assert.equal(model.getSnapshot().snapshot, null);
  assert.match(model.getSnapshot().error!, /authority changed/);
});
test('latest read wins and a delayed older authority cannot rewind the accepted snapshot', async () => {
  const old = deferred<EmbeddedSocialSnapshot>(), fresh = deferred<EmbeddedSocialSnapshot>(); let calls = 0;
  const model = await ready({ read: () => ++calls === 1 ? Promise.resolve(snapshot()) : calls === 2 ? old.promise : fresh.promise });
  const a = model.refresh(), b = model.refresh();
  fresh.resolve(snapshot({ authorityKey: 'new', source: { ...snapshot().source, epoch: 2 } })); await b;
  old.resolve(snapshot()); assert.equal(await a, false); assert.equal(model.getSnapshot().snapshot?.authorityKey, 'new');
});
test('delayed DM receipt cannot navigate after a different destination was explicitly selected', async () => {
  const receipt = deferred<ReturnType<typeof dm>>(); const model = await ready({ openDm: () => receipt.promise });
  const opening = model.openDm('nora'); model.selectDm(dm('vera').channel); receipt.resolve(dm('nora'));
  assert.equal(await opening, null); assert.equal(model.getSnapshot().selected, dm('vera').channel);
});
test('forged DM receipt and ineligible target cannot establish a transport destination', async () => {
  let opens = 0;
  const model = await ready({ openDm: async () => { opens++; return dm('nora'); } });
  assert.equal(await model.openDm('unknown'), null); assert.equal(opens, 0);
  assert.equal(await model.openDm('vera'), null); assert.equal(model.getSnapshot().selected, null);
  assert.match(model.getSnapshot().error!, /not confirmed/);
});
test('sendToPerson captures its peer, waits for actual join, then confirms persisted delivery', async () => {
  const model = await ready(), sent: string[] = [];
  const pending = model.sendToPerson('vera', ' Exact text ');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(model.getSnapshot().pending, dm('vera').channel);
  model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true,
    send: async text => { sent.push(text); } });
  assert.equal(await pending, true); assert.deepEqual(sent, ['Exact text']);
});
test('a first send survives the not-ready binding cleanup before its joined binding confirms delivery', async () => {
  const model = await ready(), sent: string[] = [];
  const pending = model.sendToPerson('vera', 'First message');
  await Promise.resolve(); await Promise.resolve();
  const waiting = model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: false,
    send: async () => { throw new Error('Must wait for join'); } });
  waiting();
  model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true,
    send: async (text, signal) => { assert.equal(signal?.aborted, false); sent.push(text); } });
  assert.equal(await pending, true); assert.deepEqual(sent, ['First message']);
});

test('person sends capture the page descriptor before awaiting the canonical DM receipt', async () => {
  const opened = deferred<ReturnType<typeof dm>>();
  const model = await ready({ openDm: async () => opened.promise });
  const page = { kind: 'work-item' as const, id: 'work-original' };
  const pending = model.sendToPerson('vera', 'With context', page); page.id = 'work-later';
  opened.resolve(dm('vera')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  let received: unknown;
  model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true,
    send: async (_text, _signal, reference) => { received = reference; } });
  assert.equal(await pending, true); assert.deepEqual(received, { kind: 'work-item', id: 'work-original' });
});
test('losing an already ready transport still cancels a pending receipt and retains its draft', async () => {
  const model = await ready(); await model.openDm('vera');
  const receipt = deferred<void>(), started = deferred<void>();
  const draft = { html: '<p>Keep through disconnect</p>', files: [] as never[] };
  model.setDraft(dm('vera').channel, draft);
  const disconnect = model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true,
    send: async (_text, signal) => { started.resolve(); await receipt.promise; assert.equal(signal?.aborted, true); } });
  const pending = model.sendSelected('Keep through disconnect'); await started.promise;
  disconnect(); receipt.resolve(); assert.equal(await pending, false);
  assert.equal(model.getSnapshot().drafts[dm('vera').channel], draft);
});
test('changing the DM while waiting for a join cancels the send instead of retargeting it', async () => {
  const model = await ready(), sent: string[] = [];
  const pending = model.sendToPerson('vera', 'Vera only'); await Promise.resolve(); await Promise.resolve();
  await model.openDm('nora'); model.bindTransport('validated-authority-one', { channel: dm('nora').channel, ready: true,
    send: async text => { sent.push(text); } });
  assert.equal(await pending, false); assert.deepEqual(sent, []); assert.equal(model.getSnapshot().selected, dm('nora').channel);
});
test('changing the DM during an in-flight acknowledgement aborts it and retains both drafts', async () => {
  const model = await ready(); await model.openDm('vera');
  model.setDraft(dm('vera').channel, { html: '<p>Vera draft</p>', files: [] });
  let signal: AbortSignal | null = null;
  model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true, send: (_text, abort) => {
    signal = abort; return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(new Error('Destination changed')), { once: true }));
  } });
  const pending = model.sendSelected('Vera draft'); await Promise.resolve(); await model.openDm('nora');
  assert.equal(await pending, false); assert.equal((signal as unknown as AbortSignal).aborted, true);
  model.setDraft(dm('nora').channel, { html: '<p>Nora draft</p>', files: [] });
  assert.equal(model.getSnapshot().drafts[dm('vera').channel]?.html, '<p>Vera draft</p>');
  assert.equal(model.getSnapshot().drafts[dm('nora').channel]?.html, '<p>Nora draft</p>');
});
test('unknown receipt and join timeout retain the exact draft with a visible reason', async () => {
  const model = await ready({}, 5); await model.openDm('vera');
  const draft = { html: '<p>Keep</p>', files: [] as never[] }; model.setDraft(dm('vera').channel, draft);
  assert.equal(await model.sendSelected('Keep'), false); assert.match(model.getSnapshot().error!, /not connected/);
  model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true,
    send: async () => { throw new Error('The message receipt was not confirmed.'); } });
  assert.equal(await model.sendSelected('Keep'), false); assert.match(model.getSnapshot().error!, /not confirmed/);
  assert.equal(model.getSnapshot().drafts[dm('vera').channel], draft);
});
test('a delayed composer clear must still own the previous draft object', async () => {
  const model = await ready(); await model.openDm('vera');
  const original = { html: '<p>Original</p>', files: [] as never[] }, newer = { html: '<p>Next</p>', files: [] as never[] };
  model.setDraft(dm('vera').channel, original); model.setDraft(dm('vera').channel, newer, original);
  model.setDraft(dm('vera').channel, { html: '', files: [] }, original);
  assert.equal(model.getSnapshot().drafts[dm('vera').channel], newer);
});
test('current Social access denial clears private state and disables sending', async () => {
  let denied = false; const model = await ready({ read: async () => {
    if (denied) throw new EmbeddedSocialRequestError(403, 'Social grant revoked'); return snapshot();
  } });
  await model.openDm('vera'); model.setDraft(dm('vera').channel, { html: '<p>Private</p>', files: [] });
  denied = true; await model.refresh(); assert.equal(model.canSend(), false);
  assert.equal(model.getSnapshot().snapshot, null); assert.deepEqual(model.getSnapshot().drafts, {});
});
test('failed authority refresh disables writes while preserving same-actor drafts, and a successful read restores them', async () => {
  let outage = false; const model = await ready({ read: async () => {
    if (outage) throw new EmbeddedSocialRequestError(503, 'Directory unavailable'); return snapshot();
  } });
  await model.openDm('vera'); const draft = { html: '<p>Keep locally</p>', files: [] as never[] };
  model.setDraft(dm('vera').channel, draft);
  model.bindTransport('validated-authority-one', { channel: dm('vera').channel, ready: true, send: async () => {} });
  assert.equal(model.canSend(), true); outage = true; await model.refresh();
  assert.equal(model.canSend(), false); assert.equal(await model.sendSelected('Keep locally'), false);
  assert.equal(model.getSnapshot().drafts[dm('vera').channel], draft); assert.ok(model.getSnapshot().snapshot);
  outage = false; await model.refresh(); assert.equal(model.canSend(), true);
  assert.equal(model.getSnapshot().drafts[dm('vera').channel], draft);
});
test('bounded roster/history omission preserves only the selected known DM, while complete omission disables it', async () => {
  let next = snapshot(); const model = await ready({ read: async () => next }); await model.openDm('vera');
  const draft = { html: '<p>Selected peer</p>', files: [] as never[] }; model.setDraft(dm('vera').channel, draft);
  next = snapshot({ people: [{ ...nora, roles: ['participant'] }], conversations: [], peopleTotal: 501, peopleHasMore: true, conversationsHasMore: true });
  await model.refresh(); assert.equal(model.getSnapshot().selected, dm('vera').channel);
  assert.equal(model.getSnapshot().snapshot?.conversations.length, 1);
  assert.ok(model.getSnapshot().snapshot?.people.some(person => person.userId === 'vera'));
  assert.equal(model.getSnapshot().drafts[dm('vera').channel], draft);
  next = { ...next, peopleHasMore: false, conversationsHasMore: false }; await model.refresh();
  assert.equal(model.getSnapshot().selected, null); assert.match(model.getSnapshot().error!, /no longer available/);
});

test('a failed attachment upload in prepare sends nothing, shows the reason, keeps the draft, and a retry delivers', async () => {
  const model = await ready(), sent: { text: string; extra?: unknown }[] = [];
  const draft = { html: '<p>With file</p>', files: [] as never[] };
  const channel = dm('vera').channel; await model.openDm('vera'); model.setDraft(channel, draft);
  model.bindTransport('validated-authority-one', { channel, ready: true, send: async (text, _s, _p, extra) => { sent.push({ text, extra }); } });
  assert.equal(await model.sendToPerson('vera', 'With file', null, async () => { throw new Error('Upload failed: 500'); }), false);
  assert.deepEqual(sent, []); assert.equal(model.getSnapshot().error, 'Upload failed: 500');
  assert.equal(model.getSnapshot().pending, null); assert.equal(model.getSnapshot().drafts[channel], draft);
  assert.equal(await model.sendToPerson('vera', 'With file', null, async text => ({ text, extra: { attachments: [] } })), true);
  assert.deepEqual(sent, [{ text: 'With file', extra: { attachments: [] } }]); assert.equal(model.getSnapshot().error, null);
});
