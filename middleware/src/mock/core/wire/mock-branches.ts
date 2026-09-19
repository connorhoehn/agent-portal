// Static analysis for the two blind spots the wire capture cannot cover.
//
// WHY THIS EXISTS. `scripts/validate-mock-floor.sh` had two rules that only
// looked where the bug had already been found:
//
//   * Rule 3 ("every timestamp comes from the clock") scanned `src/mock/**`.
//     So `markCloned` in providers/agent-projects.ts could mint
//     `new Date().toISOString()` *inside its own `config.mock` branch* and no
//     check saw it — a fixture timestamp living outside the fixture directory.
//   * Rule 4 ("every route has a mock branch") read the wire capture, which is
//     GET-only. So four raw `exec()` calls on the agent-projects write paths
//     500'd every POST and DELETE in `dev:mock` — a repository could not be
//     linked, unlinked, or run against offline — while the judge stayed green.
//
// WHY STATIC. You cannot safely POST or DELETE against a running server during
// a validation run: the writes are real, they mutate the world the next check
// reads, and a `DELETE /api/agent-projects/:id` that works is indistinguishable
// from one that does not until the fleet is one repo short. So this reads the
// source, with the TypeScript parser, and follows the call graph instead.
//
// WHAT IT IS AND IS NOT. This is a REACHABILITY argument, not an execution
// trace: "some path from this handler reaches a function that calls the RDS
// Data API, an AWS SDK client, or an outbound `fetch`, with no `config.mock`
// branch". It can be wrong in both directions and `docs/mock-floor.md § What
// the judge cannot see` says how. It is a ratchet, not a gate.
//
// `fetch` was the third thing it could not see, added 2026-09. Counting only
// `.send()` and `exec()` meant "reaches a backend" was really "reaches AWS":
// `lib/github-connector.ts` talks to api.github.com over plain HTTP and no
// check in the repo could name it. Widening the scan raised the budget by one
// pair, which is the scan seeing more — not the code getting worse.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import ts from 'typescript';

import { middlewareRoot } from './paths.js';
import { enumerateRoutes, type RouteRecord } from './routes.js';

/** `src/providers/agent-projects.ts:284 — markCloned mints new Date()`. */
export interface Finding {
  /** Path relative to `middleware/`, with a line number. */
  where: string;
  what: string;
}

