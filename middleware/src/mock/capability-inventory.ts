// The two sides of the capability reconciliation, offline.
//
// WHY. `/api/capabilities/reconcile` compares the ids this process is
// CONFIGURED with against the resources that actually EXIST in the account.
// Offline neither side has anything: `.env.aws` is not read, so every id is
// empty and every row reports `unconfigured`. The page renders, and it renders
// the one state that says nothing — an auditor never sees `ok`, never sees
// `missing`, and cannot tell whether the reconciliation logic works at all.
//
// So both sides are fixtures, and the provider runs its REAL probe over them.
// The states and the sentences a reader sees are produced by the same code
// path AWS drives, rather than typed out next to the ids they describe.
//
// The default world is the one the CLAUDE.md gotcha describes: capability ids
// are minted fresh whenever OrgIQ-AgentCoreCapabilities is recreated and
// nothing regenerates `middleware/.env.aws`, so after a rebuild ONE id is
// usually left pointing at a resource that no longer exists. Here it is the
// browser profile — the failure that surfaced as a bare 500 and took an
// afternoon to trace. Everything else is healthy, which is what makes the one
// stale row legible.

import { defineFixture } from './core/index.js';

/** Which listing a resource belongs to — one per AWS API the probe calls. */
export type CapabilityResourceKind =
  | 'browser' | 'browserProfile' | 'codeInterpreter' | 'memory' | 'guardrail';

/** A resource AWS would return from the matching List* call. */
export interface CapabilityResourceRow {
  resource: CapabilityResourceKind;
  id: string;
  /** AWS's own status word. READY / ACTIVE / AVAILABLE all mean healthy. */
  status: string | null;
}

/** An id this process is configured with, and the env var that sets it. */
export interface CapabilityConfigRow {
  key: 'browser' | 'browserProfile' | 'codeInterpreter' | 'memory'
     | 'guardrailMember' | 'guardrailOrgLeader' | 'guardrailHrAdmin';
  configuredId: string;
}

/** What `.env.aws` would say. The browser profile id is the stale one. */
export const capabilityConfigRows = defineFixture<CapabilityConfigRow>({
  key: 'capability-config',
  scenarios: {
    default: () => [
      { key: 'browser', configuredId: 'orgiq_browser-MOCK00BRWS' },
      // Minted by the PREVIOUS capabilities stack; the live profile below has
      // a different id. This is the row that should read `missing`.
      { key: 'browserProfile', configuredId: 'orgiq_browser_profile-STALE0PRF' },
      { key: 'codeInterpreter', configuredId: 'orgiq_code_interpreter-MOCK00CI' },
      { key: 'memory', configuredId: 'orgiq_memory-MOCK00MEM' },
      { key: 'guardrailMember', configuredId: 'gr0mockmember' },
      { key: 'guardrailOrgLeader', configuredId: 'gr0mockleader' },
      { key: 'guardrailHrAdmin', configuredId: 'gr0mockhradmn' },
    ],
    // Nothing configured at all — a middleware that has never had .env.aws
    // written. Every row reports `unconfigured`, which is a different problem
    // from a stale id and gets a different sentence.
    empty: () => [],
  },
});

/** What the account actually holds. */
export const capabilityInventoryRows = defineFixture<CapabilityResourceRow>({
  key: 'capability-inventory',
  scenarios: {
    default: () => [
      { resource: 'browser', id: 'orgiq_browser-MOCK00BRWS', status: 'READY' },
      // The live profile — note the id the config above does NOT carry.
      { resource: 'browserProfile', id: 'orgiq_browser_profile-MOCK00PRF', status: 'READY' },
      { resource: 'codeInterpreter', id: 'orgiq_code_interpreter-MOCK00CI', status: 'READY' },
      { resource: 'memory', id: 'orgiq_memory-MOCK00MEM', status: 'ACTIVE' },
      { resource: 'guardrail', id: 'gr0mockmember', status: 'READY' },
      { resource: 'guardrail', id: 'gr0mockleader', status: 'READY' },
      { resource: 'guardrail', id: 'gr0mockhradmn', status: 'READY' },
    ],
    // The account after a teardown: the ids are still in .env.aws, the
    // resources are gone. Every configured row reads `missing`, and the detail
    // says the account has none of these at all rather than naming a live id.
    empty: () => [],
  },
});
