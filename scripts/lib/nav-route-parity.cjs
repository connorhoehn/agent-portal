#!/usr/bin/env node
'use strict';
//
// Nav ↔ route parity for scripts/validate-nav-parity.sh.
//
// `components/shell/portalCommands.ts` opens with a promise: "Every page with
// a rail or sub-rail entry is here; gates mirror the routes' RequireRole so
// the palette never offers a jump that bounces." Both halves of that are
// mechanically checkable against App.tsx, and neither was checked — a palette
// entry is a plain object literal, so a route that gains a RequireRole, moves,
// or is deleted leaves the catalog claiming a jump that now 404s or 403s.
//
// A bouncing ⌘K jump is a particularly bad bug to ship: the palette is how
// someone who does not know the rail finds a page, so the failure lands on
// exactly the person with the least context to understand it.
//
// Three findings:
//   missing-route  — a PAGES entry whose `path` matches no route in App.tsx.
//   role-mismatch  — a PAGES entry whose `roles` disagree with the RequireRole
//                    gates actually wrapping that route.
//   rail-mismatch  — a RAIL entry in Layout.tsx whose `requireRoles` disagree
//                    with the palette entry for the same path.
//
// The third exists because ONE gate is written down in THREE places — the rail
// (Layout.tsx `requireRoles`), the palette (portalCommands.ts `roles`) and the
// route (App.tsx `RequireRole`) — with the server's mount as an unwritten
// fourth. Computer Lab had drifted across all of them: the server served
// org-leader and program-owner, DevboxPage was built for them (FLEET_READ_ROLES
// plus a read-only mode), and the rail comment described all four roles in
// prose — while every one of the three lists said `['hr-admin', 'sme']`, so
// the page's own fix sat one layer below a door that never opened.
//
// Deliberately NOT checked: the reverse direction (a route with no palette
// entry). Plenty of routes are details, tabs and redirects that should not be
// jump targets, so that direction is noise, not signal.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ts = require(path.join(REPO, 'middleware', 'node_modules', 'typescript'));

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function tagName(node) {
  const t = node.tagName || (node.openingElement && node.openingElement.tagName);
  return t ? t.getText() : '';
}

function attrs(node) {
  const open = node.openingElement || node;
  const out = {};
  for (const a of (open.attributes ? open.attributes.properties : [])) {
    if (!a.name) continue;
    out[a.name.getText()] = a.initializer;
  }
  return out;
}

function stringOf(init) {
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) return init.expression.text;
  return null;
}

/** The string members of an array-literal attribute, e.g. roles={['a','b']}. */
function stringArrayOf(init) {
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  const e = init.expression;
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out = [];
  for (const el of e.elements) {
    if (ts.isStringLiteral(el)) out.push(el.text);
    else return null; // a spread or identifier — can't resolve statically
  }
  return out;
}

/** The roles on the outermost <RequireRole> inside a JSX expression, or null.
 *  Outermost, not all: nested gates would intersect, and no route nests them. */
function outermostRequireRole(init) {
  if (!ts.isJsxExpression(init) || !init.expression) return null;
  let found = null;
  (function walk(n) {
    if (found) return;
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === 'RequireRole') {
      found = stringArrayOf(attrs(n)['roles']);
      return;
    }
    n.forEachChild(walk);
  })(init.expression);
  return found;
}

