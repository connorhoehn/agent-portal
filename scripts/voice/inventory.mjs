#!/usr/bin/env node
// scripts/voice/inventory.mjs : the voice navigator's capability inventory.
//
// Derives, with no dependencies, what the application can do and what the voice
// catalogue covers, and writes docs/voice-tool-inventory.json. The prose that
// reads it is docs/voice-tool-inventory.md.
//
//   node scripts/voice/inventory.mjs            regenerate the JSON
//   node scripts/voice/inventory.mjs --check    exit 1 when the JSON on disk is
//                                               stale, or when a write route a
//                                               person can reach has no catalogue
//                                               decision (covered, confirm or never)
//   node scripts/voice/inventory.mjs --print    the summary and the undecided rows
//
// Sources (all read from this tree, nothing fetched):
//   middleware/src/mock/core/wire/snapshots/routes.json   every mounted route with its handler's source line
//   middleware/src/mock/core/wire/snapshots/writes.json   the write-capture policy's verdict per write route
//   middleware/src/index.ts                               the mounts: prefix, requireTenant / requireAction /
//                                                         requireSession / socialGate / readForRolesElseAction
//   middleware/src/routes/*.ts                            the per-route gates on each declaration (the snapshot's
//                                                         line is used when it still points at the declaration,
//                                                         otherwise the declaration is found by method and path)
//   middleware/seeds/roles/*/*.cedar, seeds/schema.json   which role holds which action, per tenant
//   middleware/src/lib/authz.ts                           CAPABILITY_ACTIONS (the actions the portal's can() knows)
//   tenants/manifest.json                                 tenants, api prefixes, presence lobbies
//   portal/src/components/shell/portalCommands.ts         PAGES: the navigable pages, their roles and pageIds
//   middleware/src/lib/voice/catalogue.ts                 the tools voice has today, their tenants, confirm
//                                                         flags and the routes each one maps to
//
// Every row carries the decision the catalogue v2 (docs/voice-tool-inventory.md
// §3) takes for it (V2-15):
//   read / confirm / open   a catalogue tool's mapsTo names the route: derived,
//                           never a regex. A GET is a read; a write is confirm
//                           when the tool confirms, open when the call that
//                           reaches it is a no-card one (computer open-shell),
//                           read when the tool never confirms (a preview)
//   never / n/a             V2_RULES: the never list and the routes not for
//                           people (internal, dev, streams)
//   not-yet                 V2_RULES too: §3 plans a v2 tool for it, but no
//                           tool's mapsTo reaches it today (the backlog)
// A route a person can reach with none of these is undecided, which fails the
// check: a write added tomorrow needs a decision before the inventory is green
// again. So does a route a tool reaches that the never list also names.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PATHS = {
  routes: 'middleware/src/mock/core/wire/snapshots/routes.json',
  writes: 'middleware/src/mock/core/wire/snapshots/writes.json',
  index: 'middleware/src/index.ts',
  routesDir: 'middleware/src/routes',
  seeds: 'middleware/seeds/roles',
  schema: 'middleware/seeds/schema.json',
  authz: 'middleware/src/lib/authz.ts',
  manifest: 'tenants/manifest.json',
  pages: 'portal/src/components/shell/portalCommands.ts',
  catalogue: 'middleware/src/lib/voice/catalogue.ts',
  out: 'docs/voice-tool-inventory.json',
};
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

// ─── Small parsers ───────────────────────────────────────────────────────────

/** The line with its trailing `// comment` removed, quote-aware. */
function stripLineComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Source with comment lines and trailing comments removed; line numbers preserved. */
function stripComments(src) {
  let inBlock = false;
  return src.split('\n').map((line) => {
    if (inBlock) { const end = line.indexOf('*/'); if (end < 0) return ''; inBlock = false; line = line.slice(end + 2); }
    const t = line.trim();
    if (t.startsWith('/*')) { if (!line.includes('*/')) { inBlock = true; return ''; } line = line.replace(/\/\*[\s\S]*?\*\//g, ''); }
    if (t.startsWith('*')) return '';
    return stripLineComment(line);
  }).join('\n');
}

/** The text inside the parenthesis that opens at `open`, and the index after its close. */
function balanced(text, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[text[open]]];
  let q = null;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return [text.slice(open + 1, i), i + 1]; }
  }
  return [text.slice(open + 1), text.length];
}

