// Which RunbookStore the process uses (the lib/social-chat.ts rule): the mock
// is the default; Dynamo is opt-in via RUNBOOK_DYNAMODB_ENDPOINT / RUNBOOK_TABLE
// or RUNBOOK_STORE=dynamo. Cached per process; tests inject with setRunbookStore.
import { fixtureRunbookSources } from '../../mock/runbooks.js';
import { RowsRunbookStore } from './store-rows.js';
import { DynamoRunbookStore, createRunbookDynamoClient, ensureRunbookTable, runbookStoreConfig, type RunbookStoreConfig } from './store-dynamo.js';
import type { RunbookStore } from './store.js';

let current: RunbookStore | null = null;

export function createRunbookStore(cfg: RunbookStoreConfig = runbookStoreConfig()): RunbookStore {
  if (cfg.store !== 'dynamo') return new RowsRunbookStore(fixtureRunbookSources);
  const client = createRunbookDynamoClient(cfg);
  // A local emulator starts empty; create the table on first use. The cloud table is CDK's, so never create there.
  if (cfg.endpoint) void ensureRunbookTable(client, cfg.table).catch((e: unknown) => console.warn('[runbooks] could not ensure table', cfg.table, e));
  return new DynamoRunbookStore(client, cfg.table);
}

export function runbookStore(): RunbookStore { return (current ??= createRunbookStore()); }
export function setRunbookStore(next: RunbookStore | null): void { current = next; }
