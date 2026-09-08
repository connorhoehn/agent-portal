// Enumerate the HTTP surface from the routers themselves.
//
// WHY STATIC. The obvious way to list routes is to boot the app and walk
// `app.router.stack`. `src/index.ts` calls `app.listen()` and starts six
// pollers at import time, so importing it from a test starts a server and a
// scheduler; and the capture script has to run against a *separate*, already
// running `dev:mock`. So this reads the source instead, with the TypeScript
// parser rather than a regex, and needs neither a socket nor a running app.
//
// WHY IT MATTERS. The point of enumerating rather than hand-listing is that a
// route added tomorrow is covered tomorrow: `routes.test.ts` compares this
// live enumeration against the committed `snapshots/routes.json` and fails
// naming the route nobody captured yet.
//
// WHAT IT UNDERSTANDS. The shapes `src/index.ts` and `src/routes/*.ts`
// actually use, all of them literal:
//
//   app.use('/api/bots', requireTenant('orgiq'), botsRouter)
//   app.use(mockControlRouter)                       // mounted at the root
//   app.get('/health', healthHandler)                // handler, not a router
//   assessmentRouter.get('/teams/:id', viewGate, h)
//   observabilityRouter.use('/drift', driftRouter)   // nested routers
//
// Anything it cannot resolve to a literal path is reported in `unresolved`
// rather than dropped, so a dynamic mount is visible instead of silently
// shrinking the surface.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import ts from 'typescript';

import { middlewareRoot } from './paths.js';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
export type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>;

export interface RouteRecord {
  method: HttpMethod;
  /** Full path as Express matches it, params still spelled `:name`. */
  path: string;
  /** `src/routes/bots.ts:41` — where the handler is declared. */
  source: string;
}

export interface UnresolvedMount {
  reason: string;
  source: string;
}

export interface RouteTable {
  routes: RouteRecord[];
  unresolved: UnresolvedMount[];
}

/** Params in a path, e.g. `/teams/:id/stories/:file` -> ['id','file']. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

function joinPath(prefix: string, sub: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = sub.startsWith('/') ? sub : `/${sub}`;
  const joined = `${a}${b}`.replace(/\/{2,}/g, '/');
  return joined === '' ? '/' : joined.replace(/(.)\/$/, '$1');
}

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

interface LoadedFile {
  /** Path relative to `middleware/`, e.g. `src/routes/bots.ts`. */
  rel: string;
  sourceFile: ts.SourceFile;
}

function loadFile(root: string, rel: string): LoadedFile {
  const abs = join(root, rel);
  const text = readFileSync(abs, 'utf8');
  return { rel, sourceFile: ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true) };
}

function lineOf(file: LoadedFile, node: ts.Node): string {
  const { line } = file.sourceFile.getLineAndCharacterOfPosition(node.getStart(file.sourceFile));
  return `${file.rel}:${line + 1}`;
}

/** `import { botsRouter } from './routes/bots.js'` -> botsRouter -> src/routes/bots.ts */
function importedFrom(file: LoadedFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of file.sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue;
    const relFromRoot = join(dirname(file.rel), spec.text.replace(/\.js$/, '.ts'));
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) out.set(el.name.text, relFromRoot);
  }
  return out;
}

function literalPath(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** The last argument of `app.use(prefix, ...middleware, router)`. */
function lastIdentifier(args: readonly ts.Expression[]): ts.Identifier | null {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const a = args[i]!;
    if (ts.isIdentifier(a)) return a;
  }
  return null;
}

/**
 * Walk one module, collecting every `<target>.<method>(...)` call. `target`
 * is the express app in index.ts and the router const in a routes module.
 */
function collect(
  file: LoadedFile,
  targets: Set<string>,
  prefix: string,
  root: string,
  seen: Set<string>,
  out: RouteTable,
): void {
  const imports = importedFrom(file);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const recv = node.expression.expression;
      const member = node.expression.name.text;
      if (ts.isIdentifier(recv) && targets.has(recv.text)) {
        const args = node.arguments;
        const first = literalPath(args[0]);

        if ((HTTP_METHODS as readonly string[]).includes(member)) {
          if (first === null) {
            out.unresolved.push({
              reason: `${recv.text}.${member}() with a non-literal path`,
              source: lineOf(file, node),
            });
          } else {
            out.routes.push({
              method: member.toUpperCase() as HttpMethod,
              path: joinPath(prefix, first),
              source: lineOf(file, node),
            });
          }
        } else if (member === 'use') {
          const mounted = lastIdentifier(args);
          const subPrefix = first === null ? prefix : joinPath(prefix, first);
          if (mounted && imports.has(mounted.text)) {
            const rel = imports.get(mounted.text)!;
            const key = `${rel}|${subPrefix}`;
            if (!seen.has(key)) {
              seen.add(key);
              const sub = loadFile(root, rel);
              collect(sub, routerNames(sub), subPrefix, root, seen, out);
            }
          }
          // A `use` with an inline function is a middleware, not a mount —
          // deliberately silent. A `use` naming a local identifier that is not
          // an import is also middleware (assessment.ts's tenant gate).
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file.sourceFile, visit);
}

/**
 * Router consts declared in a routes module: `export const botsRouter: Router =
 * Router()`. Returns every name so a module hosting two routers still works.
 */
function routerNames(file: LoadedFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const isRouterCall =
        ts.isCallExpression(init) &&
        ((ts.isIdentifier(init.expression) && init.expression.text === 'Router') ||
          (ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'Router'));
      if (isRouterCall) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file.sourceFile, visit);
  return names;
}

/**
 * The whole HTTP surface, read from `src/index.ts` and everything it mounts.
 * Sorted so the snapshot diff is stable.
 */
export function enumerateRoutes(entry = 'src/index.ts'): RouteTable {
  const root = middlewareRoot();
  const out: RouteTable = { routes: [], unresolved: [] };
  const index = loadFile(root, entry);
  // The express app in index.ts is `const app = express()`.
  const appNames = new Set<string>();
  ts.forEachChild(index.sourceFile, function walk(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'express'
    ) {
      appNames.add(node.name.text);
    }
    ts.forEachChild(node, walk);
  });
  collect(index, appNames, '', root, new Set(), out);

  out.routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  out.unresolved.sort((a, b) => a.source.localeCompare(b.source));
  return out;
}

/** `GET /api/bots` — the key a snapshot is filed under. */
export function routeKey(r: Pick<RouteRecord, 'method' | 'path'>): string {
  return `${r.method} ${r.path}`;
}