/** Top-level comma split, quote- and bracket-aware. */
function splitArgs(text) {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === '\\') { cur += text[++i] ?? ''; } else if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const strLit = (s) => { const m = /^\s*(['"`])((?:\\.|(?!\1).)*)\1\s*$/.exec(s ?? ''); return m ? m[2] : null; };
const strLits = (s) => [...(s ?? '').matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

/** `const NAME = <expr>;` across a stripped file, one level. */
function constTable(src) {
  const table = {};
  const re = /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)(?:\s*:\s*[^=\n]+)?\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex; let depth = 0; let q = null; let expr = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) { expr += c; if (c === '\\') { expr += src[++i] ?? ''; } else if (c === q) q = null; continue; }
      if (c === '\'' || c === '"' || c === '`') { q = c; expr += c; continue; }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (c === ';' && depth === 0) break;
      if (c === '\n' && depth === 0 && /^\s*(const|let|export|function|\w+\.\w+\()/.test(src.slice(i + 1, i + 40))) break;
      expr += c;
    }
    table[m[1]] = expr.trim();
  }
  return table;
}

// ─── Gates ───────────────────────────────────────────────────────────────────

const MACHINE_AUTH = new Set(['requireServiceAuth', 'requireNodeToken', 'requireLabAuth', 'requireRunCompleteAuth', 'requireControlSecret', 'requireMockPlane']);
const IGNORED_IDENTS = new Set(['stampScenarioHeader', 'enterMockScope', 'changeHints', 'livezHandler', 'healthHandler']);
const IGNORED_CALLS = new Set(['rateLimit', 'asyncHandler', 'handler', 'handle', 'handleComments', 'mutation', 'start', 'runHandler', 'statusHandler',
  'approveHandler', 'discardHandler', 'waitingHandler', 'approvalHandler', 'postHandler', 'saveHandler', 'socialHandler', 'express', 'runReadHandlers',
  'requireSessionId', 'tenantSearchRouter', 'createHealthHandler', 'changeHints']);

function emptyGate() {
  return { tenant: null, actions: [], anyOf: false, floor: [], readRoles: [], readElseAction: null, socialGate: false, serviceAlt: false, machineAuth: false, dynamicActions: [], unresolved: [] };
}
function mergeGate(a, b) {
  return {
    tenant: a.tenant ?? b.tenant, actions: [...new Set([...a.actions, ...b.actions])], anyOf: a.anyOf || b.anyOf,
    floor: [...new Set([...a.floor, ...b.floor])], readRoles: a.readRoles.length ? a.readRoles : b.readRoles,
    readElseAction: a.readElseAction ?? b.readElseAction, socialGate: a.socialGate || b.socialGate, serviceAlt: a.serviceAlt || b.serviceAlt,
    machineAuth: a.machineAuth || b.machineAuth, dynamicActions: [...new Set([...a.dynamicActions, ...b.dynamicActions])],
    unresolved: [...new Set([...a.unresolved, ...b.unresolved])],
  };
}

/** The gate facts in one middleware expression (a call, an identifier, a spread or an array of them). */
function parseGate(expr, consts, depth = 0) {
  let g = emptyGate();
  if (!expr || depth > 4) return g;
  let e = expr.trim();
  if (e.startsWith('...')) e = e.slice(3).trim();
  if (e.startsWith('[')) { const [inner] = balanced(e, 0); for (const part of splitArgs(inner)) g = mergeGate(g, parseGate(part, consts, depth + 1)); return g; }
  if (/^(async\s*)?\(|=>/.test(e) || /^\w+\.\w+$/.test(e)) return g;           // a handler or a member expression
  const call = /^(\w+)\s*\(/.exec(e);
  if (call) {
    const name = call[1];
    const [inner] = balanced(e, e.indexOf('('));
    const args = splitArgs(inner);
    switch (name) {
      case 'requireTenant': g.tenant = strLit(args[0]); return g;
      case 'requireAction': case 'requireBoxAction': g.actions.push(strLit(args[0]) ?? `?${args[0]}`); return g;
      case 'requireAnyAction': g.actions.push(...strLits(args[0])); g.anyOf = true; return g;
      case 'requireSession': g.floor.push(strLit(args[0]) ?? 'Read'); return g;
      case 'socialGate': {
        const lits = strLits(args[0]); g.socialGate = true;
        if (lits.length) g.actions.push(...lits); else g.dynamicActions.push(args[0]);
        return g;
      }
      case 'readForRolesElseAction': g.readRoles = strLits(args[0]); g.readElseAction = strLit(args[1]); return g;
      case 'runnerOr': case 'unlessMachine': g.serviceAlt = true; for (const a of args) g = mergeGate(g, parseGate(a, consts, depth + 1)); return g;
      case 'serviceAuthOr': g.serviceAlt = true; for (const a of args.slice(1)) g = mergeGate(g, parseGate(a, consts, depth + 1)); return g;
      default:
        if (MACHINE_AUTH.has(name)) { g.machineAuth = true; return g; }
        if (IGNORED_CALLS.has(name)) return g;
        g.unresolved.push(name); return g;
    }
  }
  if (/^\w+$/.test(e)) {
    if (MACHINE_AUTH.has(e)) { g.machineAuth = true; return g; }
    if (IGNORED_CALLS.has(e) || IGNORED_IDENTS.has(e)) return g;
    if (e === 'machineMark' || e === 'sessionOrLabAuth' || e === 'runnerOr' || e === 'unlessMachine') { g.serviceAlt = true; return g; }
    if (e === 'orgiqOnly') { g.tenant = 'orgiq'; return g; }
    if (consts[e] != null) return parseGate(consts[e], consts, depth + 1);
    g.unresolved.push(e); return g;
  }
  return g;
}

// ─── The mounts (index.ts) ───────────────────────────────────────────────────

function parseIndex() {
  const raw = read(PATHS.index);
  const src = stripComments(raw);
  const consts = constTable(src);
  const imports = {};                     // router variable -> routes file
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/routes\/([\w-]+)\.js'/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) imports[name] = `src/routes/${m[2]}.ts`;
  }
  const mounts = [];                      // { prefix, routerVar|null, searchTenant|null, gate, line }
  const re = /\bapp\.use\(/g;
  let m;
  while ((m = re.exec(src))) {
    const [inner, end] = balanced(src, m.index + 'app.use'.length);
    const args = splitArgs(inner);
    const prefix = strLit(args[0]) ?? '';
    const rest = strLit(args[0]) != null ? args.slice(1) : args;
    const routerExpr = rest[rest.length - 1] ?? '';
    const gateExprs = rest.slice(0, -1);
    let gate = emptyGate();
    for (const g of gateExprs) gate = mergeGate(gate, parseGate(g, consts));
    const search = /^tenantSearchRouter\(\s*'(\w+)'\s*\)$/.exec(routerExpr);
    const routerVar = /^\w+$/.test(routerExpr) ? routerExpr : null;
    mounts.push({ prefix, routerVar, routerFile: routerVar ? imports[routerVar] ?? null : null, searchTenant: search ? search[1] : null, gate, line: lineAt(src, m.index), routerExpr });
    re.lastIndex = end;
  }
  return { mounts, imports, consts, src, raw };
}

// ─── The declarations (routes/*.ts) ─────────────────────────────────────────

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

/** Every `X.method('path', ...gates, handler)` in one file, plus router-level `X.use(gate)` and search mounts. */
function parseRouteFile(file) {
  const raw = read(file);
  const src = stripComments(raw);
  const consts = constTable(src);
  const decls = []; const routerGates = {}; const searchMounts = []; const nested = [];
  const re = /\b(\w+)\.(get|post|put|patch|delete|all|use)\(/g;
  let m;
  while ((m = re.exec(src))) {
    const routerVar = m[1]; const method = m[2];
    if (routerVar === 'res' || routerVar === 'req' || routerVar === 'store' || routerVar === 'names' || routerVar === 'map' || routerVar === 'Map') continue;
    const open = m.index + m[0].length - 1;
    const [inner, end] = balanced(src, open);
    const args = splitArgs(inner);
    const path = strLit(args[0]);
    const line = lineAt(src, m.index);
    if (method === 'use') {
      const search = args.map((a) => /tenantSearchRouter\(\s*'(\w+)'\s*\)/.exec(a)).find(Boolean);
      if (search && path != null) {
        let gate = emptyGate(); for (const a of args.slice(1, -1)) gate = mergeGate(gate, parseGate(a, consts));
        searchMounts.push({ routerVar, path, tenant: search[1], gate, line });
      } else if (args.some((a) => /^\w*Router$/.test(a.trim()))) {
        const child = args.find((a) => /^\w*Router$/.test(a.trim())).trim();
        nested.push({ parent: routerVar, child, prefix: path ?? '', line });
      } else if (path == null) {
        let gate = emptyGate(); for (const a of args) gate = mergeGate(gate, parseGate(a, consts));
        routerGates[routerVar] = mergeGate(routerGates[routerVar] ?? emptyGate(), gate);
      }
      re.lastIndex = end; continue;
    }
    if (path == null) { re.lastIndex = end; continue; }
    let gate = emptyGate();
    for (const a of args.slice(1)) gate = mergeGate(gate, parseGate(a, consts));
    // Actions asked inside the handler (isAllowed(principal, 'X')): the handler is one of the declaration's own arguments.
    const bodyActions = [...new Set([...inner.matchAll(/isAllowed\([^)]*?['"](\w+)['"]/g)].map((x) => x[1]))];
    decls.push({ file, line, routerVar, method: method.toUpperCase(), path, gate, bodyActions, declText: src.slice(m.index, end + 1).split('\n')[0].slice(0, 160) });
    re.lastIndex = end;
  }
  return { decls, routerGates, searchMounts, nested, consts };
}

// ─── Families and tenants ────────────────────────────────────────────────────

/** Source file -> family. Path overrides below refine a few. */
const FAMILY_BY_FILE = {
  'search.ts': 'search', 'tenant-search.ts': 'search', 'saved-searches.ts': 'search', 'assessment-recording-search.ts': 'search',
  'social.ts': 'social.chat', 'social-plane.ts': 'social.chat', 'people.ts': 'social.chat', 'discussions.ts': 'social.chat', 'chat-pins.ts': 'social.chat',
  'dm-page-references.ts': 'social.chat', 'page-references.ts': 'social.chat', 'social-summarize.ts': 'social.chat', 'conversation-summarize.ts': 'social.chat',
  'conversation-artifact.ts': 'social.chat', 'agent-loop.ts': 'social.chat', 'me-groups.ts': 'social.chat',
  'page-calls.ts': 'social.calls', 'call-pages.ts': 'social.calls', 'call-chat.ts': 'social.calls', 'meeting-assistant.ts': 'social.calls', 'meeting-assistant-dev.ts': 'social.calls', 'realtime-lobby-access.ts': 'social.calls',
  'devbox.ts': 'compute', 'devbox-profiles.ts': 'compute', 'local-compute.ts': 'compute', 'internal-devbox.ts': 'compute', 'gateway-proxy.ts': 'compute',
  'environments.ts': 'compute', 'internal-work-graph-compute.ts': 'compute',
  'work.ts': 'work', 'work-items.ts': 'work', 'work-graph.ts': 'work', 'runs.ts': 'work', 'projects.ts': 'work', 'decisions.ts': 'work', 'sprints.ts': 'work',
  'today.ts': 'work', 'agent-projects.ts': 'work', 'designs.ts': 'work', 'lab.ts': 'work', 'graph.ts': 'org', 'roster.ts': 'org', 'scores.ts': 'org',
  'access.ts': 'access', 'access-requests-quick.ts': 'access',
  'budgets.ts': 'budgets', 'user-budgets.ts': 'budgets', 'grants.ts': 'budgets', 'me-spend.ts': 'budgets', 'spend-report.ts': 'budgets', 'ops-switches.ts': 'budgets', 'cost.ts': 'budgets',
  'identity.ts': 'identity', 'auth.ts': 'identity', 'session.ts': 'session',
  'work-documents.ts': 'documents', 'assessment-document-workflows.ts': 'documents', 'assessment-document-source.ts': 'documents',
  'assessment-document-proposals.ts': 'documents', 'assessment-canvas.ts': 'documents', 'internal-document-grants.ts': 'documents',
  'social-deck.ts': 'documents', 'initiative-decks.ts': 'documents', 'pipeline-decks.ts': 'documents', 'assessment-decks.ts': 'documents',
  'knowledge-base.ts': 'knowledge', 'kb-admin.ts': 'knowledge', 'ingest.ts': 'knowledge', 'connections.ts': 'knowledge', 'drop.ts': 'knowledge',
  'library.ts': 'knowledge',
  'runbooks.ts': 'runbooks', 'session-briefs.ts': 'runbooks',
  'bots.ts': 'bots',
  'approvals.ts': 'approvals', 'sdlc.ts': 'approvals',
  'assessment.ts': 'assessment', 'assessment-drafts.ts': 'assessment', 'assessment-work-graph.ts': 'assessment',
  'pipelines.ts': 'pipelines', 'pipelines-work-graph.ts': 'pipelines', 'social-work-graph.ts': 'social.chat',
  'voice.ts': 'voice', 'voice-log.ts': 'voice',
  'mock-control.ts': 'dev', 'test-fixtures.ts': 'dev',
  'index.ts': 'health',
};
const OBSERVABILITY_FILES = new Set(['observability.ts', 'canary.ts', 'canary-library.ts', 'evaluations.ts', 'prompt-history.ts', 'prompt-pointers.ts', 'prompt-versions.ts',
  'prompt-evals.ts', 'harness.ts', 'calibration.ts', 'drift.ts', 'memory.ts', 'oncall.ts', 'quality.ts', 'traffic.ts', 'invocations.ts', 'tool-calls.ts', 'topology.ts',
  'guardrails-detail.ts', 'sessions.ts', 'capabilities.ts', 'agents.ts', 'agent-detail.ts']);

function familyFor(file, method, path) {
  const f = basename(file);
  if (/\/api\/work\/sweeps\b/.test(path)) return 'bots';
  if (/\/api\/social\/(plane\/)?(calls|rooms|recordings)\b/.test(path)) return 'social.calls';
  if (/\/api\/social\/(plane\/)?teams\b/.test(path)) return 'social.teams';
  if (/\/api\/social\/plane\/capabilities$/.test(path)) return 'session';
  if (/\/api\/observability\/invocations\/search$/.test(path)) return 'search';
  if (/^\/api\/pipelines\/(decks|runs\/:id\/decks)/.test(path) || /^\/api\/assessment\/(decks|teams\/:teamId\/decks)/.test(path)) return 'documents';
  if (OBSERVABILITY_FILES.has(f)) return 'observability';
  return FAMILY_BY_FILE[f] ?? 'other';
}

/** The plane (Communication) sits in the tenants whose shell embeds Social (index.ts, routes/social-plane.ts). */
const PLANE_TENANTS = ['orgiq', 'assessment', 'pipelines'];

function tenantsFor(path, gate, manifest) {
  if (gate.tenant) return [gate.tenant];
  if (path.startsWith('/api/social/plane')) return PLANE_TENANTS;
  if (gate.socialGate) return ['any'];                       // the embed router: the caller's Social grant, whatever tenant they stand in
  const t = manifest.tenants.find((x) => x.apiPrefix && (path === x.apiPrefix || path.startsWith(`${x.apiPrefix}/`)));
  if (t) return [t.id];
  return ['any'];
}

// ─── The portal pages (portalCommands.ts PAGES) ─────────────────────────────

function parsePages() {
  const src = stripComments(read(PATHS.pages));
  const consts = constTable(src);
  const start = src.indexOf('export const PAGES');
  const [body] = balanced(src, src.indexOf('[', src.indexOf('=', start)));
  const pages = [];
  const re = /\{/g; let m;
  while ((m = re.exec(body))) {
    const [obj, end] = balanced(body, m.index);
    const label = /label:\s*'((?:\\.|[^'])*)'/.exec(obj)?.[1];
    const path = /\bpath:\s*'([^']+)'/.exec(obj)?.[1];
    const tenant = /\btenant:\s*'(\w+)'/.exec(obj)?.[1];
    if (label && path && tenant) {
      const rolesExpr = /\broles:\s*([^,}]+)/.exec(obj)?.[1]?.trim();
      const roles = rolesExpr ? (rolesExpr.startsWith('[') ? strLits(rolesExpr) : strLits(consts[rolesExpr] ?? '')) : null;
      pages.push({ label, path, tenant, group: /\bgroup:\s*'([^']+)'/.exec(obj)?.[1] ?? null, roles, pageId: /\bpageId:\s*'([^']+)'/.exec(obj)?.[1] ?? null, line: lineAt(src, start + body.indexOf(obj)) });
    }
    re.lastIndex = end;
  }
  return pages;
}

// ─── The catalogue (catalogue.ts) ────────────────────────────────────────────

function parseCatalogue(manifest) {
  const raw = read(PATHS.catalogue);
  // `const NAME = ['a', 'b'] as const`: the tenant lists a tool may name (PEOPLE_TENANTS, ACTIVITY_TENANTS…).
  const arrays = Object.fromEntries([...raw.matchAll(/\bconst (\w+) = \[([^\]]*)\] as const/g)].map((m) => [m[1], strLits(m[2])]));
  const start = raw.indexOf('export const VOICE_TOOLS');
  const end = raw.indexOf('\n];', start);
  const body = raw.slice(start, end);
  const heads = [...body.matchAll(/\n\s*\{\s*\n\s*name:\s*'(\w+)'/g)];
  const tools = heads.map((h, i) => {
    const block = body.slice(h.index, heads[i + 1]?.index ?? body.length);
    const mapsTo = /mapsTo:\s*(["'])([\s\S]*?)\1\s*,?\s*\n/.exec(block)?.[2] ?? '';
    // A literal list (`['orgiq', 'social']`) whole, else the constant's name.
    const tenantsExpr = /tenants:\s*(\[[^\]]*\]|[^,\n]+)/.exec(block)?.[1]?.trim() ?? '';
    const tenants = tenantsExpr === 'VOICE_TENANTS' ? manifest.tenants.map((t) => t.id) : arrays[tenantsExpr] ?? strLits(tenantsExpr);
    // The argument values that skip the card (computer's open-shell): a mapsTo segment so labelled reaches its routes with no card.
    const noConfirm = strLits(/noConfirm:\s*\{\s*\w+:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? '');
    const refs = mapsTo.split(/;\s+/).flatMap((seg) => {
      const label = /^\s*([\w-]+):\s/.exec(seg)?.[1] ?? null;
      return routeRefs(seg, manifest).map((r) => (label && noConfirm.includes(label) ? { ...r, noCard: true } : r));
    });
    return {
      name: h[1], kind: /\bkind:\s*'(\w+)'/.exec(block)?.[1] ?? null, backing: /\bbacking:\s*'([\w-]+)'/.exec(block)?.[1] ?? null,
      confirm: /\bconfirm:\s*(true|false)/.exec(block)?.[1] === 'true', action: /\baction:\s*(?:'(\w+)'|null)/.exec(block)?.[1] ?? null,
      tenants, mapsTo, routes: refs, line: lineAt(raw, start + h.index + 1),
    };
  });
  const navStart = raw.indexOf('export const NAVIGATE_PAGES');
  const [navBody] = balanced(raw, raw.indexOf('[', raw.indexOf('=', navStart)));
  const navigatePages = [...navBody.matchAll(/id:\s*'([\w-]+)',\s*path:\s*'([^']+)',\s*tenants:\s*\[([^\]]*)\]/g)].map((m) => ({ id: m[1], path: m[2], tenants: strLits(m[3]) }));
  const voiceTenants = strLits(/export const VOICE_TENANTS = \[([^\]]*)\]/.exec(raw)?.[1] ?? '');
  return { tools, navigatePages, voiceTenants };
}

/** `METHOD /api/...` references inside a mapsTo string; `<tenant>` and `<apiPrefix>` expand to every indexed tenant's prefix. */
function routeRefs(text, manifest) {
  const refs = [];
  const tokens = [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\b|(\/api\/[A-Za-z0-9_\-/:<>]+)/g)];
  let method = 'GET';
  for (const t of tokens) {
    if (t[1]) { method = t[1]; continue; }
    let p = t[2].replace(/[?[{(,.]*$/, '');
    if (/<tenant>|<apiPrefix>/.test(p)) {
      for (const ten of manifest.tenants.filter((x) => x.apiPrefix)) refs.push({ method, path: p.replace(/\/api\/<tenant>|<apiPrefix>/, ten.apiPrefix) });
    } else refs.push({ method, path: p });
  }
  return refs;
}

const normPath = (p) => p.replace(/:[^/]+/g, ':p').replace(/\/$/, '') || '/';

// ─── The catalogue v2 decision table ─────────────────────────────────────────
//
// Each rule: [regex over `METHOD /path`, decision, v2 tool | null, note]. First match wins.
// decision: read (a read tool), confirm (an action tool behind the dock's Confirm card),
// open (the dock navigates), never (never by voice), n/a (not for people: internal, dev, health).
// The rules are what docs/voice-tool-inventory.md §3 says in prose; keep the two together.

export const V2_TOOLS = [
  { name: 'search', confirm: false, backing: 'search', description: 'Free-text search over a tenant index (people, records, questions), with scope, type, sort and limit; replaces search_people and search_records.' },
  { name: 'open', confirm: false, backing: 'route', description: 'Open a page by id, a kept result row by ref, or a record by typed ref (initiative, computer, request, run); replaces navigate, open_result and open_computer_lab.' },
  { name: 'list', confirm: false, backing: 'search', description: 'A typed collection read with filters (initiatives, computers, machines, channels, teams, DMs, requests, approvals, runs, definitions, queues, artifacts, submissions, feedback, runbooks, proposals, bots, decks, documents, budgets, sprints, decisions, work items, findings, jobs); replaces list_active_initiatives.' },
  { name: 'get', confirm: false, backing: 'search', description: 'One record by ref: its detail, status, steps, members or history.' },
  { name: 'summary', confirm: false, backing: 'search', description: 'An aggregate since a time: sweeps and bot runs, pipeline runs, the work queue, ingest jobs, the fleet, assessment rollup, access summary, health; replaces bot_sweep_status.' },
  { name: 'activity', confirm: false, backing: 'social-activity', description: 'Who is online, live and missed calls, messages, pins, what a person worked on, everything recent (as today).' },
  { name: 'budget', confirm: false, backing: 'search', description: 'Spend and allocation reads at the budgets read tier: my spend, an initiative, the org, a user, the cost aggregates.' },
  { name: 'message', confirm: true, backing: 'social-activity', description: 'Post a dictated message to a team, channel or person (as send_chat_message).' },
  { name: 'set_status', confirm: false, backing: 'social-activity', description: 'Set the caller\'s own presence and status message (as today).' },
  { name: 'call', confirm: true, backing: 'social-activity', description: 'Start a huddle or ring a person; join a live huddle the caller may see (start_call plus join).' },
  { name: 'computer', confirm: true, backing: 'work', description: 'action: start | stop | open-shell | run (safe-mode phrase) | hand-work (to a paired machine); merges start_computer, open_shell, run_command; open-shell does not confirm.' },
  { name: 'queue_work', confirm: true, backing: 'work', description: 'Queue background work and follow it with one toast: a sweep, a bot run, a pipeline dry-run, a work job, an assessment agent run or draft, a conversation command (summarize, deck, diagram, doc, agent plan), a deck revision (G19 generalised).' },
  { name: 'decide', confirm: true, backing: 'work', description: 'Decide something waiting on the caller: an access step, a pipeline step, a HITL approval, an agent change, a runbook or work proposal, an agent-loop plan, an exception, a document proposal, a review item, a design question.' },
  { name: 'create', confirm: true, backing: 'work', description: 'Create a record of a kind: access request, work item, comment or discussion post, saved search, sprint, channel, team, room, delegation, document proposal, review request.' },
  { name: 'update', confirm: true, backing: 'work', description: 'A small state change on a record the caller may edit: work item fields, pin or unpin, join or leave a channel, mark a DM read, withdraw a request, dismiss or resolve, pause or resume a bot, cancel a run, mark a job reviewed or requeued, publish a report, team membership of self, sprint items.' },
];

/**
 * The never list, the routes not for people (n/a), and §3's plan for the routes no tool reaches yet (not-yet, with
 * the v2 tool that would): [regex over `METHOD /path`, decision, tool | null, note]. First match wins, and a route a
 * tool's mapsTo names never reaches this table: read, confirm and open are not decided here (V2-15). The not-yet
 * rows shrink as kinds and actions are built.
 */
export const V2_RULES = [
  // Not for people
  [/^\w+ \/internal\//, 'n/a', null, 'service-auth plane'],
  [/^\w+ \/api\/__mock\//, 'n/a', null, 'dev-only mock control plane'],
  [/^\w+ \/api\/dev\/calls\/:[^/]+\/(transcript-lines|assistant-messages|assistant-tool-call)$/, 'n/a', null, 'dev-only injectors for the meeting assistant (transcript lines, Nova messages, a scripted tool call; mock world and flag only)'],
  [/^\w+ \/api\/observability\/test-fixtures\//, 'n/a', null, 'E2E fixtures'],
  [/^GET \/(api\/)?(health|livez)$/, 'n/a', null, 'load-balancer probe'],
  [/^\w+ \/api\/realtime\//, 'n/a', null, 'realtime token admission'],
  [/^\w+ \/api\/drop\//, 'n/a', null, 'link-token public drop'],
  [/^\w+ \/api\/uploads/, 'n/a', null, 'gateway bearer uploads'],
  // The voice plane itself and the session
  [/^GET \/api\/voice\/sessions(\/|$)/, 'never', null, 'reading your own voice session log (list, one, latest, export) is a debugging read: the page or curl, never by voice'],
  [/^\w+ \/api\/voice\//, 'n/a', null, 'the dock\'s own mint, events and close'],
  [/^GET \/api\/session\/(me|person|capabilities|users|realtime-token)$/, 'n/a', null, 'the shell reads these before the dock exists'],
  [/^POST \/api\/session\//, 'never', null, 'identity switches end the session (login, role, tenant, masquerade, logout, revoke)'],
  [/^\w+ \/api\/auth\//, 'never', null, 'SSO'],
  [/^GET \/api\/social\/plane\/capabilities$/, 'n/a', null, 'the plane\'s can()'],
  // Identity and policy: never
  [/^\w+ \/api\/identity\//, 'never', null, 'users, grants, Cedar policies and schema'],
  [/^(PUT|PATCH|POST|DELETE) \/api\/(access\/(configuration|policies)|pipelines\/configuration|assessment\/configuration|social\/plane\/bindings|social\/bindings)/, 'never', null, 'tenant configuration and policy'],
  [/^POST \/api\/access\/requests\/:[^/]+\/(sod-override|revoke)$/, 'never', null, 'ProvisionAccess / ManageAccessPolicy overrides'],
  [/^POST \/api\/access\/reviews$/, 'never', null, 'an access review campaign is a policy act'],
  // Money administration: never (reads go to budget)
  [/^(PUT|PATCH|POST|DELETE) \/api\/(budgets|user-budgets|grants|ops|devbox\/profiles)/, 'never', null, 'allocations, caps, grants, kill switches, policy profiles'],
  [/^PATCH \/api\/graph\/projects\/:[^/]+\/devbox-profile$/, 'never', null, 'ManageBudgets'],
  [/^PUT \/api\/bots\/:[^/]+\/essential$/, 'never', null, 'ManageBudgets'],
  // Observability administration: never
  [/^(PUT|PATCH|POST|DELETE) \/api\/(observability\/(canary|calibration|memory|harness|evaluations|prompt-versions|approvals\/request)|iq\/prompts|capabilities|library\/evals|agents)/, 'never', null, 'canary, judges, pointers, guardrails, browser and interpreter sessions, agent invoke'],
  [/^POST \/api\/scores\/analysis$/, 'never', null, 'leadership analysis run'],
  [/^POST \/api\/observability\/(invocations\/:[^/]+\/replay|quality\/feedback)$/, 'never', null, 'a replay spends; labelling is the page\'s row control'],
  // Knowledge, ingestion, connections: never (admin and spend)
  [/^(PUT|PATCH|POST|DELETE) \/api\/(admin\/kb-registry|ingest|connections|knowledge-base)/, 'never', null, 'ManageKB / ManageIngest, reaches S3, KB and crawlers'],
  // Compute: machine and code paths
  [/^\w+ \/api\/local-compute\/(announce|heartbeat|register|claim|log|sessions\/|jobs\/:[^/]+\/(start|heartbeat|skills|complete|debrief|log)$)/, 'n/a', null, 'node-token machine routes'],
  [/^\w+ \/api\/local-compute\/pair\//, 'never', null, 'pairing a machine is a click with a code'],
  [/^(PATCH|DELETE) \/api\/local-compute\/nodes\/:[^/]+$/, 'never', null, 'rename or unpair a machine'],
  [/^POST \/api\/local-compute\/nodes\/:[^/]+\/work$/, 'not-yet', 'computer', 'hand-work to a paired machine (ConnectLocalCompute)'],
  [/^POST \/api\/devbox\/boxes$/, 'not-yet', 'computer', 'start (as start_computer)'],
  [/^DELETE \/api\/devbox\/boxes\/:[^/]+$/, 'not-yet', 'computer', 'stop the caller\'s own computer; stops billing'],
  [/^POST \/api\/devbox\/:[^/]+\/command$/, 'not-yet', 'computer', 'run, safe-mode phrase only (as run_command)'],
  [/^POST \/api\/devbox\/:[^/]+\/shell-url$/, 'not-yet', 'computer', 'open-shell (the PTY tab)'],
  [/^(POST|PATCH|DELETE) \/api\/devbox\//, 'never', null, 'raw sessions, free-text tasks, box edits'],
  [/^(POST|PATCH|DELETE) \/api\/(environments|agent-projects|gateway)/, 'never', null, 'environments, codebases and the retired gateway bridge'],
  [/^GET \/api\/environments\/:[^/]+\/(enter|access)$/, 'never', null, 'EnterEnvironment reaches a deployed environment'],
  [/^(POST|PUT|PATCH|DELETE) \/api\/sdlc\/(policies|policy-sets|policy-proposals)/, 'never', null, 'ManageSdlcPolicies'],
  [/^POST \/api\/sdlc\/changes\/:[^/]+\/(decide|deliver)$/, 'not-yet', 'decide', 'DecideAgentChange / DeliverAgentChange'],
  [/^POST \/api\/sdlc\/changes\/:[^/]+\/(rereview|address)$/, 'not-yet', 'queue_work', 'RunDevboxTask: re-review or address a change'],
  // Work and bots
  [/^POST \/api\/work\/sweeps\/run$/, 'not-yet', 'queue_work', 'sweep (G19)'],
  [/^POST \/api\/work\/jobs$/, 'not-yet', 'queue_work', 'a work job for the fleet or a paired machine (G19)'],
  [/^POST \/api\/work\/jobs\/:[^/]+\/(review|requeue)$/, 'not-yet', 'update', 'ManageDevbox'],
  [/^DELETE \/api\/work\/jobs\/:[^/]+$/, 'never', null, 'destructive'],
  [/^POST \/api\/work\/dispatch$/, 'never', null, 'drains the queue; a click'],
  [/^POST \/api\/work\/findings\/:[^/]+\/(promote|analyze)$/, 'not-yet', 'queue_work', 'promote a finding to a job, analyse it'],
  [/^POST \/api\/work\/findings\/analyze-batch$/, 'never', null, 'batch spend'],
  [/^POST \/api\/work\/findings\/:[^/]+\/dismiss$/, 'not-yet', 'update', 'ManageDevbox'],
  [/^POST \/api\/work\/proposals$/, 'never', null, 'agent-proposed graph writes are the agents\' route'],
  [/^POST \/api\/work\/proposals\/:[^/]+\/decide$/, 'not-yet', 'decide', 'ManageDevbox'],
  [/^POST \/api\/bots\/dispatch-work$/, 'not-yet', 'queue_work', 'DispatchAgentRun with the route\'s own estimate and confirm flags'],
  [/^POST \/api\/bots\/:[^/]+\/run$/, 'not-yet', 'queue_work', 'bot run (G19)'],
  [/^POST \/api\/bots\/:[^/]+\/(pause|resume)$/, 'not-yet', 'update', 'ManageBots'],
  [/^(POST|PATCH) \/api\/bots\/?$|^PATCH \/api\/bots\/:[^/]+$/, 'never', null, 'bot missions are authored on the page'],
  [/^DELETE \/api\/bots\/:[^/]+$/, 'never', null, 'destructive'],
  [/^\w+ \/api\/bots\/work-items\/:[^/]+\/(job-draft|estimate|review-estimate)$/, 'never', null, 'the dispatch drawer\'s own drafts and estimates'],
  [/^POST \/api\/graph\/work-items$/, 'not-yet', 'create', 'work item (DispatchAgentRun)'],
  [/^PATCH \/api\/graph\/work-items\/:[^/]+$/, 'not-yet', 'update', 'status, assignee, sprint'],
  [/^POST \/api\/graph\/(work-items\/:[^/]+|projects\/:[^/]+\/discussion)\/comments$/, 'not-yet', 'create', 'a comment (ViewWorkItems)'],
  [/^(POST|PUT|PATCH|DELETE) \/api\/graph\/work-items\/:[^/]+\/(criteria|decisions|documents|runbook-pins)/, 'never', null, 'acceptance criteria, decisions, document links and runbook pins are edited on the item'],
  // G55: creating a blank page or whiteboard (a title, no content) is `create`; what is written in it stays in the editor.
  [/^(PUT|PATCH|DELETE) \/api\/graph\/projects\/:[^/]+\/workspace-documents|^(POST|PUT|PATCH|DELETE) \/api\/graph\/documents/, 'never', null, 'document content'],
  [/^PATCH \/api\/graph\/projects\/:[^/]+(\/contributors\/:[^/]+)?$/, 'never', null, 'initiative governance edits'],
  [/^POST \/api\/graph\/projects$/, 'never', null, 'creating an initiative is a form on the page (CreateInitiative)'],
  [/^(POST|GET) \/api\/calls\/:[^/]+\/assistant\/(invite|extend|pause|resume|dismiss|ack|state|transcript)$/, 'never', null, 'the meeting assistant is run from the call bar and its own words; a voice session is one person, and invite, extend (it holds money against the inviter), pause, dismiss and the transcription acknowledgement are consent acts a person makes with a click (InviteMeetingAssistant)'],
  [/^(POST|GET) \/api\/calls\/:[^/]+\/assistant\/turns(\/:[^/]+\/result)?$/, 'never', null, 'the exchange between the meeting assistant and the asking person\'s own browser: the server lists the tool calls made for that person and takes the result they ran (never anyone else\'s); it is the transport of a tool call, not a tool of its own'],
  [/^POST \/api\/calls\/:[^/]+\/assistant\/actions\/:[^/]+\/decision$/, 'never', null, 'a confirmation is the asking person clicking Confirm or Decline on the card in the call chat; the server accepts it only from the person the action was offered to, and a spoken yes confirms nothing (design decision 5)'],
  [/^POST \/api\/sprints$/, 'not-yet', 'create', 'sprint (ManageSprints)'],
  [/^(PATCH|DELETE) \/api\/sprints\/:[^/]+\/items/, 'not-yet', 'update', 'move work between sprints (ManageSprints)'],
  [/^POST \/api\/designs\/:[^/]+\/(answer|signoff)$/, 'not-yet', 'decide', 'a design question or sign-off (DispatchAgentRun)'],
  [/^POST \/api\/lab\/consults\/:[^/]+\/answer$/, 'not-yet', 'decide', 'answer a computer-lab consult'],
  [/^POST \/api\/lab\//, 'n/a', null, 'lab envelope machine routes'],
  // Runbooks
  [/^POST \/api\/runbooks\/proposals\/:[^/]+\/(accept|reject|merge)$/, 'not-yet', 'decide', 'ReviewRunbook'],
  [/^POST \/api\/runbooks\/proposals\/:[^/]+\/withdraw$/, 'not-yet', 'update', 'own proposal'],
  [/^POST \/api\/runbooks\/proposals$/, 'never', null, 'a proposal is a diff, authored on the page or by a box'],
  [/^POST \/api\/runbooks\/:[^/]+\/retire$/, 'never', null, 'destructive for the fleet'],
  [/^POST \/api\/runbooks\/:[^/]+\/applications$/, 'n/a', null, 'lab envelope'],
  // Approvals (HITL)
  [/^POST \/api\/observability\/approvals\/:[^/]+\/decision$/, 'not-yet', 'decide', 'ApproveTransaction with the amount'],
  // Social
  [/^POST \/api\/social\/(plane\/)?dms$/, 'not-yet', 'message', 'open the DM at confirm (G14)'],
  [/^POST \/api\/social\/(plane\/)?dms\/read$/, 'not-yet', 'update', 'mark read'],
  [/^POST \/api\/social\/(plane\/)?channels\/:[^/]+\/(join|leave)$/, 'not-yet', 'update', 'PostMessage / ViewSocial'],
  [/^POST \/api\/social\/(plane\/)?(channels|teams|rooms)$/, 'not-yet', 'create', 'ManageChannels / ManageTeams'],
  [/^PATCH \/api\/social\/(plane\/)?teams\/:[^/]+\/me$/, 'not-yet', 'update', 'own membership preference'],
  [/^(POST|DELETE) \/api\/social\/(plane\/)?teams\/:[^/]+\/members/, 'never', null, 'adding or removing other people'],
  [/^PATCH \/api\/social\/(plane\/)?rooms\/:[^/]+$/, 'never', null, 'room settings'],
  [/^POST \/api\/social\/(plane\/)?recordings\/:[^/]+\/share$/, 'never', null, 'sharing a recording reaches people with content'],
  [/^DELETE \/api\/social\/(plane\/)?recordings\/:[^/]+$/, 'never', null, 'destructive'],
  // Creating a share is message's attach (G24, behind its card); stopping, pausing or expiring one stays the page's.
  [/^POST \/api\/social\/plane\/work-sharing\/:[^/]+\/transition$/, 'never', null, 'work-sharing transitions are the page\'s'],
  [/^POST \/api\/chat\/pins$/, 'not-yet', 'update', 'pin a message'],
  [/^DELETE \/api\/chat\/pins$/, 'not-yet', 'update', 'unpin'],
  [/^POST \/api\/(chat\/commands|conversations)(\/summarize)?\/(summarize|diagram|doc|deck|agent)?\/?run$/, 'not-yet', 'queue_work', 'a conversation command run'],
  [/^POST \/api\/(chat\/commands|conversations)(\/summarize)?\/(summarize|diagram|doc|deck|agent)?\/?runs\/:[^/]+\/(post|save)$/, 'not-yet', 'update', 'post or save the finished run'],
  [/^POST \/api\/(chat\/commands|conversations)\/agent\/runs\/:[^/]+\/(approve|discard|approval\/approve|approval\/reject)$/, 'not-yet', 'decide', 'an agent-loop plan or approval step'],
  [/^(PUT|DELETE) \/api\/calls\/:[^/]+\/page$/, 'never', null, 'page sharing is the live call\'s own control'],
  // Decks
  [/^POST \/api\/(initiative-decks\/projects\/:[^/]+|assessment\/teams\/:[^/]+\/decks|pipelines\/runs\/:[^/]+\/decks)$/, 'not-yet', 'queue_work', 'build a deck'],
  [/^POST \/api\/(initiative-decks|assessment\/decks|pipelines\/decks|chat\/decks)\/:[^/]+\/revise$/, 'not-yet', 'queue_work', 'revise a deck'],
  [/^POST \/api\/(initiative-decks|assessment\/decks|pipelines\/decks|chat\/decks)\/:[^/]+\/(revisions|preview)$/, 'never', null, 'editor saves and previews'],
  [/^POST \/api\/chat\/decks\/:[^/]+\/post$/, 'not-yet', 'update', 'post a deck to the conversation (PostMessage)'],
  // Access
  [/^POST \/api\/access\/requests\/preview$/, 'not-yet', 'create', 'the preview the card shows before filing'],
  [/^POST \/api\/access\/requests$/, 'not-yet', 'create', 'access request (RequestAccess)'],
  [/^POST \/api\/access-requests\/(quick|envelope)$/, 'not-yet', 'create', 'the in-tenant quick request'],
  [/^POST \/api\/access\/requests\/:[^/]+\/withdraw$/, 'not-yet', 'update', 'own request'],
  [/^POST \/api\/access\/requests\/:[^/]+\/steps\/:[^/]+\/decide$/, 'not-yet', 'decide', 'DecideAccess'],
  [/^POST \/api\/access\/reviews\/:[^/]+\/items\/:[^/]+\/decide$/, 'not-yet', 'decide', 'DecideAccess'],
  [/^POST \/api\/access\/delegations$/, 'not-yet', 'create', 'delegate my approvals (DecideAccess)'],
  [/^POST \/api\/access\/delegations\/:[^/]+\/end$/, 'not-yet', 'update', 'end a delegation'],
  // Assessment
  [/^POST \/api\/assessment\/runs$/, 'not-yet', 'queue_work', 'RunAssessmentAgent'],
  [/^POST \/api\/assessment\/runs\/:[^/]+\/stop$/, 'not-yet', 'update', 'stop a run'],
  [/^POST \/api\/assessment\/runs\/:[^/]+\/complete$/, 'n/a', null, 'agent callback'],
  [/^POST \/api\/assessment\/teams\/:[^/]+\/dimensions\/:[^/]+\/drafts\//, 'not-yet', 'queue_work', 'evidence summary or follow-up drafts'],
  [/^POST \/api\/assessment\/drafts\/:[^/]+\/(accept|discard|revise)$/, 'not-yet', 'decide', 'a draft'],
  [/^PATCH \/api\/assessment\/teams\/:[^/]+\/exceptions\/:[^/]+$/, 'not-yet', 'decide', 'ApproveException'],
  [/^POST \/api\/assessment\/feedback\/:[^/]+\/(resolve|dismiss)$/, 'not-yet', 'update', 'ScoreAssessment'],
  [/^POST \/api\/assessment\/feedback$/, 'not-yet', 'create', 'a follow-up (ScoreAssessment)'],
  [/^POST \/api\/assessment\/reports\/publish$/, 'not-yet', 'update', 'PublishReport reaches readers'],
  [/^POST \/api\/assessment\/knowledge\/doc\/(proposals|workflows\/review-requests)$/, 'not-yet', 'create', 'a document proposal or review request'],
  [/^POST \/api\/assessment\/knowledge\/doc\/proposals\/:[^/]+\/decision$/, 'not-yet', 'decide', 'a document proposal'],
  [/^(POST|PATCH|DELETE) \/api\/assessment\/knowledge\/doc\/workflows\/(sections|comments|review-requests|transitions|ownership|versions)/, 'never', null, 'document workflow edits stay in the editor'],
  [/^POST \/api\/assessment\/knowledge\/doc\/(comment|reaction)$|^(PATCH|DELETE) \/api\/assessment\/knowledge\/doc\/comment$/, 'never', null, 'editor comments and reactions'],
  [/^(POST|PUT|PATCH|DELETE) \/api\/assessment\/knowledge\//, 'never', null, 'ManageKnowledge document content and sources'],
  [/^POST \/api\/assessment\/(teams(\/:[^/]+\/(evidence|intake\/\w+|scores\/apply|reset-assessment))?|submissions\/\w+)$|^(PATCH|DELETE) \/api\/assessment\/(teams|submissions)\//, 'never', null, 'scoring, intake and submissions are form work'],
  [/^POST \/api\/assessment\/canvas$/, 'never', null, 'canvas render'],
  // Pipelines
  [/^POST \/api\/pipelines\/definitions\/:[^/]+\/dry-run$/, 'not-yet', 'queue_work', 'RunPipeline dry-run (G19)'],
  [/^POST \/api\/pipelines\/approvals\/:[^/]+\/decide$/, 'not-yet', 'decide', 'ApproveStep'],
  [/^POST \/api\/pipelines\/runs\/:[^/]+\/cancel$/, 'not-yet', 'update', 'CancelRun'],
  [/^PUT \/api\/pipelines\/definitions\/:[^/]+\/approvers$/, 'never', null, 'AuthorDefinition'],
  // Search
  [/^(POST|PATCH|DELETE) \/api\/saved-searches/, 'not-yet', 'create', 'save, rename or drop a saved search of my own'],
  // Reads: which tool answers them
  [/^GET \/api\/(search|\w+\/search|social\/plane\/search|assessment\/recordings\/search|observability\/invocations\/search)(\/answer|\/records)?$/, 'not-yet', 'search', 'the tenant index'],
  [/^GET \/api\/(me\/spend|spend|budgets|user-budgets|grants|observability\/cost|ops|devbox\/profiles|sprints\/envelopes)/, 'not-yet', 'budget', 'the budgets read tier'],
  [/^GET \/api\/(work\/summary|work\/findings\/stats|work\/sweeps\/runs|bots\/active-runs|pipelines\/summary|pipelines\/queues|assessment\/rollup|access\/summary|social\/(plane\/)?summary|social\/plane\/active|ingest\/(stats|jobs|queue)|admin\/kb-registry\/health|devbox\/status|local-compute\/nodes|local-compute\/runs|today|work\/suggestions|work\/ask-suggestions|discussions\/unread|observability\/summary|observability\/health)/, 'not-yet', 'summary', 'an aggregate'],
  [/^GET \/api\/observability\/approvals$/, 'not-yet', 'list', 'the HITL inbox: what waits on the caller (§2.10)'],
  [/^GET \/api\/library\/evals/, 'never', null, 'eval sets are the studio\'s'],
  [/^GET \/api\/(observability|topology|iq\/prompts|capabilities|agents|agent-detail|sessions|admin\/kb-registry|ingest|connections|knowledge-base|identity|graph\/(entities|skills-graph|projects-graph|help)|scores)/, 'never', null, 'operator consoles, agent-facing reads and leadership data: the page, not the voice'],
  [/^GET \/api\/[\w/-]+\/(stream|events|tail|log\/stream)$/, 'n/a', null, 'a stream'],
  [/^GET \/api\/[\w-]+(\/[\w-]+)*\/:[^/]+(\/[\w-]+)*$/, 'not-yet', 'get', 'one record'],
  [/^GET \/api\//, 'not-yet', 'list', 'a collection'],
];

/** The rule table's decision for a route (never, n/a or not-yet), else null. */
function ruled(method, path) {
  const key = `${method} ${path}`;
  for (const [re, decision, tool, note] of V2_RULES) if (re.test(key)) return { decision, tool, note };
  return null;
}

/**
 * A route's decision: from the tools whose mapsTo names it (read, confirm, open), else the never list, else the
 * backlog (not-yet), else undecided.
 */
function decide(method, path, covering) {
  if (covering.length) {
    const [{ tool, ref }] = covering;
    if (method === 'GET') return { decision: 'read', tool: tool.name, note: 'mapsTo' };
    const confirmed = covering.find((c) => c.tool.confirm && !c.ref.noCard);
    if (confirmed) return { decision: 'confirm', tool: confirmed.tool.name, note: 'mapsTo' };
    return { decision: ref.noCard ? 'open' : 'read', tool: tool.name, note: ref.noCard ? 'mapsTo, no card' : 'mapsTo, a read before the card' };
  }
  return ruled(method, path) ?? { decision: null, tool: null, note: 'UNDECIDED' };
}

// ─── Build ───────────────────────────────────────────────────────────────────

function build() {
  const manifest = readJson(PATHS.manifest);
  const snapshot = readJson(PATHS.routes);
  const writes = readJson(PATHS.writes);
  const index = parseIndex();
  const pages = parsePages();
  const catalogue = parseCatalogue(manifest);
  const schemaActions = Object.keys(Object.values(readJson(PATHS.schema))[0]?.actions ?? {});
  const capabilityActions = strLits(/export const CAPABILITY_ACTIONS = \[([\s\S]*?)\] as const/.exec(read(PATHS.authz))?.[1] ?? '');

  // Role seeds: tenant/role -> actions.
  const roles = {};
  const walk = (dir, tenant) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), entry.name);
      else if (entry.name.endsWith('.cedar')) {
        const text = stripComments(read(join(dir, entry.name)));   // comments inside a policy carry parentheses
        // Permits minus the forbids that bind on the role alone; a forbid conditioned on the
        // resource (DecideAgentChange when the principal is the author) leaves the action held.
        const permitted = new Set(); const forbidden = new Set();
        for (const m of text.matchAll(/\b(permit|forbid)\s*\(([\s\S]*?)\)\s*(when\s*\{[\s\S]*?\})?\s*;/g)) {
          if (m[1] === 'forbid' && /\b(resource|context)\b/.test(m[3] ?? '')) continue;
          for (const a of m[2].matchAll(/Action::"(\w+)"/g)) (m[1] === 'permit' ? permitted : forbidden).add(a[1]);
        }
        roles[`${tenant ?? 'cross-tenant'}/${entry.name.replace('.cedar', '')}`] = [...permitted].filter((a) => !forbidden.has(a));
      }
    }
  };
  walk(PATHS.seeds, null);
  const holders = (action) => Object.entries(roles).filter(([, a]) => a.includes(action)).map(([r]) => r);

  // Declarations per file.
  const files = readdirSync(join(ROOT, PATHS.routesDir)).filter((f) => f.endsWith('.ts')).map((f) => `src/routes/${f}`);
  const parsed = {};
  for (const f of files) parsed[f] = parseRouteFile(join('middleware', f));
  parsed['src/index.ts'] = { decls: parseRouteFile(PATHS.index).decls.filter((d) => d.routerVar === 'app'), routerGates: {}, searchMounts: [], consts: {} };

  const joinPath = (prefix, p) => (p === '/' ? prefix || '/' : `${prefix}${p}`).replace(/\/{2,}/g, '/');
  const nestedAll = Object.values(parsed).flatMap((info) => info.nested ?? []);
  /** The mounts a router variable sits under: index.ts directly, or through a parent router's `.use([prefix,] child)`. */
  const mountsForVar = (v, depth = 0) => {
    const direct = index.mounts.filter((m) => m.routerVar === v);
    if (direct.length || depth > 3) return direct;
    return nestedAll.filter((n) => n.child === v).flatMap((n) => mountsForVar(n.parent, depth + 1).map((pm) => ({ ...pm, prefix: joinPath(pm.prefix, n.prefix || '/'), via: `${n.parent}.use('${n.prefix}') ` })));
  };
  const fileOfVar = (v) => Object.entries(parsed).find(([, info]) => info.decls.some((d) => d.routerVar === v))?.[0] ?? null;
  const mountsForFile = (f) => {
    const direct = index.mounts.filter((m) => m.routerFile === f);
    if (direct.length) return direct;
    const vars = [...new Set((parsed[f]?.decls ?? []).map((d) => d.routerVar))];
    return vars.flatMap((v) => mountsForVar(v));
  };
  void fileOfVar;

  /** Every declared route in the tree, mounted: for the drift check and for routes the snapshot lacks. */
  const declared = [];
  for (const [file, info] of Object.entries(parsed)) {
    for (const d of info.decls) {
      const mounts = file === 'src/index.ts' ? [{ prefix: '', gate: emptyGate(), line: 0 }] : (mountsForVar(d.routerVar).length ? mountsForVar(d.routerVar) : mountsForFile(file));
      for (const mt of mounts) declared.push({ ...d, file, fullPath: joinPath(mt.prefix, d.path), mount: mt, routerGate: info.routerGates[d.routerVar] ?? emptyGate() });
    }
    for (const sm of info.searchMounts) {
      const mounts = mountsForVar(sm.routerVar).length ? mountsForVar(sm.routerVar) : mountsForFile(file);
      for (const mt of mounts) for (const sub of ['/', '/answer']) {
        declared.push({ file: 'src/routes/tenant-search.ts', line: sm.line, routerVar: sm.routerVar, method: 'GET', path: joinPath(sm.path, sub), gate: sm.gate, bodyActions: [],
          declText: `tenantSearchRouter('${sm.tenant}') via ${sm.routerVar}.use('${sm.path}') (${basename(file)}:${sm.line})`, fullPath: joinPath(mt.prefix, joinPath(sm.path, sub)), mount: mt, routerGate: emptyGate(), searchTenant: sm.tenant });
      }
    }
  }
  for (const mt of index.mounts.filter((m) => m.searchTenant)) {
    for (const sub of ['/', '/answer']) declared.push({ file: 'src/index.ts', line: mt.line, routerVar: null, method: 'GET', path: sub, gate: emptyGate(), bodyActions: [],
      declText: `tenantSearchRouter('${mt.searchTenant}') (index.ts:${mt.line})`, fullPath: joinPath(mt.prefix, sub), mount: mt, routerGate: emptyGate(), searchTenant: mt.searchTenant });
  }
  const declKey = (d) => `${d.method} ${normPath(d.fullPath)}`;
  const declIndex = new Map();
  for (const d of declared) { const k = declKey(d); if (!declIndex.has(k)) declIndex.set(k, []); declIndex.get(k).push(d); }

  const rows = [];
  const contradictions = [];
  const snapshotKeys = new Set();
  const unresolvedDeclarations = [];
  const resolveRoute = (method, path, source) => {
    const [file, lineStr] = source.split(':'); const line = Number(lineStr);
    const key = `${method} ${normPath(path)}`;
    const candidates = (declIndex.get(key) ?? []).filter((d) => d.file === file || source.startsWith('src/index'));
    let decl = candidates.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0] ?? null;
    let stale = false;
    if (decl && decl.line !== line) stale = true;
    if (!decl) {
      const any = (declIndex.get(key) ?? [])[0];
      if (any) { decl = any; stale = true; } else unresolvedDeclarations.push({ method, path, source });
    }
    return { decl, stale };
  };

  let snapshotDuplicates = 0;
  for (const r of snapshot.routes) {
    const key = `${r.method} ${normPath(r.path)}`;
    if (snapshotKeys.has(key)) { snapshotDuplicates++; continue; }
    const { decl, stale } = resolveRoute(r.method, r.path, r.source);
    snapshotKeys.add(key);
    rows.push(makeRow(r.method, r.path, r.source, decl, { stale, snapshot: true }));
  }
  const missingFromSnapshot = [];
  for (const d of declared) {
    const k = declKey(d);
    if (snapshotKeys.has(k)) continue;
    if (d.method === 'ALL') continue;
    snapshotKeys.add(k);
    missingFromSnapshot.push(`${d.method} ${d.fullPath} (${d.file}:${d.line})`);
    rows.push(makeRow(d.method, d.fullPath, `${d.file}:${d.line}`, d, { stale: false, snapshot: false }));
  }

  function makeRow(method, path, source, decl, flags) {
    const file = source.split(':')[0];
    const mountGate = decl?.mount?.gate ?? (mountsForFile(file).find((m) => path.startsWith(m.prefix))?.gate ?? emptyGate());
    const gate = mergeGate(mergeGate(decl?.gate ?? emptyGate(), decl?.routerGate ?? emptyGate()), mountGate);
    const isGet = method === 'GET';
    const actions = [...new Set([...gate.actions, ...(gate.readElseAction && !isGet ? [gate.readElseAction] : [])])];
    // A write whose only Cedar check sits inside the handler (approvals.ts isAllowed) reports that action; a GET keeps null, the body check shapes the body.
    const cedarAction = actions[0] ?? (isGet && gate.readElseAction ? gate.readElseAction : null) ?? (!isGet ? decl?.bodyActions?.[0] : null) ?? null;
    const machineOnly = gate.machineAuth && !gate.serviceAlt && !gate.floor.length && !actions.length && !gate.tenant;
    let kind = isGet ? 'read' : 'write';
    const fam = decl?.searchTenant ? 'search' : familyFor(file, method, path);
    if (fam === 'dev') kind = 'dev';
    else if (path.startsWith('/internal/') || machineOnly || fam === 'health' || /^\/api\/(realtime|drop|uploads)\b/.test(path)) kind = 'internal';
    const wp = writes.routes[`${method} ${path}`];
    const writePolicy = !wp ? null : wp.refused ? `refused:${wp.refused.rule}` : wp.skipped ? 'skipped' : 'allowed';
    const tenants = tenantsFor(path, gate, manifest);
    const covering = catalogue.tools.flatMap((t) => t.routes.filter((ref) => ref.method === method && normPath(ref.path) === normPath(path)).slice(0, 1).map((ref) => ({ tool: t, ref })));
    const coveredBy = covering.map((c) => c.tool.name);
    const d = kind === 'internal' || kind === 'dev' ? { decision: 'n/a', tool: null, note: kind } : decide(method, path, covering);
    // A tool reaches a route the never list names: the catalogue and the list disagree (the check fails).
    if (coveredBy.length && ruled(method, path)?.decision === 'never') contradictions.push(`${method} ${path} (${coveredBy.join(', ')})`);
    return {
      method, path, source, declaredAt: decl ? `${decl.file}:${decl.line}` : null, stale: flags.stale, snapshot: flags.snapshot,
      tenants, kind, family: fam, cedarAction, actions, anyOf: gate.anyOf || undefined, readRoles: gate.readRoles.length ? gate.readRoles : undefined,
      readElseAction: gate.readElseAction ?? undefined, floor: gate.floor.length ? gate.floor : undefined, socialGate: gate.socialGate || undefined,
      serviceAlt: gate.serviceAlt || undefined, machineAuth: gate.machineAuth || undefined, dynamicActions: gate.dynamicActions.length ? gate.dynamicActions : undefined,
      bodyActions: decl?.bodyActions?.length ? decl.bodyActions : undefined, unresolvedGates: gate.unresolved.length ? gate.unresolved : undefined,
      holders: cedarAction ? holders(cedarAction) : undefined, writePolicy, pageId: null, coveredBy, v2: d,
    };
  }

  // Pages as rows of their own; a page id open names is covered by `open` (catalogue v2).
  const navIds = new Set(catalogue.navigatePages.map((p) => p.id));
  const pageRows = pages.map((p) => ({
    method: 'PAGE', path: p.path, source: `portal/src/components/shell/portalCommands.ts:${p.line}`, tenants: [p.tenant], kind: 'navigate', family: 'navigate',
    cedarAction: null, label: p.label, group: p.group, roles: p.roles, pageId: p.pageId, coveredBy: p.pageId && navIds.has(p.pageId) ? ['open'] : [],
    v2: { decision: 'open', tool: 'open', note: p.pageId ? 'a page id' : 'needs a pageId before open can name it' },
  }));

  const all = [...rows, ...pageRows];
  const people = rows.filter((r) => r.kind === 'read' || r.kind === 'write');
  const count = (arr, f) => arr.reduce((acc, x) => { const k = f(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const families = {};
  for (const r of all) {
    const f = families[r.family] ??= { total: 0, read: 0, write: 0, navigate: 0, internal: 0, dev: 0, covered: 0, v2: {} };
    f.total++; f[r.kind]++; if (r.coveredBy.length) f.covered++;
    const dk = r.v2.decision ?? 'undecided'; f.v2[dk] = (f.v2[dk] ?? 0) + 1;
  }
  const undecided = people.filter((r) => !r.v2.decision);
  const unknownActions = [...new Set(rows.flatMap((r) => r.actions))].filter((a) => !a.startsWith('?') && !schemaActions.includes(a));
  const summary = {
    routes: rows.length, routesInSnapshot: snapshot.routes.length, snapshotDuplicates, routesDeclaredNotInSnapshot: missingFromSnapshot.length, pages: pageRows.length,
    byKind: count(all, (r) => r.kind), byFamily: families, byTenant: count(people, (r) => r.tenants.join('+')),
    peopleRoutes: people.length, peopleReads: people.filter((r) => r.kind === 'read').length, peopleWrites: people.filter((r) => r.kind === 'write').length,
    coveredRoutes: people.filter((r) => r.coveredBy.length).length, coveredReads: people.filter((r) => r.kind === 'read' && r.coveredBy.length).length,
    coveredWrites: people.filter((r) => r.kind === 'write' && r.coveredBy.length).length, coveredPages: pageRows.filter((r) => r.coveredBy.length).length,
    pagesWithPageId: pageRows.filter((r) => r.pageId).length,
    v1Tools: catalogue.tools.length, v2Tools: V2_TOOLS.length, v2Decisions: count(people, (r) => r.v2.decision ?? 'undecided'),
    v2ToolRoutes: count(people.filter((r) => r.v2.tool && r.v2.decision !== 'not-yet'), (r) => r.v2.tool),
    v2Backlog: count(people.filter((r) => r.v2.decision === 'not-yet'), (r) => r.v2.tool), undecided: undecided.map((r) => `${r.method} ${r.path}`), contradictions,
    staleSnapshotLines: rows.filter((r) => r.stale).length, unresolvedDeclarations, missingFromSnapshot,
    unresolvedGateNames: [...new Set(rows.flatMap((r) => r.unresolvedGates ?? []))], actionsNotInSchema: unknownActions,
    capabilityActionsNotInSchema: capabilityActions.filter((a) => !schemaActions.includes(a)), schemaActionsNotInCapabilityActions: schemaActions.filter((a) => !capabilityActions.includes(a)),
    writePolicy: count(rows.filter((r) => r.writePolicy), (r) => r.writePolicy),
  };
  return {
    sources: { ...PATHS, capturedAt: writes.capturedAt, serverHandlerSha: writes.serverHandlerSha },
    summary, roles, tenants: manifest.tenants.map((t) => ({ id: t.id, apiPrefix: t.apiPrefix, roles: t.roles, presenceLobby: t.presenceLobby, huddleChat: t.huddleChat })),
    voiceTenants: catalogue.voiceTenants, v1Tools: catalogue.tools, navigatePages: catalogue.navigatePages, v2Tools: V2_TOOLS,
    v2Rules: V2_RULES.map(([re, decision, tool, note]) => ({ pattern: re.source, decision, tool, note })), rows: all,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const inventory = build();
/** Header pretty-printed, one row per line: small diffs when a route changes. */
function serialize(inv) {
  const { rows, ...head } = inv;
  const headJson = JSON.stringify(head, null, 1);
  return `${headJson.slice(0, -2)},\n "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
}
const json = serialize(inventory);
const s = inventory.summary;
const headline = `${s.routes} routes (${s.routesInSnapshot} snapshot rows, ${s.snapshotDuplicates} duplicates, ${s.routesDeclaredNotInSnapshot} declared only) + ${s.pages} pages; `
  + `${s.peopleRoutes} reachable by a person (${s.peopleReads} reads, ${s.peopleWrites} writes); covered today: ${s.coveredRoutes} routes, ${s.coveredPages}/${s.pages} pages; `
  + `catalogue tools ${s.v1Tools} (v2 ${s.v2Tools}); by mapsTo ${(s.v2Decisions.read ?? 0) + (s.v2Decisions.confirm ?? 0) + (s.v2Decisions.open ?? 0)}, not yet ${s.v2Decisions['not-yet'] ?? 0}, never ${s.v2Decisions.never ?? 0}; undecided writes/reads: ${s.undecided.length}`;

if (args.has('--print')) {
  console.log(headline);
  console.log(JSON.stringify({ byKind: s.byKind, byFamily: s.byFamily, v2Decisions: s.v2Decisions, v2ToolRoutes: s.v2ToolRoutes, undecided: s.undecided,
    staleSnapshotLines: s.staleSnapshotLines, unresolvedDeclarations: s.unresolvedDeclarations, missingFromSnapshot: s.missingFromSnapshot,
    unresolvedGateNames: s.unresolvedGateNames, actionsNotInSchema: s.actionsNotInSchema }, null, 2));
}
if (args.has('--check')) {
  let ok = true;
  if (s.undecided.length) { ok = false; console.error(`inventory: ${s.undecided.length} route(s) a person can reach have no catalogue decision:\n  ${s.undecided.join('\n  ')}`); }
  if (s.contradictions.length) { ok = false; console.error(`inventory: ${s.contradictions.length} route(s) a tool reaches are on the never list:\n  ${s.contradictions.join('\n  ')}`); }
  // The rule table holds the never list and the backlog: read, confirm and open come only from the catalogue's mapsTo.
  if (V2_RULES.some(([, d]) => !['never', 'n/a', 'not-yet'].includes(d))) { ok = false; console.error('inventory: V2_RULES may hold only never, n/a and not-yet decisions'); }
  let onDisk = null;
  try { onDisk = read(PATHS.out); } catch { /* missing */ }
  if (onDisk !== json) { ok = false; console.error(`inventory: ${PATHS.out} is stale; run node scripts/voice/inventory.mjs`); }
  if (s.unresolvedDeclarations.length) console.error(`inventory: ${s.unresolvedDeclarations.length} snapshot route(s) have no declaration in the tree (the snapshot may be ahead of or behind the sources)`);
  console.log(`${ok ? 'OK' : 'FAIL'}: ${headline}`);
  process.exit(ok ? 0 : 1);
} else if (!args.has('--print')) {
  writeFileSync(join(ROOT, PATHS.out), json);
  console.log(`wrote ${PATHS.out}: ${headline}`);
}
