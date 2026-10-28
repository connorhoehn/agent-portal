// Seed-on-boot logic for AVP policies + schema. Runs once after middleware
// starts: if the policy store has no policies matching our seed descriptions,
// the .cedar files in middleware/seeds/ are pushed via CreatePolicy. Subsequent
// boots short-circuit. UI edits via the Identity Management page persist and
// are never overwritten.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VerifiedPermissionsClient,
  CreatePolicyCommand,
  DeletePolicyCommand,
  GetPolicyCommand,
  UpdatePolicyCommand,
  GetSchemaCommand,
  PutSchemaCommand,
} from '@aws-sdk/client-verifiedpermissions';
import { config } from '../config.js';
import { splitStatements } from './cedar-parse.js';
import { listAllPolicies, partitionSeedPolicies } from './avp-policies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Walk up from src/lib/ → ../../seeds (compiled location: dist/lib/ → ../../seeds also works).
function seedsDir(): string {
  for (const candidate of [
    join(__dirname, '..', '..', 'seeds'),
    join(__dirname, '..', 'seeds'),
    '/app/seeds',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Cannot locate middleware/seeds/ directory');
}

// Role definitions live under seeds/roles/{tenant}/{role}.cedar, with
// cross-tenant roles (admin) directly under seeds/roles/. Discovered at boot.
interface SeedRoleFile {
  /** e.g. 'member' or 'assessment/assessor' — tenant prefix omitted for orgiq
   * and root-level files so descriptions stay byte-identical with stores
   * seeded before the multi-tenant reorg. */
  key: string;
  path: string;
}

function discoverRoleFiles(dir: string): SeedRoleFile[] {
  const rolesDir = join(dir, 'roles');
  const out: SeedRoleFile[] = [];
  for (const entry of readdirSync(rolesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cedar')) {
      out.push({ key: entry.name.replace(/\.cedar$/, ''), path: join(rolesDir, entry.name) });
    } else if (entry.isDirectory()) {
      for (const f of readdirSync(join(rolesDir, entry.name))) {
        if (!f.endsWith('.cedar')) continue;
        const role = f.replace(/\.cedar$/, '');
        const key = entry.name === 'orgiq' ? role : `${entry.name}/${role}`;
        out.push({ key, path: join(rolesDir, entry.name, f) });
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function seedPolicyDescription(roleKey: string): string {
  // Stable description used as the idempotency key for first-boot seeding.
  // Don't rename this string — the seeder uses it to detect already-seeded policies.
  return `OrgIQ ${roleKey} role (seed)`;
}

// Boot-only client. Adaptive retries pace a burst of writes (a store with
// hundreds of duplicate seeds to delete) under AVP's control-plane throttle.
const client = new VerifiedPermissionsClient({ region: config.region, retryMode: 'adaptive', maxAttempts: 10 });


export async function seedPoliciesIfMissing(): Promise<void> {
  if (!config.auth.policyStoreId) {
    console.log('[seed] POLICY_STORE_ID unset — skipping policy seed');
    return;
  }
  const dir = seedsDir();
  const policyStoreId = config.auth.policyStoreId;

  // Snapshot existing policies (description → policyId). Reading only the
  // first page made every boot re-create the seeds it did not see; the live
  // store reached ~9 copies of each, and only the copy in this map was ever
  // updated, so a stale copy kept granting what its role had lost. Extra
  // copies of a seed description are deleted; the latest-updated one stays.
  const { keep: existingById, extra } = partitionSeedPolicies(await listAllPolicies(client, policyStoreId));
  for (const policyId of extra) await client.send(new DeletePolicyCommand({ policyStoreId, policyId }));
  const removed = extra.length;
  if (removed) console.log(`[seed] removed ${removed} duplicate seed policies`);

  function normalizeStmt(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  let created = 0;
  let updated = 0;
  for (const { key: role, path } of discoverRoleFiles(dir)) {
    const baseDescription = seedPolicyDescription(role);
    const cedar = readFileSync(path, 'utf8');
    const statements = splitStatements(cedar);

    for (let i = 0; i < statements.length; i++) {
      const description = statements.length === 1 ? baseDescription : `${baseDescription} (${i + 1})`;
      const statement = statements[i];

      if (existingById.has(description)) {
        // Policy exists — check if statement content changed and update if so.
        const policyId = existingById.get(description)!;
        const got = await client.send(new GetPolicyCommand({ policyStoreId, policyId }));
        const existingStmt = got.definition?.static?.statement ?? '';
        if (normalizeStmt(existingStmt) !== normalizeStmt(statement)) {
          // The description MUST ride along: UpdatePolicy replaces the whole
          // static definition, and AVP clears an omitted description — which
          // orphans this policy from the description-keyed map above, so every
          // later boot CreatePolicy's a duplicate. (Found live: 7 seed
          // policies had multiplied to 34 across restarts.)
          await client.send(new UpdatePolicyCommand({
            policyStoreId,
            policyId,
            definition: { static: { description, statement } },
          }));
          console.log(`[seed] updated policy for role=${role} stmt=${i + 1}/${statements.length}`);
          updated++;
        }
      } else {
        await client.send(new CreatePolicyCommand({
          policyStoreId,
          definition: { static: { description, statement } },
        }));
        console.log(`[seed] created policy for role=${role} stmt=${i + 1}/${statements.length}`);
        created++;
      }
    }
  }
  if (created === 0 && updated === 0 && removed === 0) {
    console.log('[seed] all baseline policies already present and up to date');
  }
}

export async function ensureSchema(): Promise<void> {
  if (!config.auth.policyStoreId) return;
  const policyStoreId = config.auth.policyStoreId;

  // Load the seed schema so we can compare against what AVP currently holds.
  const seedText = readFileSync(join(seedsDir(), 'schema.json'), 'utf8');
  type NsShape = { actions?: Record<string, unknown>; entityTypes?: Record<string, unknown> };
  const seedJson = JSON.parse(seedText) as Record<string, NsShape>;

  // Fetch current schema from AVP. If none exists yet we'll push the seed in full.
  let currentJson: Record<string, NsShape> = {};
  try {
    const current = await client.send(new GetSchemaCommand({ policyStoreId }));
    currentJson = JSON.parse(current.schema ?? '{}');
  } catch {
    // No schema yet — fall through and push the full seed below.
  }

  // Additive merge: for each namespace/action/entityType in the seed, add any
  // entries that are missing from the current AVP schema. Existing entries are
  // never removed or overwritten — admin UI customisations are preserved.
  let changed = false;
  const merged: Record<string, NsShape> = JSON.parse(JSON.stringify(currentJson));
  for (const [ns, seedNs] of Object.entries(seedJson)) {
    if (!merged[ns]) { merged[ns] = {}; changed = true; }
    const target = merged[ns]!;

    for (const [action, def] of Object.entries(seedNs.actions ?? {})) {
      if (!target.actions) target.actions = {};
      if (!target.actions[action]) { target.actions[action] = def; changed = true; }
    }
    for (const [et, def] of Object.entries(seedNs.entityTypes ?? {})) {
      if (!target.entityTypes) target.entityTypes = {};
      if (!target.entityTypes[et]) {
        target.entityTypes[et] = def;
        changed = true;
        continue;
      }
      // Entity type already exists — merge its shape attributes additively so
      // new seed attributes (e.g. User.tenant) reach stores created before the
      // attribute existed. Existing attribute definitions are never overwritten.
      type EtShape = { shape?: { attributes?: Record<string, unknown> } };
      const seedAttrs = (def as EtShape).shape?.attributes ?? {};
      const targetEt = target.entityTypes[et] as EtShape;
      if (!targetEt.shape) targetEt.shape = { attributes: {} };
      if (!targetEt.shape.attributes) targetEt.shape.attributes = {};
      for (const [attr, attrDef] of Object.entries(seedAttrs)) {
        if (!targetEt.shape.attributes[attr]) {
          targetEt.shape.attributes[attr] = attrDef;
          changed = true;
        }
      }
    }
  }

  if (!changed) {
    console.log('[seed] AVP schema already up to date');
    return;
  }

  await client.send(new PutSchemaCommand({
    policyStoreId,
    definition: { cedarJson: JSON.stringify(merged) },
  }));
  console.log('[seed] pushed schema update (additive merge)');
}
