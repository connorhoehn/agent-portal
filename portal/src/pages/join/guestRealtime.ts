// The candidate's realtime token (docs/interviews-tenant-plan.md row I2.4, the candidate's side; contract D1).
//
// The staff token source (lib/realtimeToken.ts) reads /api/session/realtime-token from the staff session, which a
// guest must never call. This is the same shape (`RealtimeTokenSource`, so the gateway socket and its REST calls take
// it as they take the staff one) reading ONLY /api/interview-invite/realtime-token on the guest cookie: one cached
// token per page, reused until a minute before it expires, concurrent callers sharing one request, and cleared when
// the link dies. No Referer, nothing cached by the browser.
//
// A not-found from that route means one of two things the page cannot tell apart: guest realtime is off in this
// deployment, or the link is no longer good. Either way the token is gone (`GuestRealtimeOff`); the room's own read
// (D1) says which page to show.
import { REFRESH_SKEW_MS, type RealtimeToken, type RealtimeTokenSource } from '../../lib/realtimeToken.ts';

export const GUEST_REALTIME_TOKEN_URL = '/api/interview-invite/realtime-token';

/** The token route answered not-found: no call from this page. */
export class GuestRealtimeOff extends Error {
  constructor() { super('guest realtime is not available'); }
}

const ENDPOINT_KEYS = ['gatewayUrl', 'platformApiUrl', 'videoUrl'] as const;
const nonBlank = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function createGuestTokenSource(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}): RealtimeTokenSource {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;
  let cached: RealtimeToken | null = null;
  let inFlight: Promise<RealtimeToken> | null = null;
  let generation = 0;

  const fresh = (t: RealtimeToken | null): t is RealtimeToken => {
    if (!t) return false;
    const exp = Date.parse(t.expiresAt);
    return Number.isFinite(exp) && exp - REFRESH_SKEW_MS > now();
  };

  async function load(gen: number): Promise<RealtimeToken> {
    const res = await doFetch(GUEST_REALTIME_TOKEN_URL, {
      credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
    });
    if (res.status === 404) {
      if (gen === generation) cached = null;
      throw new GuestRealtimeOff();
    }
    if (!res.ok) throw new Error(`guest realtime token unavailable (HTTP ${res.status})`);
    const body = await res.json() as Partial<RealtimeToken>;
    if (typeof body.token !== 'string' || !body.token || typeof body.expiresAt !== 'string') throw new Error('guest realtime token response is malformed');
    const token: RealtimeToken = { token: body.token, expiresAt: body.expiresAt };
    for (const key of ENDPOINT_KEYS) {
      const value = nonBlank(body[key]);
      if (value) token[key] = value;
    }
    if (gen === generation) cached = token;
    return token;
  }

  return {
    get({ force = false } = {}) {
      if (!force && fresh(cached)) return Promise.resolve(cached);
      if (inFlight) return inFlight;
      const p = load(generation).finally(() => { if (inFlight === p) inFlight = null; });
      inFlight = p;
      return p;
    },
    peek: () => (fresh(cached) ? cached : null),
    isFresh: () => fresh(cached),
    clear() {
      generation += 1;
      cached = null;
      inFlight = null;
    },
  };
}

/** The candidate page's one source. Cleared when the room ends or the link dies (JoinRoom). */
export const guestTokenSource: RealtimeTokenSource = createGuestTokenSource();
