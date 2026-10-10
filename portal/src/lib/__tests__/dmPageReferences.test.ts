import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DmReferenceSession, createDmReferenceReader, readDmPageDescriptor, orgiqReferenceReturnHref } from '../dmPageReferences.ts';
import type { CallChatPageReference } from '../callPages.ts';

const page = { kind: 'work-item' as const, id: 'work-1' };
const scope = { identity: 'bob-social-participant', channel: 'social:dm:alice:bob', messageId: 'm-1', page };
const available: CallChatPageReference = { ...page, status: 'available', title: 'Canonical work', href: '/iq/projects/project-1?tab=work&item=work-1',
  project: { id: 'project-1', title: 'Canonical initiative', href: '/iq/projects/project-1' }, breadcrumbs: [{ title: 'Canonical work', href: '/iq/projects/project-1?tab=work&item=work-1' }] };
const unavailable: CallChatPageReference = { ...page, status: 'unavailable' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(ok => { resolve = ok; }); return { promise, resolve }; };

test('opaque reference readers reject client titles, URLs, unsupported kinds and path traversal', () => {
  assert.deepEqual(readDmPageDescriptor(page), page);
  for (const value of [{ ...page, title: 'Forged' }, { ...page, href: '//evil.invalid' }, { kind: 'url', id: 'work-1' }, { ...page, id: '../secret' }]) {
    assert.equal(readDmPageDescriptor(value), null);
  }
});
test('reference client checks exact message/resource correlation, credentials and canonical destinations', async () => {
  let path = '', init: RequestInit | undefined;
  const reader = createDmReferenceReader(async (url, options) => {
    path = String(url); init = options; return new Response(JSON.stringify({ channel: scope.channel, messageId: scope.messageId, pageReference: available }));
  });
  assert.deepEqual(await reader(scope, new AbortController().signal), available);
  const query = new URL(path, 'https://local.invalid').searchParams;
  assert.equal(query.get('channel'), scope.channel); assert.equal(query.get('messageId'), scope.messageId);
  assert.equal(init?.credentials, 'include'); assert.equal(init?.cache, 'no-store');
  for (const body of [{ channel: 'social:dm:alice:outsider', messageId: scope.messageId, pageReference: available },
    { channel: scope.channel, messageId: 'another-message', pageReference: available },
    { channel: scope.channel, messageId: scope.messageId, pageReference: { ...available, href: '//evil.invalid' } }]) {
    await assert.rejects(createDmReferenceReader(async () => new Response(JSON.stringify(body)))(scope, new AbortController().signal));
  }
});
test('refresh immediately hides prior metadata and cannot restore an older available read after denial', async () => {
  const old = deferred<CallChatPageReference>(), latest = deferred<CallChatPageReference>(); let count = 0;
  const model = new DmReferenceSession(async () => ++count === 1 ? available : count === 2 ? old.promise : latest.promise);
  model.setScope(scope); await model.refresh(); assert.equal(model.getSnapshot().reference?.status, 'available');
  const staleRead = model.refresh(); assert.equal(model.getSnapshot().reference, null);
  const currentRead = model.refresh(); latest.resolve(unavailable); await currentRead;
  old.resolve(available); assert.equal(await staleRead, null); assert.deepEqual(model.getSnapshot().reference, unavailable);
});
test('identity/message changes fence late reference data and failed refresh clears the title', async () => {
  const waiting = deferred<CallChatPageReference>();
  const model = new DmReferenceSession(async () => waiting.promise); model.setScope(scope);
  const read = model.refresh(); model.setScope({ ...scope, identity: 'another-actor', messageId: 'm-2' });
  waiting.resolve(available); assert.equal(await read, null); assert.equal(model.getSnapshot().reference, null);
  const failing = new DmReferenceSession(async () => { throw new Error('Directory outage'); });
  failing.setScope(scope); assert.equal(await failing.refresh(), null); assert.equal(failing.getSnapshot().error, true);
});
test('workspace return destinations allow canonical OrgIQ pages and discard unrelated query state', () => {
  assert.equal(orgiqReferenceReturnHref('/iq/projects/project-1?tab=work&item=work-1&view=comments&q=secret#draft'), available.href);
  assert.equal(orgiqReferenceReturnHref('/iq/projects/project-1?scope=mine'), '/iq/projects/project-1');
  assert.equal(orgiqReferenceReturnHref('/iq/projects/project%3Aone?tab=work&item=work%3Aone'), '/iq/projects/project%3Aone?tab=work&item=work%3Aone');
  for (const value of ['https://evil.invalid', '//evil.invalid', '/iq/projects/../secret', '/iq/projects/%2Fevil', '/iq/projects/project-1/other', '/social/dms/a', '/iq/projects/project-1\\evil', '/iq/projects/project-1?item=../secret']) {
    assert.equal(orgiqReferenceReturnHref(value), undefined);
  }
});
