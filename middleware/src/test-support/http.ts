// One listening HTTP server per test FILE, instead of one per REQUEST.
//
// Why this exists
// ---------------
// supertest's `request(app)` hands an Express app (a plain
// `(req, res) => void` function) to `new Test(...)`, which wraps it in
// `http.createServer(app)` and then, in `serverAddress()`, calls
// `app.listen(0)` because the fresh server has no address yet. `Test.end()`
// closes that server again as soon as the response completes. So every single
// assertion in the route suites costs one bind + one close on an ephemeral
// port. Across ~2900 tests that is thousands of listen/close cycles per run,
// which recycles the OS ephemeral port range fast enough that a client
// occasionally lands on a port whose previous owner is mid-teardown. The
// symptom is a parse failure on the wire — `Parse Error: Expected HTTP/,
// RTSP/ or ICE/` — plus a request that never reaches the mock the test set
// up. Each suite passes alone (little churn) and a different innocent suite
// fails under parallel workers (fast churn).
//
// `jest.setup.cjs` already removed the keep-alive half of that hazard (a
// pooled socket surviving across the listen/close boundary). This module
// removes the churn itself.
//
// How it works
// ------------
// `startSharedServer()` binds ONE `http.Server` on an ephemeral port. It is
// started in a global `beforeAll` and closed in a global `afterAll` — see
// `src/test-support/jest-shared-server.ts`, wired in as
// `setupFilesAfterEnv`, so every test file gets exactly one server and every
// file cleans it up.
//
// `serverAddress()` only listens when the server it is handed has no address,
// and `Test.end()` only closes the server it itself created. Handing supertest
// an ALREADY-LISTENING server therefore skips both — supertest just builds a
// URL against the existing port.
//
// Because the port is shared, the server needs to know which app a given
// request is for. Each app passed to `request()` is registered under an id and
// the returned builder stamps `x-orgiq-test-app: <id>` on every request; the
// shared server looks the app up, strips the header, and dispatches. That
// keeps concurrent requests to two DIFFERENT apps in the same file correct
// (e.g. `Promise.all([request(buildApp()).get(a), request(buildApp()).get(b)])`
// in assessment-routes.test.ts), which a mutable single-handler server could
// not.
//
// The default export is call-compatible with supertest's, so converting a
// suite is a one-line import swap and every `request(buildApp()).get(...)`
// call site stays exactly as it was.
//
// Measured
// --------
// `routes/__tests__/ingest-routes.test.ts` (54 tests), same file, counted by
// patching `http.Server.prototype.listen`: 87 binds before, 1 after. The
// hazard itself reproduces outside jest at roughly 1 failure per 8k requests
// when each request binds its own port (3 `Parse Error: Expected HTTP/,
// RTSP/ or ICE/` in 30k), and 0 in 34k against a shared server.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';

/** Header carrying the registry id of the app a request is destined for. */
const APP_HEADER = 'x-orgiq-test-app';

/**
 * The shared server and its registry live on `globalThis`, not in module
 * scope. `setupFilesAfterEnv` shares a module registry with the test file, so
 * module scope would normally be fine — but a suite that calls
 * `jest.resetModules()` would get a second copy of this module and lose the
 * server the global `beforeAll` started. A global is immune to that.
 */
type SharedState = {
  server: http.Server | null;
  apps: Map<string, http.RequestListener>;
  /**
   * Reverse index so `request(sameApp)` twice reuses one registry slot. Suites
   * that build the app once at describe scope and drive it from many tests are
   * the common shape; without this each call would leak another entry.
   */
  ids: WeakMap<http.RequestListener, string>;
  agent: http.Agent | null;
  seq: number;
};

const STATE_KEY = '__orgiqTestHttpState__';

function state(): SharedState {
  const g = globalThis as unknown as Record<string, SharedState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { server: null, apps: new Map(), ids: new WeakMap(), agent: null, seq: 0 };
    g[STATE_KEY] = s;
  }
  return s;
}

/**
 * Keep-alive is deliberately ON for this one agent, and only for it.
 *
 * `jest.setup.cjs` turns keep-alive OFF on `http.globalAgent` because pooling
 * across supertest's per-request listen/close churn hands out sockets whose
 * server has gone away. That hazard does not exist here: this agent talks to a
 * single server that stays up for the whole file, so a pooled socket is always
 * still connected to the same live server. Reusing sockets also collapses
 * client-side port churn from ~one ephemeral port per assertion to a handful
 * per file, which is the other half of the exhaustion problem.
 *
 * Set `ORGIQ_TEST_HTTP_KEEPALIVE=0` to fall back to a fresh socket per
 * request (still against the shared server).
 */
function sharedAgent(): http.Agent | undefined {
  if (process.env.ORGIQ_TEST_HTTP_KEEPALIVE === '0') return undefined;
  const s = state();
  if (!s.agent) {
    s.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 64,
      maxFreeSockets: 8,
    });
  }
  return s.agent;
}

