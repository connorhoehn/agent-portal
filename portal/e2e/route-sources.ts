// The portal's route sources, read once (audit 2026-10-07 T4): App.tsx's
// <Route> tree with the RequireRole gates in scope, the palette catalogue
// (components/shell/portalCommands.ts PAGES) and the rail rows
// (components/shell/Layout.tsx). Everything that needs "the routes" reads
// them through here — the route inventory (e2e/route-inventory.ts, which the
// sweeps, the journey freshness rule and the rail measurement read) and the
// nav-parity judge (scripts/lib/nav-route-parity.cjs). No other file parses
// these three sources.
//
// Plain TypeScript with erasable syntax only, so `node` runs it directly
// (type stripping) and Playwright imports it unchanged. `root` defaults to
// this repo; the nav-parity judge's calibration passes a temp tree holding
// historical copies of the three files.
//
//   node portal/e2e/route-sources.ts [--root <dir>]   # JSON { routes, pages, rail, registryPaths }
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** typescript from the portal's install, else the middleware's (a calibration tree links only that). */
function loadTs(root: string): typeof import('typescript') {
  for (const pkg of [path.join(root, 'portal', 'package.json'), path.join(root, 'middleware', 'package.json'), path.join(REPO_ROOT, 'portal', 'package.json')]) {
    try { return createRequire(pkg)('typescript'); } catch { /* next */ }
  }
  throw new Error('route-sources: typescript is not installed under portal/ or middleware/');
}

export interface AppRoute {
  /** Full path, `:param` and `*` segments kept. */
  path: string;
  /** Roles of the RequireRole gates in scope (intersected), or null for any role. */
  roles: string[] | null;
  isRedirect: boolean;
  /** The element only forwards elsewhere (<Navigate>, or a *Redirect component). */
  forwards: boolean;
}
export interface PaletteEntry { line: number; path: string; label?: string; tenant?: string; roles?: string[] | null; [key: string]: unknown }
export interface RailEntry { path: string; roles: string[] | null; hasRoles: boolean }
export interface RouteSources {
  /** Every <Route> in App.tsx, concrete and parameterised. */
  routes: AppRoute[];
  pages: PaletteEntry[];
  rail: RailEntry[];
  /** Every concrete `path: '…'` literal in the palette and rail files (the sweep inventory's registry). */
  registryPaths: string[];
}

