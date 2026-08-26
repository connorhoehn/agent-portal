// Jest global setup — HTTP keep-alive is disabled for the whole test run.
//
// Why this exists (flaky-suite fix):
//
// supertest (`request(app)`) spins up an ephemeral server with `app.listen(0)`
// for EACH request and tears it down again the moment the response ends, so a
// full run churns through thousands of listen/close cycles and recycles OS
// ephemeral ports rapidly. superagent — supertest's client — sets no explicit
// agent, so Node routes its requests through `http.globalAgent`.
//
// Node >= 19 (this repo runs far newer) ships `http.globalAgent` with
// `keepAlive: true` by DEFAULT. That pools sockets by host:port and reuses
// them. Against supertest's listen/close churn that pooling is unsafe: a
// keep-alive socket left over from one request gets handed to a later request
// whose brand-new server has been assigned the SAME recycled port. The reused
// socket is either dead (the old server has closed) — surfacing as
// `read ECONNRESET` / "socket hang up" — or still carries the previous
// response, so the new request reads a STALE body. Both were observed:
//   * routes/topology.test.ts, routes/grants.test.ts    → ECONNRESET
//   * routes/budgets.test.ts "accepts zero"             → inherits the prior
//     it.each case's 400 instead of its own 200
//   * routes/work-items.test.ts "unknown status"        → inherits the prior
//     "period=bogus" 400
// Each suite passes alone (little port churn) and a different innocent suite
// fails under parallel workers (fast churn) — the classic signature.
//
// Turning keep-alive OFF makes every superagent request open a fresh socket
// and close it after the response, so no socket is ever reused across the
// listen/close boundary. This is a TEST-CLIENT resource fix: it changes no
// production code path (the middleware sets its own agents where it cares) and
// does not serialize the suite.

const http = require('node:http');
const https = require('node:https');

for (const agent of [http.globalAgent, https.globalAgent]) {
  if (!agent) continue;
  agent.keepAlive = false;
  if (agent.options) agent.options.keepAlive = false;
  // Drop any sockets already pooled before this ran.
  if (typeof agent.destroy === 'function') agent.destroy();
}
