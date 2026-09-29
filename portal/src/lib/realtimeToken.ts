// The realtime token: a short-lived (10-minute) HS256 JWT the BFF mints from
// the session cookie at GET /api/session/realtime-token, for the websocket
// gateway (sent as the `bearer-token-v1` subprotocol) and platform-api. The
// cookie itself never leaves this origin; this token carries identity only.
// See middleware/src/lib/realtime-token.ts and docs/social-calls-plan.md.
//
// One cached token per page, reused until REFRESH_SKEW_MS before it expires,
// with concurrent callers sharing one in-flight request. `clear()` runs on
// every tenant/role switch and sign-out (lib/tenantCaches.ts) so a token
// minted for the previous identity is never handed to the next socket.
// Dependency-free on purpose: tenantCaches.ts imports it.

export const REALTIME_TOKEN_URL = '/api/session/realtime-token';
/** Treat a token as stale this long before its `expiresAt`. */
export const REFRESH_SKEW_MS = 60_000;

export interface RealtimeToken {
  token: string;
  /** ISO-8601, from the server. */
  expiresAt: string;
  gatewayUrl?: string;
  platformApiUrl?: string;
}

export interface RealtimeTokenSource {
  /** The cached token if still fresh, else a new one. `force` skips the cache. */
  get(opts?: { force?: boolean }): Promise<RealtimeToken>;
  /** The cached token when fresh, without fetching. */
  peek(): RealtimeToken | null;
  isFresh(): boolean;
  /** Drop the cache; an in-flight request started before this is discarded. */
  clear(): void;
}

export function createRealtimeTokenSource(opts: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  url?: string;
} = {}): RealtimeTokenSource {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;
  const url = opts.url ?? REALTIME_TOKEN_URL;
  let cached: RealtimeToken | null = null;
  let inFlight: Promise<RealtimeToken> | null = null;
  let generation = 0;

  const fresh = (t: RealtimeToken | null): t is RealtimeToken => {
    if (!t) return false;
    const exp = Date.parse(t.expiresAt);
    return Number.isFinite(exp) && exp - REFRESH_SKEW_MS > now();
  };

  async function load(gen: number): Promise<RealtimeToken> {
    const res = await doFetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`realtime token unavailable (HTTP ${res.status})`);
    const body = await res.json() as Partial<RealtimeToken>;
    if (typeof body.token !== 'string' || !body.token || typeof body.expiresAt !== 'string') {
      throw new Error('realtime token response is malformed');
    }
    const token: RealtimeToken = {
      token: body.token,
      expiresAt: body.expiresAt,
      ...(body.gatewayUrl ? { gatewayUrl: body.gatewayUrl } : {}),
      ...(body.platformApiUrl ? { platformApiUrl: body.platformApiUrl } : {}),
    };
    if (gen === generation) cached = token;
    return token;
  }

  return {
    get({ force = false } = {}) {
      if (!force && fresh(cached)) return Promise.resolve(cached);
      if (inFlight) return inFlight;
      const gen = generation;
      const p = load(gen).finally(() => { if (inFlight === p) inFlight = null; });
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

/** The page-wide source; OptionalGatewayProvider and tenantCaches share it. */
export const realtimeTokenSource: RealtimeTokenSource = createRealtimeTokenSource();
const shared = realtimeTokenSource;
export const getRealtimeToken = (opts?: { force?: boolean }): Promise<RealtimeToken> => shared.get(opts);
export const realtimeTokenIsFresh = (): boolean => shared.isFresh();
export const clearRealtimeToken = (): void => shared.clear();
