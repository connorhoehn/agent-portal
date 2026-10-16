import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaletteRecordSearch, isAppPath, paletteSearchUrl, toPaletteGroups } from '../paletteRecords.ts';

test('every tenant has one search endpoint; orgiq keeps /api/search', () => {
  assert.equal(paletteSearchUrl('orgiq', 'auth migration'), '/api/search?q=auth%20migration&limit=12');
  assert.equal(paletteSearchUrl('access', 'req-0001'), '/api/access/search?q=req-0001&limit=12');
});

test('orgiq rows get their chip from the type and group by it; decisions open their page', () => {
  const groups = toPaletteGroups('orgiq', [
    { type: 'decision', id: 'd-aurora', title: 'Adopt Aurora over Neptune', href: '/iq/decisions/d-aurora' },
    { type: 'person', id: 'p-004', title: 'Nora DaSilva', subtitle: 'Staff Engineer', href: '/iq/search?tab=connections&selection=person%3Ap-004' },
    { type: 'decision', id: 'd-otel', title: 'Self-hosted collectors', href: '/iq/decisions/d-otel' },
  ]);
  assert.deepEqual(groups.map((g) => g.group), ['Decisions', 'People']);
  assert.equal(groups[0]!.items[0]!.kind, 'Decision');
  assert.equal(groups[0]!.items[0]!.href, '/iq/decisions/d-aurora');
});

test('a row without an in-app path is dropped, never navigated to', () => {
  assert.equal(isAppPath('//evil.example/x'), false);
  assert.equal(isAppPath('https://evil.example'), false);
  assert.equal(isAppPath('/social/channels/incidents'), true);
  assert.deepEqual(toPaletteGroups('social', [{ type: 'channel', id: 'x', title: 'x', href: '//evil.example' }, { type: 'channel', id: 'y', title: 'y', href: '' }]), []);
});

test('the search reads the tenant endpoint with the cookie and maps its rows; a failure rejects for the palette error row', async () => {
  const seen: string[] = [];
  const ok = (async (url: string, init?: RequestInit) => { seen.push(`${url} ${init?.credentials}`); return new Response(JSON.stringify({ results: [{ type: 'channel', id: 'incidents', title: '#incidents', kind: 'Channel', subtitle: 'Owner: Rachel Kowalski', href: '/social/channels/incidents' }] })); }) as unknown as typeof fetch;
  const groups = await createPaletteRecordSearch('social', ok)('incidents', { signal: new AbortController().signal });
  assert.deepEqual(seen, ['/api/social/search?q=incidents&limit=12 include']);
  assert.deepEqual(groups, [{ group: 'Channels', items: [{ id: 'channel:incidents', title: '#incidents', kind: 'Channel', href: '/social/channels/incidents', subtitle: 'Owner: Rachel Kowalski' }] }]);
  const fail = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(createPaletteRecordSearch('social', fail)('x', { signal: new AbortController().signal }), /Search 403/);
});
