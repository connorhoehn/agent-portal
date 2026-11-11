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
// App.tsx, the palette and the rail are parsed in ONE place — the route
// sources module the route inventory also reads (audit 2026-10-07 T4). The
// calibration below runs this file from a temp tree, so the module is
// resolved against that tree first (it copies portal/e2e/route-sources.ts),
// and handed that tree as its root.
function readSources() {
  const local = path.join(REPO, 'portal', 'e2e', 'route-sources.ts');
  const real = path.join(__dirname, '..', '..', 'portal', 'e2e', 'route-sources.ts');
  const mod = require(fs.existsSync(local) ? local : real);
  return mod.readRouteSources(REPO);
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
  const src = readSources();
  // A wildcard/param route is a shape, not a jump target.
  const routes = new Map(src.routes.filter((r) => !/[:*]/.test(r.path)).map((r) => [r.path, { roles: r.roles, isRedirect: r.isRedirect }]));
  // A scoped splat also mounts at its root: /iq/logging/* accepts
  // /iq/logging. Do not treat a catch-all or invented descendant as a page,
  // and let an explicit root route retain precedence over its splat.
  for (const route of src.routes) {
    const root = route.path.endsWith('/*') ? route.path.slice(0, -2) : '';
    if (root && !/[:*]/.test(root) && !routes.has(root)) routes.set(root, route);
  }
  const pages = src.pages;
  const rail = new Map(src.rail.map((r) => [r.path, { roles: r.roles, hasRoles: r.hasRoles }]));

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
