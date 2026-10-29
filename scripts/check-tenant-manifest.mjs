#!/usr/bin/env node
// DE-29: what stays hand-written per product must agree with tenants/manifest.json.
//
//   node scripts/check-tenant-manifest.mjs [--root <dir>]
//
// Router mounts, route trees, Cedar policies and the shell's per-product
// presentation stay code. This asserts they match the manifest:
//   - generated files equal a fresh `gen-tenants.mjs` run;
//   - seeds/roles/<id>/ holds exactly the manifest's roles, no unregistered
//     tenant directory exists, and each cross-tenant role is a top-level file;
//   - each tenant has an `app.use('<apiPrefix>…', requireTenant('<id>')` mount
//     in middleware/src/index.ts (orgiq: any requireTenant('orgiq') mount);
//   - App.tsx has a `path="<portalRoot>"` tree;
//   - the shell rail labels (Layout.tsx TENANT_LABELS) and the chooser tiles
//     (SelectContextPage.tsx TENANT_META) name each tenant by its displayName;
//   - CLAUDE.md names each tenant's roles in order on one line (the pattern the
//     tenant judges grep).
// Exit 0 when all agree, 1 with one line per disagreement.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputs } from './gen-tenants.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const read = (root, rel) => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };

/** The `{ … }` body after `const <name>` up to the first line that is just `};`. */
function block(src, name) {
  const at = src.indexOf(`const ${name}`);
  if (at < 0) return '';
  const end = src.indexOf('\n};', at);
  return src.slice(at, end < 0 ? undefined : end);
}

export function checkTenantManifest(root) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'tenants', 'manifest.json'), 'utf8')); }
  catch (e) { return [`tenants/manifest.json: ${e.message}`]; }

  // 1. Generated files.
  try {
    for (const [rel, body] of outputs(root)) {
      if (read(root, rel) !== body) problems.push(`${rel}: differs from a fresh \`node scripts/gen-tenants.mjs\` run`);
    }
  } catch (e) { problems.push(e.message); return problems; }

  // 2. Cedar seeds.
  const rolesDir = join(root, 'middleware', 'seeds', 'roles');
  if (!existsSync(rolesDir)) problems.push('middleware/seeds/roles/: missing');
  else {
    const entries = readdirSync(rolesDir, { withFileTypes: true });
    const dirs = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
    const top = new Set(entries.filter(e => e.isFile() && e.name.endsWith('.cedar')).map(e => e.name.replace(/\.cedar$/, '')));
    for (const r of manifest.crossTenantRoles) if (!top.has(r)) problems.push(`seeds/roles/${r}.cedar: cross-tenant role "${r}" has no Cedar file`);
    for (const r of top) if (!manifest.crossTenantRoles.includes(r)) problems.push(`seeds/roles/${r}.cedar: top-level role not in manifest crossTenantRoles`);
    const ids = new Set(manifest.tenants.map(t => t.id));
    for (const d of dirs) if (!ids.has(d)) problems.push(`seeds/roles/${d}/: tenant directory not registered in tenants/manifest.json`);
    for (const t of manifest.tenants) {
      if (!dirs.has(t.id)) { problems.push(`seeds/roles/${t.id}/: missing (manifest roles ${t.roles.join(', ')})`); continue; }
      const files = new Set(readdirSync(join(rolesDir, t.id)).filter(f => f.endsWith('.cedar')).map(f => f.replace(/\.cedar$/, '')));
      for (const r of t.roles) if (!files.has(r)) problems.push(`seeds/roles/${t.id}/${r}.cedar: manifest role has no Cedar file`);
      for (const f of files) if (!t.roles.includes(f)) problems.push(`seeds/roles/${t.id}/${f}.cedar: role not listed in the manifest for ${t.id}`);
    }
  }

  // 3. Mounts.
  const index = read(root, 'middleware/src/index.ts') ?? '';
  for (const t of manifest.tenants) {
    const re = t.apiPrefix
      ? new RegExp(`app\\.use\\(\\s*'${esc(t.apiPrefix)}(/[^']*)?'\\s*,\\s*requireTenant\\('${esc(t.id)}'\\)`)
      : new RegExp(`app\\.use\\(\\s*'/api/[^']*'\\s*,\\s*requireTenant\\('${esc(t.id)}'\\)`);
    if (!re.test(index)) problems.push(`middleware/src/index.ts: no app.use('${t.apiPrefix || '/api/…'}', requireTenant('${t.id}')…) mount`);
  }

  // 4. Route trees.
  const app = read(root, 'portal/src/App.tsx') ?? '';
  for (const t of manifest.tenants) {
    const seg = t.portalRoot.slice(1);
    if (!new RegExp(`path="/?${esc(seg)}"`).test(app)) problems.push(`portal/src/App.tsx: no path="${seg}" route tree for ${t.id}`);
  }

  // 5. Shell presentation copies.
  const layout = block(read(root, 'portal/src/components/shell/Layout.tsx') ?? '', 'TENANT_LABELS');
  const picker = block(read(root, 'portal/src/pages/SelectContextPage.tsx') ?? '', 'TENANT_META');
  for (const t of manifest.tenants) {
    if (!new RegExp(`^\\s*${esc(t.id)}:\\s*'${esc(t.displayName)}'`, 'm').test(layout)) problems.push(`portal/src/components/shell/Layout.tsx: TENANT_LABELS lacks ${t.id}: '${t.displayName}'`);
    if (!new RegExp(`^\\s*${esc(t.id)}:\\s*\\{\\s*label:\\s*'${esc(t.displayName)}'`, 'm').test(picker)) problems.push(`portal/src/pages/SelectContextPage.tsx: TENANT_META lacks ${t.id}: { label: '${t.displayName}' }`);
  }

  // 6. CLAUDE.md, the human copy.
  const claude = read(root, 'CLAUDE.md') ?? '';
  for (const t of manifest.tenants) {
    const re = new RegExp([t.id, ...t.roles].map(x => `\`${esc(x)}\``).join('.*'));
    if (!claude.split('\n').some(line => re.test(line))) problems.push(`CLAUDE.md: no line names \`${t.id}\` and its roles in order (${t.roles.join(' / ')})`);
  }
  return problems;
}

function main(argv) {
  const ri = argv.indexOf('--root');
  const root = ri >= 0 ? resolve(argv[ri + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkTenantManifest(root);
  if (problems.length) { for (const p of problems) console.error(`check-tenant-manifest: ${p}`); return 1; }
  console.log('check-tenant-manifest: seeds, mounts, route trees, shell labels, CLAUDE.md and generated files agree with tenants/manifest.json');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
