// Local-compute presence — the semantics that make the badge honest.
//
// Three rules carry the whole design and each is testable without mocks:
// an announce is an authoritative snapshot (sessions absent from it are
// gone, not lingered); status is derived from heartbeat age, never claimed;
// and an offline node reports NO sessions, because presence a machine can't
// back must not be offered.

import {
  recordAnnounce,
  recordHeartbeat,
  endSession,
  presenceOf,
  statusOfNode,
  subscribePresence,
  _resetLocalFleet,
  type LocalSession,
} from '../local-compute-fleet';

const session = (id: string, extra: Partial<LocalSession> = {}): LocalSession => ({
  sessionId: id,
  harness: 'claude-code',
  lastSeenAt: '',
  ...extra,
});

beforeEach(() => _resetLocalFleet());

describe('recordAnnounce', () => {
  it('replaces the node snapshot — a session missing from the announce is gone', () => {
    recordAnnounce('n1', [session('a'), session('b')]);
    const after = recordAnnounce('n1', [session('b')]);
    expect(after.sessions.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('clamps caller-sized fields instead of storing them verbatim', () => {
    const presence = recordAnnounce('n1', [
      session('a', {
        intent: 'x'.repeat(500),
        touching: Array.from({ length: 50 }, (_, i) => `f${i}`),
      }),
    ]);
    expect(presence.sessions[0]!.intent).toHaveLength(200);
    expect(presence.sessions[0]!.touching).toHaveLength(20);
  });

  it('drops records with no sessionId rather than inventing identity', () => {
    const presence = recordAnnounce('n1', [session(''), session('real')]);
    expect(presence.sessions.map((s) => s.sessionId)).toEqual(['real']);
  });
});

describe('status derivation', () => {
  it('is connected fresh, stale after the heartbeat horizon, offline after five minutes', () => {
    const now = Date.now();
    expect(statusOfNode(new Date(now - 10_000).toISOString())).toBe('connected');
    expect(statusOfNode(new Date(now - 2 * 60_000).toISOString())).toBe('stale');
    expect(statusOfNode(new Date(now - 6 * 60_000).toISOString())).toBe('offline');
    expect(statusOfNode(null)).toBe('offline');
  });

  it('reports an unknown node as offline with no sessions', () => {
    const presence = presenceOf('never-announced');
    expect(presence.status).toBe('offline');
    expect(presence.sessions).toEqual([]);
  });

  it('hides sessions once a node has aged out — presence the machine cannot back', () => {
    jest.useFakeTimers({ now: Date.now() });
    try {
      recordAnnounce('n1', [session('a')]);
      expect(presenceOf('n1').sessions).toHaveLength(1);
      jest.setSystemTime(Date.now() + 6 * 60_000);
      const later = presenceOf('n1');
      expect(later.status).toBe('offline');
      expect(later.sessions).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('endSession and heartbeats', () => {
  it('removes exactly the ended session', () => {
    recordAnnounce('n1', [session('a'), session('b')]);
    expect(endSession('n1', 'a')).toBe(true);
    expect(presenceOf('n1').sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(endSession('n1', 'a')).toBe(false);
  });

  it('a heartbeat refreshes liveness without touching the session set', () => {
    jest.useFakeTimers({ now: Date.now() });
    try {
      recordAnnounce('n1', [session('a')]);
      jest.setSystemTime(Date.now() + 4 * 60_000);
      expect(presenceOf('n1').status).toBe('stale');
      recordHeartbeat('n1');
      const revived = presenceOf('n1');
      expect(revived.status).toBe('connected');
      expect(revived.sessions).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('subscribePresence', () => {
  it('notifies on announce, heartbeat and end — and stops after unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = subscribePresence((nodeId) => seen.push(nodeId));
    recordAnnounce('n1', [session('a')]);
    recordHeartbeat('n1');
    endSession('n1', 'a');
    expect(seen).toEqual(['n1', 'n1', 'n1']);
    unsubscribe();
    recordAnnounce('n1', [session('b')]);
    expect(seen).toHaveLength(3);
  });

  it('one throwing subscriber does not break the fan-out', () => {
    const seen: string[] = [];
    subscribePresence(() => { throw new Error('bad subscriber'); });
    subscribePresence((nodeId) => seen.push(nodeId));
    recordAnnounce('n1', [session('a')]);
    expect(seen).toEqual(['n1']);
  });
});