function joinPath(prefix, seg) {
  if (seg === undefined || seg === null) return prefix;
  if (seg.startsWith('/')) return seg.replace(/\/+$/, '') || '/';
  const base = prefix === '/' ? '' : prefix;
  return (base + '/' + seg).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

/** Walk App.tsx's JSX, accumulating the path prefix and the RequireRole gates
 *  in scope. Returns full path -> { roles, isRedirect }. */
function collectRoutes(sourceFile) {
  const routes = new Map();

  function visit(node, prefix, roles) {
    let nextPrefix = prefix;
    let nextRoles = roles;

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const a = attrs(node);

      if (name === 'RequireRole') {
        const r = stringArrayOf(a['roles']);
        if (r) nextRoles = roles === null ? r.slice() : roles.filter((x) => r.includes(x));
      }

      if (name === 'Route') {
        const p = stringOf(a['path']);
        const hasIndex = Object.prototype.hasOwnProperty.call(a, 'index');
        nextPrefix = hasIndex ? prefix : joinPath(prefix, p);

        const elInit = a['element'];
        let isRedirect = false;
        if (elInit && ts.isJsxExpression(elInit) && elInit.expression) {
          isRedirect = /(^|\W)Navigate(\W|$)/.test(elInit.expression.getText());
        }
        // The gate is almost never an ANCESTOR of the <Route>; App.tsx writes
        // it INSIDE `element={<RequireRole …><Page …/></RequireRole>}`. Reading
        // only ancestors made every gated page report "(any role)" — 45 false
        // positives, and a checker that says everything is broken says nothing.
        const elRoles = elInit ? outermostRequireRole(elInit) : null;
        if (elRoles) {
          nextRoles = nextRoles === null ? elRoles.slice() : nextRoles.filter((x) => elRoles.includes(x));
        }
        // A wildcard/param route is a shape, not a jump target.
        const concrete = !/[:*]/.test(nextPrefix);
        if (concrete && (p !== undefined || hasIndex)) {
          const prev = routes.get(nextPrefix);
          // Keep the most permissive gate if a path appears twice.
          if (!prev) routes.set(nextPrefix, { roles: nextRoles, isRedirect });
          else if (prev.isRedirect && !isRedirect) routes.set(nextPrefix, { roles: nextRoles, isRedirect });
        }
      }
    }

    node.forEachChild((c) => visit(c, nextPrefix, nextRoles));
  }

  visit(sourceFile, '/', null);
  return routes;
}

/** Read the RAIL array out of Layout.tsx: path -> requireRoles (or null). */
function collectRail(sourceFile) {
  const rail = new Map();
  (function walk(node) {
    if (ts.isObjectLiteralExpression(node)) {
      let p = null; let roles = null; let hasRoles = false;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name.getText();
        if (key === 'path' && ts.isStringLiteral(prop.initializer)) p = prop.initializer.text;
        if (key === 'requireRoles') {
          hasRoles = true;
          const v = prop.initializer;
          roles = (ts.isArrayLiteralExpression(v) && v.elements.every(ts.isStringLiteral))
            ? v.elements.map((e) => e.text) : null;
        }
      }
      // A nav row is recognised by having BOTH a path and a label; other
      // object literals in the file (command defs, style maps) have neither.
      const hasLabel = node.properties.some((pr) => ts.isPropertyAssignment(pr) && pr.name.getText() === 'label');
      if (p && hasLabel) {
        rail.set(p.replace(/\/+$/, '') || '/', { roles: hasRoles ? roles : null, hasRoles });
      }
    }
    node.forEachChild(walk);
  })(sourceFile);
  return rail;
}

/** Read PAGES out of portalCommands.ts, resolving the role consts it uses. */
function collectPages(sourceFile) {
  const consts = new Map();
  const pages = [];

  sourceFile.forEachChild(function top(node) {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!d.initializer || !d.name) continue;
        const nm = d.name.getText();
        if (ts.isArrayLiteralExpression(d.initializer)) {
          const vals = d.initializer.elements.every(ts.isStringLiteral)
            ? d.initializer.elements.map((e) => e.text) : null;
          if (vals && nm !== 'PAGES') consts.set(nm, vals);
        }
        if (nm === 'PAGES' && ts.isArrayLiteralExpression(d.initializer)) {
          for (const el of d.initializer.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const entry = { line: sourceFile.getLineAndCharacterOfPosition(el.getStart()).line + 1 };
            for (const prop of el.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const key = prop.name.getText();
              const v = prop.initializer;
              if (ts.isStringLiteral(v)) entry[key] = v.text;
              else if (ts.isIdentifier(v)) entry[key] = consts.get(v.getText()) ?? null;
              else if (ts.isArrayLiteralExpression(v) && v.elements.every(ts.isStringLiteral)) {
                entry[key] = v.elements.map((e) => e.text);
              }
            }
            if (entry.path) pages.push(entry);
          }
        }
      }
    }
  });
  return pages;
}