export function readRouteSources(root = REPO_ROOT): RouteSources {
  const ts = loadTs(root);
  const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tagName = (node: any): string => { const t = node.tagName || (node.openingElement && node.openingElement.tagName); return t ? t.getText() : ''; };
  const attrs = (node: any): Record<string, any> => {
    const open = node.openingElement || node;
    const out: Record<string, any> = {};
    for (const a of (open.attributes ? open.attributes.properties : [])) { if (a.name) out[a.name.getText()] = a.initializer; }
    return out;
  };
  const stringOf = (init: any): string | null => {
    if (!init) return null;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) return init.expression.text;
    return null;
  };
  const stringArrayOf = (init: any): string[] | null => {
    if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
    const e = init.expression;
    if (!ts.isArrayLiteralExpression(e)) return null;
    const out: string[] = [];
    for (const el of e.elements) { if (ts.isStringLiteral(el)) out.push(el.text); else return null; }
    return out;
  };
  const appSf = parse(path.join(root, 'portal', 'src', 'App.tsx'));
  const roleGates = new Set(['RequireRole']);
  // App's Gate adds the no-access fallback around RequireRole. Recognize
  // wrappers from their forwarding body, not a trusted component name: a
  // changed roles expression, prop spread or bypass must not look equivalent.
  for (const declaration of appSf.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.name || declaration.parameters.length !== 1) continue;
    const binding = declaration.parameters[0]!.name;
    if (!ts.isObjectBindingPattern(binding) || declaration.body?.statements.length !== 1) continue;
    const bound = (property: string): string | null => {
      const item = binding.elements.find((el: any) => !el.dotDotDotToken && (el.propertyName?.text ?? el.name.text) === property);
      return item && ts.isIdentifier(item.name) ? item.name.text : null;
    };
    const roles = bound('roles'), children = bound('children');
    const statement = declaration.body.statements[0]!;
    if (!roles || !children || !ts.isReturnStatement(statement)) continue;
    let expression = statement.expression;
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!expression || !ts.isJsxElement(expression) || tagName(expression) !== 'RequireRole') continue;
    if (expression.openingElement.attributes.properties.some((a: any) => ts.isJsxSpreadAttribute(a))) continue;
    const gateRoles = attrs(expression)['roles'];
    const content = expression.children.filter((child: any) => !(ts.isJsxText(child) && !child.text.trim()) && !(ts.isJsxExpression(child) && !child.expression));
    if (gateRoles && ts.isJsxExpression(gateRoles) && gateRoles.expression && ts.isIdentifier(gateRoles.expression)
      && gateRoles.expression.text === roles && content.length === 1 && ts.isJsxExpression(content[0]!)
      && content[0]!.expression && ts.isIdentifier(content[0]!.expression) && content[0]!.expression.text === children) {
      roleGates.add(declaration.name.text);
    }
  }
  // The outermost role gate inside a JSX expression: App.tsx writes the
  // gate INSIDE `element={<Gate …><Page/></Gate>}`, almost never
  // as an ancestor of the <Route>.
  const outermostRoleGate = (init: any): string[] | null => {
    if (!ts.isJsxExpression(init) || !init.expression) return null;
    let found: string[] | null = null;
    (function walk(n: any) {
      if (found) return;
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && roleGates.has(tagName(n))) { found = stringArrayOf(attrs(n)['roles']); return; }
      n.forEachChild(walk);
    })(init.expression);
    return found;
  };
  const joinPath = (prefix: string, seg: string | null | undefined): string => {
    if (seg === undefined || seg === null) return prefix;
    if (seg.startsWith('/')) return seg.replace(/\/+$/, '') || '/';
    const base = prefix === '/' ? '' : prefix;
    return (base + '/' + seg).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  };

  const routes = new Map<string, AppRoute>();
  (function visit(node: any, prefix: string, roles: string[] | null) {
    let nextPrefix = prefix;
    let nextRoles = roles;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const a = attrs(node);
      if (roleGates.has(name)) {
        const r = stringArrayOf(a['roles']);
        if (r) nextRoles = roles === null ? r.slice() : roles.filter((x) => r.includes(x));
      }
      if (name === 'Route') {
        const p = stringOf(a['path']);
        const hasIndex = Object.prototype.hasOwnProperty.call(a, 'index');
        nextPrefix = hasIndex ? prefix : joinPath(prefix, p);
        const elInit = a['element'];
        let isRedirect = false; let forwards = false;
        if (elInit && ts.isJsxExpression(elInit) && elInit.expression) {
          const text = elInit.expression.getText();
          isRedirect = /(^|\W)Navigate(\W|$)/.test(text);
          forwards = isRedirect || /<[A-Za-z]*Redirect\b/.test(text);
        }
        const elRoles = elInit ? outermostRoleGate(elInit) : null;
        if (elRoles) nextRoles = nextRoles === null ? elRoles.slice() : nextRoles.filter((x) => elRoles.includes(x));
        // Every <Route> is recorded, a pathless layout route under its prefix
        // too (the nav-parity judge has always resolved against that shape).
        {
          const prev = routes.get(nextPrefix);
          // Keep the most permissive gate if a path appears twice.
          if (!prev || (prev.isRedirect && !isRedirect)) routes.set(nextPrefix, { path: nextPrefix, roles: nextRoles, isRedirect, forwards });
        }
      }
    }
    node.forEachChild((c: any) => visit(c, nextPrefix, nextRoles));
  })(appSf, '/', null);

  const shell = path.join(root, 'portal', 'src', 'components', 'shell');
  const layoutSf = parse(path.join(shell, 'Layout.tsx'));
  const cmdSf = parse(path.join(shell, 'portalCommands.ts'));

  // RAIL rows: an object literal with both a path and a label.
  const rail: RailEntry[] = [];
  const railSeen = new Set<string>();
  (function walk(node: any) {
    if (ts.isObjectLiteralExpression(node)) {
      let p: string | null = null; let roles: string[] | null = null; let hasRoles = false;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name.getText();
        if (key === 'path' && ts.isStringLiteral(prop.initializer)) p = prop.initializer.text;
        if (key === 'requireRoles') {
          hasRoles = true;
          const v = prop.initializer;
          roles = (ts.isArrayLiteralExpression(v) && v.elements.every(ts.isStringLiteral)) ? v.elements.map((e: any) => e.text) : null;
        }
      }
      const hasLabel = node.properties.some((pr: any) => ts.isPropertyAssignment(pr) && pr.name.getText() === 'label');
      if (p && hasLabel) {
        const key = p.replace(/\/+$/, '') || '/';
        // Last write wins, as a Map keyed by path did.
        if (railSeen.has(key)) rail.splice(rail.findIndex((r) => r.path === key), 1);
        railSeen.add(key);
        rail.push({ path: key, roles: hasRoles ? roles : null, hasRoles });
      }
    }
    node.forEachChild(walk);
  })(layoutSf);

  // PAGES, resolving the role consts it uses.
  const consts = new Map<string, string[]>();
  const pages: PaletteEntry[] = [];
  cmdSf.forEachChild(function top(node: any) {
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations) {
      if (!d.initializer || !d.name) continue;
      const nm = d.name.getText();
      if (ts.isArrayLiteralExpression(d.initializer)) {
        const vals = d.initializer.elements.every(ts.isStringLiteral) ? d.initializer.elements.map((e: any) => e.text) : null;
        if (vals && nm !== 'PAGES') consts.set(nm, vals);
      }
      if (nm === 'PAGES' && ts.isArrayLiteralExpression(d.initializer)) {
        for (const el of d.initializer.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          const entry: PaletteEntry = { line: cmdSf.getLineAndCharacterOfPosition(el.getStart()).line + 1, path: '' };
          for (const prop of el.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const key = prop.name.getText();
            const v = prop.initializer;
            if (ts.isStringLiteral(v)) entry[key] = v.text;
            else if (ts.isIdentifier(v)) entry[key] = consts.get(v.getText()) ?? null;
            else if (ts.isArrayLiteralExpression(v) && v.elements.every(ts.isStringLiteral)) entry[key] = v.elements.map((e: any) => e.text);
          }
          if (entry.path) pages.push(entry);
        }
      }
    }
  });

  // The sweep registry: every concrete `path: '…'` literal in both files.
  const registryPaths = [...new Set([cmdSf.getFullText(), layoutSf.getFullText()]
    .flatMap((s) => [...s.matchAll(/\bpath:\s*'(\/[^']*)'/g)].map((m) => m[1]!)))]
    .filter((p) => !p.includes(':'));

  return { routes: [...routes.values()], pages, rail, registryPaths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  process.stdout.write(JSON.stringify(readRouteSources(i > 0 ? path.resolve(process.argv[i + 1]!) : REPO_ROOT)));
}