/** Bind the one server this test file will use. Idempotent. */
export async function startSharedServer(): Promise<http.Server> {
  const s = state();
  if (s.server) return s.server;

  const server = http.createServer((req, res) => {
    const raw = req.headers[APP_HEADER];
    const id = Array.isArray(raw) ? raw[0] : raw;
    const app = id ? s.apps.get(id) : undefined;
    if (!app) {
      // A programming error in the harness, never a product response. Make it
      // loud rather than letting it read as a plausible 500 from a route.
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        error: 'test-support/http: no app registered for this request',
        appId: id ?? null,
      }));
      return;
    }
    // Strip the routing header so the app under test sees exactly the headers
    // the test set — gatewayProxy forwards headers upstream, and other suites
    // assert on what a route received.
    delete req.headers[APP_HEADER];
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === APP_HEADER) req.rawHeaders.splice(i, 2);
    }
    app(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  s.server = server;
  return server;
}

/** Close the file's server, drop every registered app, and free the agent. */
export async function stopSharedServer(): Promise<void> {
  const s = state();
  const server = s.server;
  s.server = null;
  s.apps.clear();
  s.ids = new WeakMap();
  if (s.agent) {
    s.agent.destroy();
    s.agent = null;
  }
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // SSE suites can leave a stream open; without this the close callback
    // would never fire and the file would hang past its last test.
    server.closeAllConnections?.();
  });
}

/** The live shared server, or null when no test file has started one. */
export function sharedServer(): http.Server | null {
  return state().server;
}

/** Port the shared server is listening on. Throws if it is not up. */
export function sharedServerPort(): number {
  const server = state().server;
  if (!server) throw new Error('test-support/http: shared server is not running');
  return (server.address() as AddressInfo).port;
}

function register(app: http.RequestListener): string {
  const s = state();
  const existing = s.ids.get(app);
  if (existing && s.apps.has(existing)) return existing;
  const id = String(++s.seq);
  s.apps.set(id, app);
  s.ids.set(app, id);
  return id;
}

/**
 * Register an app on the shared server for a caller that drives raw
 * `http.get`/`http.request` instead of supertest — the SSE suites, which need
 * a long-lived stream supertest would never resolve. Returns the port to dial
 * and the headers that route to this app; merge them into the request's own
 * headers.
 */
export function attachToSharedServer(app: http.RequestListener): {
  port: number;
  headers: Record<string, string>;
} {
  const server = state().server;
  if (!server) throw new Error('test-support/http: shared server is not running');
  return { port: sharedServerPort(), headers: { [APP_HEADER]: register(app) } };
}

type SupertestRequest = ReturnType<typeof supertest>;

/**
 * Wrap a supertest builder so every request it makes carries the routing
 * header (and the shared keep-alive agent). Every method on the builder that
 * returns a `Test` goes through here; non-function properties pass straight
 * through.
 */
function stamp<T extends object>(base: T, id: string): T {
  const agent = sharedAgent();
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const test = (value as (...a: unknown[]) => unknown).apply(target, args);
        const t = test as { set?: (k: string, v: string) => unknown; agent?: (a: http.Agent) => unknown };
        if (t && typeof t.set === 'function') {
          t.set(APP_HEADER, id);
          if (agent && typeof t.agent === 'function') t.agent(agent);
        }
        return test;
      };
    },
  });
}

/**
 * Drop-in replacement for supertest's default export.
 *
 * `request(app)` routes through the file's shared server. Anything else — a
 * base-URL string, or a server the caller is managing itself — is handed
 * straight to supertest untouched, so suites that stand up their own listener
 * (the SSE ones) keep working through the same import.
 */
function request(app: unknown, options?: { http2?: boolean }): SupertestRequest {
  const server = state().server;

  // Not an app we can dispatch, or no shared server yet (module-scope call,
  // or a suite running without the setup file): behave exactly like supertest.
  if (typeof app !== 'function' || !server || options?.http2) {
    return supertest(app as never, options as never);
  }

  return stamp(supertest(server), register(app as http.RequestListener)) as SupertestRequest;
}

/**
 * Mirrors supertest's module shape for the callers that reach past the default
 * function — `request.Response` as a type annotation (auth-session,
 * session-epoch, demo-picker-switch) and `request.agent(app)` for a
 * cookie-persisting jar. Merging a namespace onto the function is how
 * supertest's own typings expose these, so the call sites read identically.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace request {
  export type Response = supertest.Response;
  export type Test = supertest.Test;
  export type SuperTest<T extends supertest.Test = supertest.Test> = supertest.SuperTest<T>;

  /** supertest's cookie-jar agent, bound to the file's shared server. */
  export function agent(app?: unknown, options?: supertest.AgentOptions): supertest.Agent {
    const server = state().server;
    if (typeof app !== 'function' || !server) {
      return supertest.agent(app as never, options as never);
    }
    return stamp(supertest.agent(server, options as never), register(app as http.RequestListener));
  }
}

export default request;
