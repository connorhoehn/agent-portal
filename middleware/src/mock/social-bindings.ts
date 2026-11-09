// Context bindings under dev:mock (docs/social-tenant-design.md §4.4, §4.6 —
// lane E): a `social:` channel attached to something in another tenant.
// Live: Aurora `social_bindings` (schema/social_schema.sql), read and written
// by providers/social-bindings.ts. One row per context.
//
// The seed binds three initiatives (orgiq) to their channels
// (mock/social-channels.ts): Auth Migration to #auth-migration, Observability
// Platform to #observability and LLM Application Platform to #llm-platform, so
// each overview opens on a bound discussion; `empty` is the unbound state.

import { clock, defineFixture } from './core/index.js';

export interface SocialBindingRow {
  /** The CONTEXT's tenant (orgiq, assessment) — never `social`. */
  tenant: string;
  contextKind: string;
  contextId: string;
  /** A `social:` channel — `social:ch:<slug>` today. */
  channel: string;
  createdBy: string;
  createdAt: string;
}

export const socialBindingsFixture = defineFixture<SocialBindingRow>({
  key: 'social.bindings',
  scenarios: {
    default: () => [
      { tenant: 'orgiq', contextKind: 'initiative', contextId: 'p-auth-migration', channel: 'social:ch:auth-migration', createdBy: 'u-vera', createdAt: clock.daysAgo(8) },
      { tenant: 'orgiq', contextKind: 'initiative', contextId: 'p-observability', channel: 'social:ch:observability', createdBy: 'u-nora', createdAt: clock.daysAgo(12) },
      { tenant: 'orgiq', contextKind: 'initiative', contextId: 'p-llm-platform', channel: 'social:ch:llm-platform', createdBy: 'u-nina', createdAt: clock.daysAgo(11) },
    ],
    empty: () => [],
  },
});