const SCANNED_DIRS = ['src/routes', 'src/lib', 'src/providers'];

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return; }
  for (const name of entries) {
    const childRel = `${rel}/${name}`;
    if (statSync(join(root, childRel)).isDirectory()) {
      if (name === '__tests__') continue;
      walk(root, childRel, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(childRel);
  }
}

// ---------------------------------------------------------------------------
// Module model
// ---------------------------------------------------------------------------

interface FnDecl {
  name: string;
  node: ts.Node;
  /** Identifiers called anywhere inside the body, e.g. `exec`, `mockStartRun`. */
  calls: Set<string>;
  /** Source text of the body — cheap enough, and the guard tests read it. */
  text: string;
  line: number;
  /** Does the body call `fetch()` at a URL that is not this app's own origin? */
  outboundFetch: boolean;
}

interface Module {
  rel: string;
  sourceFile: ts.SourceFile;
  /** Local binding name -> module rel path, for relative imports only. */
  imports: Map<string, string>;
  fns: Map<string, FnDecl>;
}

function resolveImport(fromRel: string, spec: string, root: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromRel), spec.replace(/\.js$/, '.ts'));
  const candidates = [base, base.replace(/\.ts$/, '/index.ts')];
  for (const c of candidates) {
    try { if (statSync(join(root, c)).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

function collectCalls(node: ts.Node, sf: ts.SourceFile): Set<string> {
  const calls = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) calls.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) {
        calls.add(callee.name.text);
        if (ts.isIdentifier(callee.expression)) calls.add(callee.expression.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  void sf;
  return calls;
}

/**
 * A `fetch()` whose URL points at this process's own origin.
 *
 * The scan asks "does this reach a backend that `dev:mock` cannot stand in
 * for". A call to our own server is not that: it is either the SSE/proxy shape
 * (`fetch('/api/...')`) or a loopback probe, and both are answered by the same
 * mock middleware the caller is running inside. Only two shapes count as
 * self-origin, and both are lexical because that is all a name-resolving scan
 * can honestly claim:
 *
 *   * a loopback host anywhere in the URL expression — `localhost`, `127.0.0.1`,
 *     `[::1]`;
 *   * a string/template literal that STARTS with `/`, i.e. an origin-relative
 *     path with no host of its own.
 *
 * Deliberately NOT self-origin: a template whose first thing is an
 * interpolation (`` `${origin}/robots.txt` `` in lib/site-survey.ts). That
 * origin is the site being surveyed, not ours.
 */
export function isSameOriginFetch(argText: string): boolean {
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(argText)) return true;
  return /^['"`]\//.test(argText);
}

/** Does this node contain a `fetch()` to somewhere that is not our own origin? */
export function hasOutboundFetch(node: ts.Node, sf: ts.SourceFile): boolean {
  // The hardened transport still leaves this process. Track its imported
  // identifier (including aliases), so replacing fetch cannot hide an offline gap.
  const fetchNames = new Set(['fetch']);
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/\/public-web-fetch(?:\.[jt]s)?$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text === 'publicWebFetch') fetchNames.add(item.name.text);
      }
    }
  }
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fetchNames.has(n.expression.text)) {
      const arg = n.arguments[0];
      if (!arg || !isSameOriginFetch(arg.getText(sf))) { found = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function loadModule(root: string, rel: string): Module {
  const abs = join(root, rel);
  const sourceFile = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, true);
  const imports = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const target = resolveImport(rel, spec.text, root);
    if (!target) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) imports.set(el.name.text, target);
    }
  }

  const fns = new Map<string, FnDecl>();
  const add = (name: string, node: ts.Node): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    fns.set(name, {
      name, node, calls: collectCalls(node, sourceFile), text: node.getText(sourceFile), line,
      outboundFetch: hasOutboundFetch(node, sourceFile),
    });
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) add(d.name.text, d);
      }
    }
  }
  return { rel, sourceFile, imports, fns };
}

function loadAll(root: string): Map<string, Module> {
  const rels: string[] = [];
  for (const d of SCANNED_DIRS) walk(root, d, rels);
  const modules = new Map<string, Module>();
  for (const rel of rels) modules.set(rel, loadModule(root, rel));
  return modules;
}

// ---------------------------------------------------------------------------
// Rule 3, widened — a wall-clock mint inside a `config.mock` branch
// ---------------------------------------------------------------------------

/** `new Date()` with no arguments, or `Date.now()` — a MINT, never a parse. */
function isWallClockMint(n: ts.Node): boolean {
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Date') {
    return !n.arguments || n.arguments.length === 0;
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const { expression, name } = n.expression;
    return ts.isIdentifier(expression) && expression.text === 'Date' && name.text === 'now';
  }
  return false;
}

/**
 * Wall-clock mints inside a mock branch, anywhere under `src/providers/**`.
 *
 * The branch is `if (<something mentioning config.mock>) { ... }` — the THEN
 * side, and the ELSE side when the condition is negated, which is the shape
 * `if (!config.mock.aurora) { ...real... } else { ...mock... }` uses. A mint in
 * the real path is left alone: that code talks to Aurora, where `NOW()` does
 * the minting, and a `Date.now()` there is usually a cache stamp or an elapsed
 * measurement, neither of which is a fixture timestamp.
 */
