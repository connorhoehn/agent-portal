#!/usr/bin/env node
'use strict';
//
// Fourth nav rule: a nav item gated NARROWER than the server's declared read
// tier. Reported as candidates against a ratcheted budget, not a hard zero —
// see the long note at the bottom for why this one cannot be auto-fixed.
//
// WHERE IT COMES FROM. `readForRolesElseAction(ROLES, ACTION)` is a deliberate
// statement: these roles may READ this surface even without the write
// capability. Effective readers are therefore ROLES ∪ everyone Cedar grants
// ACTION. If the rail/palette/route admit fewer than that, the server serves a
// page the product hides — which is exactly how Computer Lab ended up
// unreachable for org-leader, the one role `devbox-visibility.ts` treats as
// FLEET_WIDE and shows every computer.
//
// Both inputs are READ FROM THE CODE, never retyped: the role list and action
// from the `readForRolesElseAction(...)` call itself, the action's holders from
// the Cedar seed filenames in middleware/seeds/roles/<tenant>/. Only the
// nav-path → router-file association below is hand-written, because that is
// the one fact neither file states: which API a page reads. Keeping it here
// makes it reviewable, and a wrong row shows up as a finding rather than
// hiding.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ts = require(path.join(REPO, 'middleware', 'node_modules', 'typescript'));

/** nav path → the middleware file whose read gate serves it. */
const NAV_TO_ROUTER = [
  { nav: '/admin/knowledge',         file: 'middleware/src/index.ts',                  match: 'kbAdminRouter' },
  { nav: '/admin/ingest/crawl',      file: 'middleware/src/index.ts',                  match: 'ingestRouter' },
  { nav: '/admin/ingest/history',    file: 'middleware/src/index.ts',                  match: 'ingestRouter' },
  { nav: '/admin/ingest/storage',    file: 'middleware/src/index.ts',                  match: 'ingestRouter' },
  { nav: '/admin/ingest/sources',    file: 'middleware/src/index.ts',                  match: 'ingestRouter' },
  { nav: '/admin/ingest/schedules',  file: 'middleware/src/index.ts',                  match: 'ingestRouter' },
  { nav: '/iq/computers',           file: 'middleware/src/index.ts',                  match: 'devboxRouter' },
  { nav: '/admin/devbox',           file: 'middleware/src/index.ts',                  match: 'devboxRouter' }, // legacy alias, also used by historical calibration
  { nav: '/admin/budgets',           file: 'middleware/src/routes/budgets.ts',         match: null },
  { nav: '/admin/bots',              file: 'middleware/src/routes/bots.ts',            match: 'readGate' },
  { nav: '/admin/projects',          file: 'middleware/src/routes/agent-projects.ts',  match: null },
];

/** Every role Cedar grants `action`, from the seed filenames. */
function holdersOf(action) {
  const out = new Set();
  const base = path.join(REPO, 'middleware', 'seeds', 'roles');
  for (const tenant of fs.readdirSync(base)) {
    const dir = path.join(base, tenant);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.cedar')) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (new RegExp(`"${action}"`).test(text)) out.add(f.replace(/\.cedar$/, ''));
    }
  }
  return out;
}

/**
 * The FIRST `readForRolesElseAction([...], 'Action')` in `file` whose
 * surrounding statement text mentions `match` (or the first one at all when
 * `match` is null, which is right for a router file with a single read gate).
 */
function readTierIn(file, match) {
  const abs = path.join(REPO, file);
  if (!fs.existsSync(abs)) return null;
  const src = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
  let found = null;
  (function walk(node) {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText() === 'readForRolesElseAction') {
      const [rolesArg, actionArg] = node.arguments;
      if (rolesArg && ts.isArrayLiteralExpression(rolesArg)
          && rolesArg.elements.every(ts.isStringLiteral)
          && actionArg && ts.isStringLiteral(actionArg)) {
        // Widen to the enclosing statement so `match` can be a sibling token
        // (the router name in an app.use(...), or the const's own name).
        let stmt = node;
        while (stmt.parent && !ts.isStatement(stmt)) stmt = stmt.parent;
        const text = stmt.getText();
        // Word-boundary, not `includes`. bots.ts declares BOTH `readGate` and
        // `marketReadGate`, and a substring match hits the second as well —
        // today it still resolves correctly only because `readGate` happens to
        // be declared first and this takes the first hit. That is luck, not a
        // rule, and the whole point of this scanner is catching exactly that
        // kind of quietly-wrong answer.
        const hit = match
          ? new RegExp(`(^|[^A-Za-z0-9_])${match}([^A-Za-z0-9_]|$)`).test(text)
          : true;
        if (hit) {
          found = { roles: rolesArg.elements.map((e) => e.text), action: actionArg.text };
        }
      }
    }
    node.forEachChild(walk);
  })(src);
  return found;
}

/** The palette's roles per nav path (null = every role in the tenant). */
function paletteRoles() {
  const abs = path.join(REPO, 'portal/src/components/shell/portalCommands.ts');
  const src = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
  const consts = new Map();
  const byPath = new Map();
  (function walk(node) {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (d.initializer && ts.isArrayLiteralExpression(d.initializer)
            && d.initializer.elements.every(ts.isStringLiteral) && d.name.getText() !== 'PAGES') {
          consts.set(d.name.getText(), d.initializer.elements.map((e) => e.text));
        }
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      let p = null; let roles = null; let hasRoles = false;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const k = prop.name.getText();
        if (k === 'path' && ts.isStringLiteral(prop.initializer)) p = prop.initializer.text;
        if (k === 'roles') {
          hasRoles = true;
          const v = prop.initializer;
          if (ts.isIdentifier(v)) roles = consts.get(v.getText()) ?? null;
          else if (ts.isArrayLiteralExpression(v) && v.elements.every(ts.isStringLiteral)) {
            roles = v.elements.map((e) => e.text);
          }
        }
      }
      if (p) byPath.set(p, hasRoles ? roles : null);
    }
    node.forEachChild(walk);
  })(src);
  return byPath;
}

function main() {
  const palette = paletteRoles();
  for (const row of NAV_TO_ROUTER) {
    const navRoles = palette.get(row.nav);
    if (navRoles === undefined) continue;          // not a palette entry
    // An unrestricted page cannot hide any of the server's readers. This
    // also covers Computers, which combines everyone's paired machines with
    // lab reads gated within the page; its write selector need not be guessed.
    if (navRoles === null) continue;
    const tier = readTierIn(row.file, row.match);
    if (!tier) {
      process.stdout.write(JSON.stringify({
        rule: 'nav-server-tier-unresolved', nav: row.nav, file: row.file,
        detail: 'no readForRolesElseAction found for this nav row — the map is stale',
      }) + '\n');
      continue;
    }
    const serverRead = new Set([...tier.roles, ...holdersOf(tier.action)]);
    // `admin` is cross-tenant and passes every gate; it is never listed in the
    // palette, so comparing it would flag every row.
    serverRead.delete('admin');
    const missing = [...serverRead].filter((r) => !navRoles.includes(r)).sort();
    if (missing.length > 0) {
      process.stdout.write(JSON.stringify({
        rule: 'nav-narrower-than-server', nav: row.nav, action: tier.action,
        serverRead: [...serverRead].sort().join(','), nav_roles: [...navRoles].sort().join(','),
        missing: missing.join(','),
        detail: 'the server serves these roles a surface the nav hides from them',
      }) + '\n');
    }
  }
}

main();
