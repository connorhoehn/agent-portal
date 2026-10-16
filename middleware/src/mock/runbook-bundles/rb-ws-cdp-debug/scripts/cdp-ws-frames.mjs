#!/usr/bin/env node
// runtime: node >=22 (global WebSocket and fetch)
// deps: none (node built-ins only)
// Watches a page's WebSocket traffic over the Chrome DevTools Protocol and prints one line per
// event plus a summary. Live: `node scripts/cdp-ws-frames.mjs --port 9222 [--match <url substring>]
// [--seconds 30] [--out frames.jsonl]` (Chrome must run with --remote-debugging-port=9222; --out
// saves raw CDP events for later replay). Offline: `--replay data/sample-frames.jsonl` feeds saved
// events through the same handler. `--json-summary` prints the summary as JSON. Exit: 0 ok, 2 bad args, 1 failure.
import { parseArgs } from "node:util";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";

const WS_EVENTS = new Set([
  "Network.webSocketCreated",
  "Network.webSocketFrameSent",
  "Network.webSocketFrameReceived",
  "Network.webSocketFrameError",
  "Network.webSocketClosed",
]);

const clip = (s, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// One tracker per run. Both live and replay mode call handle() with a raw {method, params} message.
export function createTracker(print = console.log) {
  const sockets = new Map(); // requestId -> number, in order of first sight
  const types = new Map();
  const t = { sent: 0, received: 0, errors: 0 };
  const label = (id) => {
    if (!sockets.has(id)) sockets.set(id, sockets.size + 1);
    return `ws#${sockets.get(id)}`;
  };
  const tally = (payload) => {
    try {
      const type = JSON.parse(payload)?.type;
      if (typeof type === "string") types.set(type, (types.get(type) ?? 0) + 1);
    } catch { /* not JSON: counted as a frame, not as a type */ }
  };
  return {
    handle(msg) {
      const p = msg?.params ?? {};
      const ws = label(p.requestId);
      switch (msg?.method) {
        case "Network.webSocketCreated": return print(`+ open  ${ws} ${p.url ?? ""}`);
        case "Network.webSocketFrameSent": {
          const data = p.response?.payloadData ?? "";
          t.sent++; tally(data);
          return print(`→ sent  ${ws} ${clip(data)}`);
        }
        case "Network.webSocketFrameReceived": {
          const data = p.response?.payloadData ?? "";
          t.received++; tally(data);
          return print(`← recv  ${ws} ${clip(data)}`);
        }
        case "Network.webSocketFrameError":
          t.errors++;
          return print(`! error ${ws} ${p.errorMessage ?? "unknown error"}`);
        case "Network.webSocketClosed": return print(`x close ${ws}`);
      }
    },
    summary() {
      const list = [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { sockets: sockets.size, ...t, types: Object.fromEntries(list) };
    },
  };
}

export function formatSummary(s) {
  const types = Object.entries(s.types).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return `summary: ${s.sockets} socket(s), ${s.sent} sent, ${s.received} received, ${s.errors} error(s); message types: ${types}`;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: cdp-ws-frames.mjs --port 9222 [--match <substr>] [--seconds N] [--out file]\n" +
    "       cdp-ws-frames.mjs --replay file.jsonl   (add --json-summary for JSON)");
  process.exit(2);
}

async function live(opts, tracker) {
  const base = `http://127.0.0.1:${opts.port}`;
  let targets;
  try {
    const res = await fetch(`${base}/json/list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    targets = await res.json();
  } catch (e) {
    throw new Error(`no DevTools endpoint at ${base} (${e.cause?.code ?? e.message}). ` +
      `Start Chrome with --remote-debugging-port=${opts.port}`);
  }
  const pages = targets.filter((x) => x.type === "page");
  const target = opts.match ? pages.find((x) => x.url.includes(opts.match)) : pages[0];
  if (!target) {
    throw new Error(`no page target ${opts.match ? `matching "${opts.match}" ` : ""}among ${pages.length} page(s): ` +
      pages.map((x) => x.url).join(", "));
  }
  console.error(`attached to ${target.url}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    let timer;
    const stop = () => { clearTimeout(timer); resolve(); };
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
      timer = setTimeout(() => { ws.close(); stop(); }, opts.seconds * 1000);
    };
    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!WS_EVENTS.has(msg.method)) return; // ignore command replies and unrelated events
      if (opts.out) appendFileSync(opts.out, JSON.stringify({ method: msg.method, params: msg.params }) + "\n");
      tracker.handle(msg);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("DevTools socket error (is another debugger attached?)")); };
    ws.onclose = stop;
    process.once("SIGINT", () => { ws.close(); stop(); });
  });
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" }, match: { type: "string" }, seconds: { type: "string", default: "30" },
        out: { type: "string" }, replay: { type: "string" }, "json-summary": { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (e) { usage(e.message); }
  const seconds = Number(values.seconds);
  if (!values.replay && !values.port) usage("need --port or --replay");
  if (values.port && !/^\d+$/.test(values.port)) usage("--port must be a number");
  if (!(seconds > 0)) usage("--seconds must be a positive number");

  const tracker = createTracker();
  try {
    if (values.replay) {
      const lines = readFileSync(values.replay, "utf8").split("\n").filter((l) => l.trim());
      lines.forEach((l, i) => {
        try { tracker.handle(JSON.parse(l)); } catch (e) { throw new Error(`${values.replay}:${i + 1}: ${e.message}`); }
      });
    } else {
      if (values.out) writeFileSync(values.out, "");
      await live({ port: values.port, match: values.match, seconds, out: values.out }, tracker);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  const s = tracker.summary();
  console.log(values["json-summary"] ? JSON.stringify(s) : formatSummary(s));
}

main();
