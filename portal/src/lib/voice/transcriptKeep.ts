// The on-device transcript keep (docs/voice-navigator-gaps.md G20, G26): with
// "Keep transcripts on this device" on (default off), the words of each voice
// session are saved in this browser's IndexedDB, keyed by the session id, so
// the Voice log view can show them beside the server's structured events.
// They are never sent anywhere: the server's log holds no transcript (spec §9),
// and nothing in this module fetches.
//
// Turning the control off stops keeping and deletes every kept transcript (the
// control says so), so "cleared from the same control" is one switch.
//
// The preference lives in localStorage (`voiceKeepTranscripts` = '1') behind a
// tiny external store, so the dock and the log view share one switch. Every
// storage call is guarded: a private window or blocked storage reads as off.

export const TRANSCRIPT_DB = 'voice-transcripts';
export const TRANSCRIPT_STORE = 'sessions';
export const KEEP_PREF_KEY = 'voiceKeepTranscripts';
/** The most turns one kept transcript holds (the dock's own cap is 50). */
export const KEPT_TURNS_MAX = 200;

export interface KeptTurn {
  role: 'you' | 'assistant';
  text: string;
  at: number;
  toolCalls?: Array<{ name: string; status: string; summary: string }>;
}

export interface KeptTranscript {
  sessionId: string;
  savedAt: string;
  turns: KeptTurn[];
}

export interface TranscriptStore {
  put(sessionId: string, turns: readonly KeptTurn[]): Promise<void>;
  get(sessionId: string): Promise<KeptTranscript | null>;
  ids(): Promise<string[]>;
  clear(): Promise<void>;
}

const SESSION_ID = /^vs_[0-9a-f-]{36}$/;

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Only what the strip shows: role, words, time and the tool lines. */
function keptTurns(turns: readonly KeptTurn[]): KeptTurn[] {
  return turns.slice(-KEPT_TURNS_MAX).map((t) => ({
    role: t.role, text: String(t.text ?? ''), at: Number(t.at) || 0,
    ...(t.toolCalls?.length ? { toolCalls: t.toolCalls.map((c) => ({ name: c.name, status: c.status, summary: c.summary })) } : {}),
  }));
}

/** The IndexedDB-backed store, or null where there is no IndexedDB (node, a locked-down browser). */
export function transcriptStore(idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB): TranscriptStore | null {
  if (!idb) return null;
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(TRANSCRIPT_DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(TRANSCRIPT_STORE)) d.createObjectStore(TRANSCRIPT_STORE, { keyPath: 'sessionId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { opened = null; reject(req.error ?? new Error('IndexedDB did not open')); };
    });
    return opened;
  };
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await db()).transaction(TRANSCRIPT_STORE, mode);
    const [result] = await Promise.all([requestDone(fn(tx.objectStore(TRANSCRIPT_STORE))), txDone(tx)]);
    return result;
  };
  return {
    async put(sessionId, turns) {
      if (!SESSION_ID.test(sessionId)) return;
      const row: KeptTranscript = { sessionId, savedAt: new Date().toISOString(), turns: keptTurns(turns) };
      await run('readwrite', (s) => s.put(row));
    },
    async get(sessionId) {
      if (!SESSION_ID.test(sessionId)) return null;
      const row = await run<KeptTranscript | undefined>('readonly', (s) => s.get(sessionId) as IDBRequest<KeptTranscript | undefined>);
      return row ?? null;
    },
    async ids() {
      const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
      return keys.map(String);
    },
    async clear() {
      await run('readwrite', (s) => s.clear());
    },
  };
}

// ── the preference: one switch shared by the dock and the log view ─────────

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

/** Whether transcripts are kept on this device (default off). */
export function keepTranscripts(): boolean {
  try { return storage()?.getItem(KEEP_PREF_KEY) === '1'; } catch { return false; }
}

export function subscribeKeepTranscripts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Turn the keep on or off. Off deletes every kept transcript in `store`
 * (the control's own promise: cleared from the same switch).
 */
export async function setKeepTranscripts(on: boolean, store: TranscriptStore | null = transcriptStore()): Promise<void> {
  try {
    if (on) storage()?.setItem(KEEP_PREF_KEY, '1');
    else storage()?.removeItem(KEEP_PREF_KEY);
  } catch { /* blocked storage: the keep stays off */ }
  for (const l of listeners) l();
  if (!on) await store?.clear().catch(() => undefined);
}