/** Every role the tenant defines, from the Cedar seeds — the authority on how
 *  many there are. Reading the directory rather than hardcoding means adding a
 *  role updates this check for free. */
function tenantRoles(tenant) {
  const dir = path.join(REPO, 'middleware', 'seeds', 'roles', tenant);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.cedar'))
    .map((f) => f.replace(/\.cedar$/, ''))
    .sort();
}

function main() {
  const appFile = path.join(REPO, 'portal', 'src', 'App.tsx');
  const cmdFile = path.join(REPO, 'portal', 'src', 'components', 'shell', 'portalCommands.ts');
  const layoutFile = path.join(REPO, 'portal', 'src', 'components', 'shell', 'Layout.tsx');
  const routes = collectRoutes(parse(appFile));
  const pages = collectPages(parse(cmdFile));
  const rail = collectRail(parse(layoutFile));

  if (pages.length === 0) {
    process.stderr.write('nav-route-parity: parsed 0 PAGES entries — the catalog shape changed\n');
    process.exit(2);
  }
  if (routes.size === 0) {
    process.stderr.write('nav-route-parity: parsed 0 routes from App.tsx — the route shape changed\n');
    process.exit(2);
  }

  // Rail ↔ palette: the same gate, written twice.
  // A palette jump may carry a query or hash (`/iq/distillation/review?view=promotions`);
  // routes and rail rows are keyed by pathname, so match on that (2026-09-29).
  const pathnameOf = (path) => path.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
  for (const p of pages) {
    const key = pathnameOf(p.path);
    const railEntry = rail.get(key);
    if (railEntry && railEntry.hasRoles && railEntry.roles) {
      // The cross-tenant `admin` passes every gate, and the palette documents
      // that it never lists it. The tenant-nav filter in Layout.tsx has no
      // admin bypass, so the rail MUST list it — the two spellings mean the
      // same thing, so compare with it removed.
      const a = railEntry.roles.filter((r) => r !== 'admin').sort().join(',');
      const b = p.roles == null ? null : [...p.roles].sort().join(',');
      if (b !== null && a !== b) {
        process.stdout.write(JSON.stringify({
          rule: 'rail-mismatch', label: p.label, path: p.path, line: p.line,
          rail: a, palette: b,
          detail: 'the rail and the palette gate the same page differently',
        }) + '\n');
      }
    }
  }

  for (const p of pages) {
    const r = routes.get(pathnameOf(p.path));
    if (!r) {
      process.stdout.write(JSON.stringify({
        rule: 'missing-route', label: p.label, path: p.path, line: p.line,
        detail: 'the palette offers this jump but App.tsx has no matching route — it 404s',
      }) + '\n');
      continue;
    }
    const routeRoles = r.roles === null ? null : [...r.roles].sort();
    const pageRoles = p.roles == null ? null : [...p.roles].sort();
    // An UNGATED route inside RequireTenant already means "any role this
    // tenant has". So a palette entry that lists exactly the tenant's full
    // role set says the same thing a different way — equivalent, not drift.
    // /assessment/configuration is deliberately this shape: all three
    // assessment roles may read it, and App.tsx carries no RequireRole on
    // purpose. Without this the checker's only finding would have been a
    // documented non-bug, which is how a checker earns its way to being
    // ignored.
    const full = tenantRoles(p.tenant);
    const listsWholeTenant = routeRoles === null && pageRoles !== null && full !== null
      && pageRoles.join(',') === full.join(',');

    const same = (routeRoles === null && pageRoles === null)
      || listsWholeTenant
      || (routeRoles && pageRoles && routeRoles.join(',') === pageRoles.join(','));
    if (!same) {
      process.stdout.write(JSON.stringify({
        rule: 'role-mismatch', label: p.label, path: p.path, line: p.line,
        palette: pageRoles === null ? '(any role)' : pageRoles.join(','),
        route: routeRoles === null ? '(any role)' : routeRoles.join(','),
        detail: 'palette gate disagrees with the route\'s RequireRole',
      }) + '\n');
    }
  }
}

main();
