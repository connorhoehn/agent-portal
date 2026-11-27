// The tenant brand lives twice: as CSS (portal/src/app.css, each light
// `[data-tenant="<id>"]` block) for the portal, and as `brand` in
// tenants/manifest.json for the server, which derives each tenant's deck theme
// from it. This holds the two equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const css = readFileSync(join(repo, 'portal', 'src', 'app.css'), 'utf8');
const manifest = JSON.parse(readFileSync(join(repo, 'tenants', 'manifest.json'), 'utf8')) as {
  tenants: Array<{ id: string; brand?: { accent: string; accentInk?: string } }>;
};

/** The declarations of the light `[data-tenant="<id>"] { … }` block (the dark ones are prefixed with html[data-theme="dark"]). */
function tenantBlock(id: string): string | null {
  const match = new RegExp(`^\\[data-tenant="${id}"\\]\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1]! : null;
}

function cssVar(block: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(block)?.[1];
}

test('every tenant the CSS brands has a manifest brand with the same accent and ink', () => {
  for (const tenant of manifest.tenants) {
    const block = tenantBlock(tenant.id);
    if (!block) { assert.equal(tenant.brand, undefined, `${tenant.id}: the manifest has a brand but app.css has no [data-tenant] block`); continue; }
    const accent = cssVar(block, '--color-brand');
    const ink = cssVar(block, '--color-brand-ink');
    assert.ok(tenant.brand, `${tenant.id}: app.css brands this tenant but the manifest has no brand`);
    assert.equal(tenant.brand.accent.toLowerCase(), accent?.toLowerCase(), `${tenant.id}: brand.accent differs from --color-brand`);
    assert.equal(tenant.brand.accentInk?.toLowerCase(), ink?.toLowerCase(), `${tenant.id}: brand.accentInk differs from --color-brand-ink`);
  }
});

test('the check reads real blocks', () => {
  assert.ok(tenantBlock('orgiq'));
  assert.equal(manifest.tenants.filter(t => t.brand).length, manifest.tenants.length);
});