export function scanProviderMockMints(root = middlewareRoot()): Finding[] {
  const rels: string[] = [];
  walk(root, 'src/providers', rels);
  const findings: Finding[] = [];

  for (const rel of rels) {
    const abs = join(root, rel);
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, true);

    const report = (branch: ts.Node, label: string): void => {
      const visit = (n: ts.Node): void => {
        if (isWallClockMint(n)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          findings.push({
            where: `${rel}:${line}`,
            what: `${n.getText(sf)} inside a ${label} branch — use mock/core/clock.ts`,
          });
        }
        ts.forEachChild(n, visit);
      };
      visit(branch);
    };

    const visit = (n: ts.Node): void => {
      if (ts.isIfStatement(n)) {
        const cond = n.expression.getText(sf);
        if (cond.includes('config.mock')) {
          const negated = /^\s*!/.test(cond);
          if (!negated) report(n.thenStatement, 'config.mock');
          else if (n.elseStatement) report(n.elseStatement, '!config.mock else');
        }
      } else if (ts.isConditionalExpression(n) && n.condition.getText(sf).includes('config.mock')) {
        const negated = /^\s*!/.test(n.condition.getText(sf));
        report(negated ? n.whenFalse : n.whenTrue, 'config.mock ?:');
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return findings.sort((a, b) => a.where.localeCompare(b.where));
}

// ---------------------------------------------------------------------------
// Rule 4, widened — write routes reaching an unmocked provider
// ---------------------------------------------------------------------------

/**
 * The transport, not a surface. `providers/aurora.ts` IS the RDS Data API
 * client — `exec` is defined there and by definition has no mock branch, so
 * including it turns every write route in the middleware into a finding that
 * says nothing. The question this rule asks is about the provider function a
 * route reaches, not about the wire underneath it.
 */
const TRANSPORT_MODULES = new Set(['src/providers/aurora.ts']);

/**
 * Transport wrappers by name. Several providers declare a private `exec` /
 * `safeExec` of their own (identity.ts, projects.ts, sprints.ts) for the same
 * reason aurora.ts exists. Reporting the wrapper says "the wire is the wire";
 * the finding worth having names the provider function ABOVE it.
 */
const TRANSPORT_FNS = new Set(['exec', 'execWrite', 'safeExec', 'execOne']);

/**
 * The layers a finding may name.
 *
 * `src/providers/**` was the whole scan until 2026-09. It under-reported by
 * exactly the amount `docs/mock-floor.md` warned it would: a handler that
 * reaches AWS through `src/lib/**` was invisible, and that is where the entire
 * governed-run and change-delivery surface lived — `POST /api/agent-projects/:id/runs`
 * and `POST /api/sdlc/changes/:id/deliver` both 503'd offline at
 * `lib/devbox-arn.ts`, which lists real AgentCore runtimes and is not a
 * provider, so neither route was ever on the list. Widening the layer is why
 * the budget rose: the scan sees more, the code did not get worse.
 */
const REPORTED_LAYERS = ['src/providers/', 'src/lib/'];

const inReportedLayer = (modRel: string): boolean => REPORTED_LAYERS.some((l) => modRel.startsWith(l));

/**
 * `src/lib` transport wrappers, by the same argument as TRANSPORT_FNS.
 *
 * `runDevboxShell` IS the devbox wire — every governance probe goes through
 * it, so reporting it says "the wire is the wire" once per caller and buries
 * the function above it that actually decides whether there is an offline
 * path. Reported through its callers instead.
 */
const TRANSPORT_LIB_FNS = new Set(['runDevboxShell']);

/**
 * HTTP transport wrappers, module-qualified.
 *
 * The same argument as TRANSPORT_FNS, applied to `fetch`: `gh()` in
 * lib/github-connector.ts IS the GitHub wire — it takes a path and a token and
 * does nothing a mock could branch on. Reporting it would print "the wire is
 * the wire" once per caller and bury the function above it that actually
 * decides whether there is an offline path (`listGithubOrgs` has one,
 * `openPullRequest` has not).
 *
 * So the wrapper is not reported, and — exactly as `callsLiveAws` treats a call
 * to `exec` — a call TO the wrapper counts as reaching the network for whoever
 * makes it. Qualified by module rather than by bare name because `gh` is a
 * two-letter name that some other file could plausibly reuse for something
 * local; `exec` earned its unqualified entry by being spelled the same way in
 * five providers on purpose.
 */
const OUTBOUND_TRANSPORT_FNS = new Map<string, Set<string>>([
  ['src/lib/github-connector.ts', new Set(['gh'])],
]);

/**
 * Does this function body reach a backend `dev:mock` cannot answer — the RDS
 * Data API, an AWS SDK client, or an outbound `fetch`?
 *
 * `fetch` was added 2026-09. Until then the scan counted only `.send(...)` and
 * `exec(...)`, so anything reached over plain HTTP was structurally invisible:
 * `lib/github-connector.ts` talks to api.github.com and nothing in the judge
 * could see it, which `docs/mock-floor.md § What the judge cannot see` said out
 * loud. That is why the budget rose again — the scan sees more, the code did
 * not get worse.
 */
function callsLiveAws(fn: FnDecl, modRel: string): boolean {
  if (fn.calls.has('exec') || fn.calls.has('execWrite') || fn.calls.has('send')) return true;
  if (fn.outboundFetch) return true;
  const wrappers = OUTBOUND_TRANSPORT_FNS.get(modRel);
  if (wrappers) { for (const w of wrappers) if (fn.calls.has(w)) return true; }
  return false;
}

/**
 * The two spellings of "this code has an offline path".
 *
 * `config.mock` is the floor's own switch. `auroraConfigured` is the older one
 * providers/identity.ts uses: users, tenants and grants fall back to
 * `FALLBACK_USERS` (mirroring `schema/identity_schema.sql`) whenever the
 * cluster arn/secret are unset, which is exactly the `dev:mock` case. Two
 * mechanisms is drift waiting to happen, but a route behind either one does
 * work offline, and a rule that called identity.ts a gap would be wrong.
 */
/**
 * The spellings of "this code has an offline path".
 *
 * `config.mock` is the floor's own switch. The other three are older ones that
 * predate it, and a rule that called them gaps would be wrong — each is a
 * documented, deliberate fallback that `dev:mock` actually takes:
 *
 *   * `auroraConfigured` — providers/identity.ts falls back to `FALLBACK_USERS`
 *     (mirroring `schema/identity_schema.sql`) whenever the cluster arn/secret
 *     are unset, which is exactly the `dev:mock` case.
 *   * `policyStoreId` — lib/authz.ts `evaluate()` answers from the Cedar seed
 *     matrix (`seedPolicyDecision`) rather than Verified Permissions when no
 *     policy store is configured. `dev:mock` blanks `POLICY_STORE_ID` on
 *     purpose; open-mode authz IS the offline branch, and without this token
 *     every gated write route in the middleware — sixty-odd of them — was
 *     reported as reaching live AWS through its own auth check.
 *   * `sessionSigningSecretArn` — lib/session.ts signs with a deterministic dev
 *     key rather than reading Secrets Manager when no secret ARN is set.
 *
 * Four mechanisms is drift waiting to happen and the widened lib scan is what
 * made that visible. Consolidating them is a separate slice; recording them
 * honestly is this one.
 */
const GUARD_TOKENS = ['config.mock', 'auroraConfigured', 'policyStoreId', 'sessionSigningSecretArn'];

const mentionsGuard = (text: string): boolean => GUARD_TOKENS.some((t) => text.includes(t));

/**
 * Is this function guarded by a mock branch?
 *
 * Directly, when its own body mentions a guard token; or one level indirectly,
 * when it calls a helper declared in the same module that does — the shape
 * providers/knowledge-base.ts uses (`const mockAws = () => config.mock.agentcore`).
 */
function isGuarded(fn: FnDecl, mod: Module): boolean {
  if (mentionsGuard(fn.text)) return true;
  for (const called of fn.calls) {
    const local = mod.fns.get(called);
    if (local && local !== fn && mentionsGuard(local.text)) return true;
  }
  return false;
}

/** The route-registration call expression that starts at `file:line`. */
function registrationAt(mod: Module, line: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const at = mod.sourceFile.getLineAndCharacterOfPosition(n.getStart(mod.sourceFile)).line + 1;
      if (at === line && ts.isPropertyAccessExpression(n.expression)) { found = n; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(mod.sourceFile);
  return found;
}

export interface WriteRouteFinding extends Finding {
  route: string;
  /** `src/providers/agent-projects.ts:linkAgentProject` — the unmocked leaf. */
  provider: string;
}

/**
 * Write routes (POST/PUT/PATCH/DELETE) whose handler chain reaches a provider
 * function that talks to live AWS with no `config.mock` branch.
 *
 * Depth-first from the identifiers inside the route registration, through
 * `src/routes`, `src/lib` and `src/providers`, resolving each name against the
 * module's own declarations and its relative imports. A provider function is a
 * finding when it calls `exec`/`.send` and nothing in it (or in a local helper
 * it calls) mentions `config.mock`.
 */
export function scanWriteRoutesWithoutMockBranch(root = middlewareRoot()): WriteRouteFinding[] {
  const modules = loadAll(root);
  const table = enumerateRoutes();
  const findings: WriteRouteFinding[] = [];
  const seenPairs = new Set<string>();

  const reachUnmocked = (modRel: string, name: string, seen: Set<string>): string[] => {
    const key = `${modRel}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const mod = modules.get(modRel);
    if (!mod) return [];
    const fn = mod.fns.get(name);
    if (!fn) return [];

    const hits: string[] = [];
    const guarded = isGuarded(fn, mod);
    const isTransport = TRANSPORT_MODULES.has(modRel)
      || TRANSPORT_FNS.has(name) || TRANSPORT_LIB_FNS.has(name)
      || (OUTBOUND_TRANSPORT_FNS.get(modRel)?.has(name) ?? false);
    if (!guarded && !isTransport && inReportedLayer(modRel) && callsLiveAws(fn, modRel)) {
      hits.push(`${modRel}:${fn.line} ${name}()`);
    }
    // A guarded function is where mock mode is decided, so the search stops
    // there. Descending past it would report everything on its Aurora side as
    // unreachable-offline when the branch above never lets `dev:mock` get
    // there — which is what turned the first sweep into 179 findings, nearly
    // all of them a route "reaching" a provider it cannot reach offline.
    if (guarded) return hits;
    for (const called of fn.calls) {
      const target = mod.imports.get(called) ?? (mod.fns.has(called) ? modRel : null);
      if (target) hits.push(...reachUnmocked(target, called, seen));
    }
    return hits;
  };

  for (const r of table.routes as RouteRecord[]) {
    if (r.method === 'GET' || r.method === 'HEAD' || r.method === 'OPTIONS') continue;
    const [fileRel, lineStr] = r.source.split(':');
    if (!fileRel || !lineStr) continue;
    const mod = modules.get(fileRel);
    if (!mod) continue;
    const reg = registrationAt(mod, Number(lineStr));
    if (!reg) continue;

    const seen = new Set<string>();
    const hits: string[] = [];
    for (const called of collectCalls(reg, mod.sourceFile)) {
      const target = mod.imports.get(called) ?? (mod.fns.has(called) ? fileRel : null);
      if (target) hits.push(...reachUnmocked(target, called, seen));
    }
    for (const hit of [...new Set(hits)].sort()) {
      const pair = `${r.method} ${r.path} -> ${hit}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      findings.push({
        route: `${r.method} ${r.path}`,
        provider: hit,
        where: r.source,
        what: `${r.method} ${r.path} reaches ${hit} — live AWS, no config.mock branch`,
      });
    }
  }
  return findings.sort((a, b) => a.what.localeCompare(b.what));
}

/** CLI: `npx tsx src/mock/core/wire/mock-branches.ts [mints|writes]`. */
function main(): void {
  const which = process.argv[2] ?? 'both';
  if (which === 'mints' || which === 'both') {
    for (const f of scanProviderMockMints()) console.log(`MINT ${f.where} ${f.what}`);
  }
  if (which === 'writes' || which === 'both') {
    for (const f of scanWriteRoutesWithoutMockBranch()) console.log(`WRITE ${f.what}`);
  }
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('mock-branches.ts') || invoked.endsWith('mock-branches.js')) {
  main();
}

void relative;
