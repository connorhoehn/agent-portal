// The on-device transcript keep (G20): a round trip through an IndexedDB
// stand-in with the request/transaction shape the browser's has, and the one
// switch that turns it on and, turned off, clears it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_PREF_KEY, keepTranscripts, setKeepTranscripts, subscribeKeepTranscripts, transcriptStore } from '../transcriptKeep.ts';

/** The subset of IndexedDB the store uses: open/upgrade, one object store by keyPath, put/get/getAllKeys/clear, async events. */
function fakeIndexedDB() {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const later = (fn: () => void) => setImmediate(fn);
  const request = <T>(run: () => T) => {
    const req: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    later(() => { try { req.result = run(); req.onsuccess?.(); } catch (e) { req.error = e; req.onerror?.(); } });
    return req;
  };
  const factory = {
    open(name: string) {
      const req: Record<string, unknown> & { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
      later(() => {
        const isNew = !dbs.has(name);
        const stores = dbs.get(name) ?? new Map<string, Map<string, unknown>>();
        dbs.set(name, stores);
        const keyPaths = new Map<string, string>();
        const db = {
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore: (s: string, o: { keyPath: string }) => { stores.set(s, new Map()); keyPaths.set(s, o.keyPath); },
          transaction(s: string) {
            const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore(n: string): unknown } = {
              objectStore: (n: string) => {
                const rows = stores.get(n)!;
                return {
                  put: (v: Record<string, unknown>) => request(() => { rows.set(String(v[keyPaths.get(n) ?? 'sessionId']), structuredClone(v)); return v[keyPaths.get(n) ?? 'sessionId']; }),
                  get: (k: string) => request(() => (rows.has(k) ? structuredClone(rows.get(k)) : undefined)),
                  getAllKeys: () => request(() => [...rows.keys()]),
                  clear: () => request(() => { rows.clear(); return undefined; }),
                };
              },
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            void s;
            return tx;
          },
        };
        if (!keyPaths.size) keyPaths.set('sessions', 'sessionId');
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, dbs };
}

const ID = 'vs_00000000-0000-0000-0000-0000000000cc';

test('a kept transcript round-trips IndexedDB by session id: role, words, time and the tool lines only', async () => {
  const { factory } = fakeIndexedDB();
  const store = transcriptStore(factory)!;
  assert.equal(await store.get(ID), null);
  await store.put(ID, [
    { role: 'you', text: 'Find the Kubernetes experts', at: 1000 },
    { role: 'assistant', text: 'Here is what I found.', at: 2000, toolCalls: [{ name: 'search', status: 'done', summary: '1 of 1' }], extra: 'dropped' } as never,
  ]);
  const back = await store.get(ID);
  assert.equal(back?.sessionId, ID);
  assert.deepEqual(back?.turns, [
    { role: 'you', text: 'Find the Kubernetes experts', at: 1000 },
    { role: 'assistant', text: 'Here is what I found.', at: 2000, toolCalls: [{ name: 'search', status: 'done', summary: '1 of 1' }] },
  ]);
  assert.deepEqual(await store.ids(), [ID]);
  // Only session ids are keys.
  await store.put('../../etc', [{ role: 'you', text: 'x', at: 1 }]);
  assert.deepEqual(await store.ids(), [ID]);
});

test('the switch is off by default, on keeps, and off clears every kept transcript', async () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  try {
    const { factory } = fakeIndexedDB();
    const store = transcriptStore(factory)!;
    let heard = 0;
    const off = subscribeKeepTranscripts(() => { heard += 1; });
    assert.equal(keepTranscripts(), false, 'default off');
    await setKeepTranscripts(true, store);
    assert.equal(keepTranscripts(), true);
    assert.equal(mem.get(KEEP_PREF_KEY), '1');
    await store.put(ID, [{ role: 'you', text: 'hello', at: 1 }]);
    assert.equal((await store.ids()).length, 1);
    await setKeepTranscripts(false, store);
    assert.equal(keepTranscripts(), false);
    assert.deepEqual(await store.ids(), [], 'turning it off cleared the kept transcripts');
    assert.equal(heard, 2);
    off();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('no IndexedDB: no store, and the keep reads off when storage is blocked', () => {
  assert.equal(transcriptStore(undefined), null);
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} };
  try { assert.equal(keepTranscripts(), false); } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
});
