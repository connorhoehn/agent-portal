// The production build's module graph must not reach Node-only code.
//
// check-bundle-node-free.mjs reads the built assets for marker strings, which a
// bundler can hide: a stubbed builtin whose name is minified away, or a Node
// package renamed on the way in, passes a substring scan. This reads the graph
// itself. The Vite plugin below runs at `generateBundle` over every module id
// Rollup resolved for the production build and fails the build when one is a
// Node builtin (a `node:` id, Vite's `__vite-browser-external` stub, or a bare
// builtin name) or a Node-only package. It also writes the result beside dist
// (`.module-graph.json`, ids relative to the portal, never shipped) so
// `npm run check:bundle` can confirm the graph was checked.
import { builtinModules } from 'node:module';
import { writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/** Packages that are Node-only whatever they are imported as. */
export const NODE_ONLY_PACKAGES = ['@connorhoehn/service-runtime'];
export const GRAPH_REPORT = '.module-graph.json';

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]]));

/** Why `id` is Node-only, or null. */
export function nodeOnlyReason(id) {
  const clean = String(id).replace(/^\0+/, '').replace(/\?.*$/, '');
  if (clean.startsWith('__vite-browser-external')) return `a Node builtin stubbed for the browser (${clean.split(':')[1] ?? 'unknown'})`;
  if (clean.startsWith('node:')) return 'a node: builtin';
  if (BUILTINS.has(clean) || BUILTINS.has(clean.split('/')[0])) return 'a Node builtin';
  const path = clean.split(sep).join('/');
  for (const pkg of NODE_ONLY_PACKAGES) {
    if (clean === pkg || clean.startsWith(`${pkg}/`) || path.includes(`/node_modules/${pkg}/`)) return `the Node-only package ${pkg}`;
  }
  return null;
}

/** `[{ id, reason }]` for every Node-only id. */
export function nodeOnlyModules(ids) {
  const out = [];
  for (const id of ids) {
    const reason = nodeOnlyReason(id);
    if (reason) out.push({ id: String(id), reason });
  }
  return out;
}

/** The Vite plugin (build only). */
export function nodeFreeGraph({ root = process.cwd(), report = resolve(root, GRAPH_REPORT) } = {}) {
  return {
    name: 'orgiq-node-free-graph',
    apply: 'build',
    generateBundle() {
      const ids = [...this.getModuleIds()];
      const offenders = nodeOnlyModules(ids).map((o) => ({
        id: o.id.startsWith('/') ? relative(root, o.id) : o.id.replace(/^\0+/, ''),
        reason: o.reason,
      }));
      writeFileSync(report, `${JSON.stringify({ checked: ids.length, offenders }, null, 2)}\n`);
      if (offenders.length) {
        this.error(`the production module graph reaches Node-only code:\n${offenders.map((o) => `  ${o.id}: ${o.reason}`).join('\n')}`);
      }
    },
  };
}
