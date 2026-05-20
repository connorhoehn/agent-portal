// Seed-on-boot logic for AVP policies + schema. Runs once after middleware
// starts: if the policy store has no policies matching our seed descriptions,
// the .cedar files in middleware/seeds/ are pushed via CreatePolicy. Subsequent
// boots short-circuit. UI edits via the Identity Management page persist and
// are never overwritten.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VerifiedPermissionsClient,
  ListPoliciesCommand,
  CreatePolicyCommand,
  GetSchemaCommand,
  PutSchemaCommand,
} from '@aws-sdk/client-verifiedpermissions';
import { config } from '../config.js';

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

// ManageCanary: gates PUT /weight and POST /halt on the canary surface
const SEED_ROLES = ['member', 'org-leader', 'hr-admin'] as const;

function seedPolicyDescription(role: string): string {
  // Stable description used as the idempotency key for first-boot seeding.
  // Don't rename this string — the seeder uses it to detect already-seeded policies.
  return `OrgIQ ${role} role (seed)`;
}

const client = new VerifiedPermissionsClient({ region: config.region });

export async function seedPoliciesIfMissing(): Promise<void> {
  if (!config.auth.policyStoreId) {
    console.log('[seed] POLICY_STORE_ID unset — skipping policy seed');
    return;
  }
  const dir = seedsDir();
  const policyStoreId = config.auth.policyStoreId;

  // Snapshot existing policies. Lightweight — we don't paginate because there
  // will never be more than a few dozen even after admin edits.
  const existing = await client.send(new ListPoliciesCommand({ policyStoreId }));
  const existingDescriptions = new Set(
    (existing.policies ?? [])
      .map(p => p.definition?.static?.description ?? '')
      .filter(Boolean),
  );

  let created = 0;
  for (const role of SEED_ROLES) {
    const description = seedPolicyDescription(role);
    if (existingDescriptions.has(description)) continue;

    const cedar = readFileSync(join(dir, `${role}.cedar`), 'utf8');
    await client.send(new CreatePolicyCommand({
      policyStoreId,
      definition: { static: { description, statement: cedar } },
    }));
    console.log(`[seed] created baseline policy for role=${role}`);
    created++;
  }
  if (created === 0) {
    console.log('[seed] all baseline policies already present');
  }
}

export async function ensureSchema(): Promise<void> {
  if (!config.auth.policyStoreId) return;
  const policyStoreId = config.auth.policyStoreId;

  // If the store already has a schema with actions, leave it alone — admins may
  // have customized it via the UI. Only push the seed schema when the store is
  // empty (first-deploy case where CDK didn't initialize it).
  const current = await client.send(new GetSchemaCommand({ policyStoreId }));
  const currentJson = current.schema ?? '';
  let isEmpty = true;
  try {
    const parsed = JSON.parse(currentJson) as Record<string, { actions?: Record<string, unknown> }>;
    isEmpty = Object.values(parsed).every(ns => !ns.actions || Object.keys(ns.actions).length === 0);
  } catch {
    isEmpty = true;
  }
  if (!isEmpty) return;

  const seed = readFileSync(join(seedsDir(), 'schema.json'), 'utf8');
  await client.send(new PutSchemaCommand({
    policyStoreId,
    definition: { cedarJson: seed },
  }));
  console.log('[seed] pushed baseline schema');
}
