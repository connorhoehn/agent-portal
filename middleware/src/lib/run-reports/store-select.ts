// Which RunReportStore the process uses: the runbook store's switch
// (lib/runbooks/store-select.ts). In-memory fixtures by default; the runbook
// store's own DynamoDB table when RUNBOOK_DYNAMODB_ENDPOINT / RUNBOOK_TABLE /
// RUNBOOK_STORE=dynamo says so. Cached per process; tests inject with setRunReportStore.
import { fixtureRunReportSources } from '../../mock/run-reports.js';
import { createRunbookDynamoClient, ensureRunbookTable, runbookStoreConfig, type RunbookStoreConfig } from '../runbooks/store-dynamo.js';
import { RowsRunReportStore } from './store-rows.js';
import { DynamoRunReportStore } from './store-dynamo.js';
import type { RunReportStore } from './store.js';

let current: RunReportStore | null = null;

export function createRunReportStore(cfg: RunbookStoreConfig = runbookStoreConfig()): RunReportStore {
  if (cfg.store !== 'dynamo') return new RowsRunReportStore(fixtureRunReportSources);
  const client = createRunbookDynamoClient(cfg);
  if (cfg.endpoint) void ensureRunbookTable(client, cfg.table).catch((e: unknown) => console.warn('[run-reports] could not ensure table', cfg.table, e));
  return new DynamoRunReportStore(client, cfg.table);
}

export function runReportStore(): RunReportStore { return (current ??= createRunReportStore()); }
export function setRunReportStore(next: RunReportStore | null): void { current = next; }
