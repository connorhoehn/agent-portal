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
  GetPolicyCommand,
  UpdatePolicyCommand,
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

  // Snapshot existing policies (description → policyId).
  const existing = await client.send(new ListPoliciesCommand({ policyStoreId }));
  const existingById = new Map<string, string>(); // description → policyId
  for (const p of existing.policies ?? []) {
    const desc = p.definition?.static?.description ?? '';
    const id = p.policyId ?? '';
    if (desc && id) existingById.set(desc, id);
  }

  // Split a Cedar file into individual policy statements. AVP's CreatePolicy
  // only accepts one statement (permit/forbid) per call.
  function splitStatements(cedar: string): string[] {
    const noComments = cedar.replace(/\/\/[^\n]*/g, '');
    const statements: string[] = [];
    let remaining = noComments;
    while (remaining.length > 0) {
      const m = remaining.match(/\b(permit|forbid)\s*\(/);
      if (!m || m.index === undefined) break;
      remaining = remaining.slice(m.index);
      let depth = 0;
      let i = 0;
      for (; i < remaining.length; i++) {
        if (remaining[i] === '(') depth++;
        else if (remaining[i] === ')') { depth--; if (depth === 0) break; }
      }
      const withWhen = remaining.slice(0, i + 1);
      const afterParen = remaining.slice(i + 1);
      const whenMatch = afterParen.match(/^\s*when\s*\{[^}]*\}\s*;?/);
      const stmt = whenMatch ? withWhen + whenMatch[0] : withWhen;
      const trimmed = stmt.trim().replace(/;?\s*$/, ';');
      if (trimmed) statements.push(trimmed);
      remaining = afterParen.slice(whenMatch ? whenMatch[0].length : 0);
    }
    return statements.filter(s => s.length > 0);
  }

  function normalizeStmt(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  let created = 0;
  let updated = 0;
  for (const role of SEED_ROLES) {
    const baseDescription = seedPolicyDescription(role);
    const cedar = readFileSync(join(dir, `${role}.cedar`), 'utf8');
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
          await client.send(new UpdatePolicyCommand({
            policyStoreId,
            policyId,
            definition: { static: { statement } },
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
  if (created === 0 && updated === 0) {
    console.log('[seed] all baseline policies already present and up to date');
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
