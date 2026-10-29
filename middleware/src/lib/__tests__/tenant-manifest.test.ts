// DE-29: every middleware consumer switched to tenants/manifest.json keeps the
// exact values it hand-held before (2026-10-29, HEAD 355d985b). The literals
// below are those pre-manifest values, deliberately typed out: they pin
// "behaviour unchanged for the five existing tenants". A new tenant changes
// this file on purpose.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TENANTS, ROLES_BY_TENANT, permissiveGrants } from '../session.js';
import { TENANT_MANIFEST } from '../tenants.generated.js';
import { HUDDLE_CHAT_TENANTS } from '../call-access.js';
import { TENANT_CHANNEL_FAMILIES, TENANT_PARTITIONS } from '../tenant-channels.js';
import { INDEXED_TENANTS } from '../search-index/tenants.js';
import { ACCESS_TENANTS } from '../access/types.js';
import { manifestRoleFiles } from '../tenant-roles.js';

const root = [process.cwd(), join(process.cwd(), '..')].find((d) => existsSync(join(d, 'tenants', 'manifest.json')))!;
const manifest = JSON.parse(readFileSync(join(root, 'tenants', 'manifest.json'), 'utf8')) as {
  crossTenantRoles: string[];
  tenants: Array<{ id: string; displayName: string; roles: string[]; apiPrefix: string }>;
};
const rolesDir = join(root, 'middleware', 'seeds', 'roles');

describe('session vocabulary', () => {
  it('TENANTS and ROLES_BY_TENANT are the pre-manifest lists, in order', () => {
    expect([...TENANTS]).toEqual(['orgiq', 'assessment', 'social', 'pipelines', 'access']);
    expect(ROLES_BY_TENANT).toEqual({
      orgiq: ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin'],
      assessment: ['assessor', 'lead-assessor', 'program-lead'],
      social: ['participant', 'moderator', 'community-admin'],
      pipelines: ['author', 'operator', 'pipeline-admin'],
      access: ['requester', 'approver', 'access-admin'],
    });
  });

  it('the demo identity still holds orgiq + assessment only, every role plus admin', () => {
    expect(permissiveGrants()).toEqual({
      orgiq: ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin'],
      assessment: ['assessor', 'lead-assessor', 'program-lead', 'admin'],
    });
  });

  it('the generated copy matches tenants/manifest.json', () => {
    expect([...TENANTS]).toEqual(manifest.tenants.map((t) => t.id));
    for (const t of manifest.tenants) {
      expect(TENANT_MANIFEST[t.id as keyof typeof TENANT_MANIFEST].displayName).toBe(t.displayName);
      expect([...ROLES_BY_TENANT[t.id as keyof typeof ROLES_BY_TENANT]]).toEqual(t.roles);
    }
  });
});

describe('capability subsets', () => {
  it('keep their pre-manifest members', () => {
    expect([...HUDDLE_CHAT_TENANTS]).toEqual(['orgiq', 'assessment', 'social']);
    expect([...TENANT_PARTITIONS]).toEqual(['orgiq', 'assessment', 'pipelines', 'access']);
    expect([...INDEXED_TENANTS]).toEqual(['orgiq', 'assessment', 'social', 'pipelines', 'access']);
    expect([...ACCESS_TENANTS]).toEqual(['orgiq', 'assessment', 'social', 'pipelines']);
  });

  it('the presence lobby families are orgiq, assessment and pipelines, last in the table', () => {
    const lobbies = TENANT_CHANNEL_FAMILIES.filter((f) => f.id.endsWith(':lobby'));
    expect(lobbies.map((f) => f.id)).toEqual(['orgiq:lobby', 'assessment:lobby', 'pipelines:lobby']);
    expect(TENANT_CHANNEL_FAMILIES.slice(-3).map((f) => f.id)).toEqual(lobbies.map((f) => f.id));
    for (const f of lobbies) expect(f.pattern.test(`${f.tenant}:lobby`)).toBe(true);
  });
});

describe('Cedar seed loader', () => {
  // The directory walk policy-seeds.ts and role-registry.ts did before DE-29.
  function walk() {
    const out: Array<{ key: string; role: string; tenant: string | null; path: string }> = [];
    for (const e of readdirSync(rolesDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.cedar')) {
        const role = e.name.replace(/\.cedar$/, '');
        out.push({ key: role, role, tenant: null, path: join(rolesDir, e.name) });
      } else if (e.isDirectory()) {
        for (const f of readdirSync(join(rolesDir, e.name))) {
          if (!f.endsWith('.cedar')) continue;
          const role = f.replace(/\.cedar$/, '');
          out.push({ key: e.name === 'orgiq' ? role : `${e.name}/${role}`, role, tenant: e.name, path: join(rolesDir, e.name, f) });
        }
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  it('registers exactly the files the old directory walk found, with the same seed keys', () => {
    const fromManifest = manifestRoleFiles(rolesDir).sort((a, b) => a.key.localeCompare(b.key));
    expect(fromManifest).toEqual(walk());
  });

  it('refuses a manifest role with no Cedar file', () => {
    expect(() => manifestRoleFiles(join(rolesDir, 'does-not-exist'))).toThrow(/no Cedar file/);
  });
});

describe('mount table', () => {
  const index = readFileSync(join(root, 'middleware', 'src', 'index.ts'), 'utf8');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  it('every tenant with an API prefix mounts it behind requireTenant(<id>)', () => {
    for (const t of manifest.tenants.filter((x) => x.apiPrefix)) {
      expect(index).toMatch(new RegExp(`app\\.use\\('${esc(t.apiPrefix)}(/[^']*)?', *requireTenant\\('${t.id}'\\)`));
    }
  });

  it('the tenant root mounts are unchanged', () => {
    expect(index).toMatch(/app\.use\('\/api\/social', requireTenant\('social'\), socialRouter\)/);
    expect(index).toMatch(/app\.use\('\/api\/pipelines', requireTenant\('pipelines'\), pipelinesRouter\)/);
    expect(index).toMatch(/app\.use\('\/api\/access', requireTenant\('access'\), accessRouter\)/);
    // assessment gates inside its router (the sessionless run-complete callback).
    expect(index).toMatch(/app\.use\('\/api\/assessment', assessmentRouter\)/);
  });
});
