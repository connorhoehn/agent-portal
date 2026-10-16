#!/usr/bin/env node
// runtime: node >=22 (global WebSocket and fetch)
// deps: none (node built-ins only)
// Tiny client for the realtime gateway's undocumented presence API, reconstructed from the portal's
// network traffic. Import { PresenceClient } (snapshot(channel), roster(room)) or run
// `node scripts/presence-client.mjs snapshot <channel> [--base http://localhost:3001] [--fixture data/presence-snapshot.json]`.
// The token comes from env GATEWAY_TOKEN (not needed with --fixture, which replays a recorded response
// through the same code path and fails if the request path differs). Exit: 0 ok, 2 bad args, 1 failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The wire format is terse: members keyed by id, short field names, epoch-ms times.
const STATUS = { on: "online", online: "online", idle: "idle", away: "idle" };
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

export function normalise(raw, fallbackName) {
  const entries = Array.isArray(raw.members)
    ? raw.members.map((m) => [m.id, m])
    : Object.entries(raw.members ?? {});
  const all = entries.map(([id, m]) => ({
    id,
    name: m.n ?? m.name ?? id,
    status: STATUS[m.st ?? m.status] ?? "online",
    lastSeen: m.ls != null ? iso(m.ls) : null,
  }));
  return {
    channel: raw.ch ?? raw.room ?? fallbackName,
    online: all.filter((m) => m.status === "online"),
    idle: all.filter((m) => m.status === "idle"), // array, so callers can list who is idle
    total: all.length,
    asOf: raw.ts != null ? iso(raw.ts) : null,
  };
}

export class PresenceClient {
  constructor({ base, token, fetch = globalThis.fetch }) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetch;
  }

  async #get(path, name) {
    const res = await this.fetch(this.base + path, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${body.error ?? "(no error field)"}`);
    return normalise(body, name);
  }

  snapshot(channel) {
    return this.#get(`/api/realtime/presence/${encodeURIComponent(channel)}`, channel);
  }

  roster(room) {
    return this.#get(`/api/realtime/rooms/${room}/roster`, room);
  }
}

// Serves a recorded fixture as if it were the gateway, refusing any other request path.
function fixtureFetch(file) {
  const fx = JSON.parse(readFileSync(file, "utf8"));
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path !== fx.request.path || (init.method ?? "GET") !== fx.request.method) {
      throw new Error(`fixture mismatch: asked for ${init.method ?? "GET"} ${path}, recorded ${fx.request.method} ${fx.request.path}`);
    }
    return new Response(JSON.stringify(fx.body), { status: fx.status, headers: { "content-type": "application/json" } });
  };
}

async function main() {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: { base: { type: "string", default: "http://localhost:3001" }, fixture: { type: "string" } },
    }));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const [cmd, channel] = positionals;
  if (cmd !== "snapshot" || !channel || positionals.length > 2) {
    console.error("usage: presence-client.mjs snapshot <channel> [--base URL] [--fixture file]");
    process.exit(2);
  }
  const token = process.env.GATEWAY_TOKEN;
  if (!token && !values.fixture) {
    console.error("GATEWAY_TOKEN is not set (export it, or use --fixture for an offline run)");
    process.exit(2);
  }
  try {
    const client = new PresenceClient({
      base: values.base,
      token: token ?? "fixture",
      fetch: values.fixture ? fixtureFetch(values.fixture) : globalThis.fetch,
    });
    const s = await client.snapshot(channel);
    console.log(`${s.channel}: ${s.online.length} online, ${s.idle.length} idle (as of ${s.asOf})`);
    for (const m of [...s.online, ...s.idle].sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`- ${m.name} (${m.id}) ${m.status}`);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
