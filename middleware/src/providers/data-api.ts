// The RDS Data API transport, with row-level security (docs/next-steps.md §8
// work item 22, schema/row_level_security.sql, providers/db-tenant.ts).
//
// aurora.ts (`exec`, `withTransaction`, used by ~80 modules) and identity.ts
// send through here. Under RLS_ENFORCE:
//   * a transaction sets `app.tenant` once, right after it begins: 1 extra call;
//   * an autocommit statement that names a tenant table becomes begin, set,
//     statement, commit: 3 extra calls.
// Statements on other tables, and every statement with RLS_ENFORCE off, keep
// their single call. Kept free of aurora.ts so identity.ts (which must not
// import it) can share it.

import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type ExecuteStatementCommandOutput,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';
import { SET_TENANT_SQL, currentDbTenant, rlsEnforced, touchesTenantTable, warnIfMisconfigured } from './db-tenant.js';

let _client: RDSDataClient | null = null;
function client(): RDSDataClient {
  if (!_client) {
    warnIfMisconfigured();
    _client = new RDSDataClient({ region: config.region });
  }
  return _client;
}

function target() {
  return { resourceArn: config.aurora.clusterArn, secretArn: config.aurora.secretArn };
}

function sendStatement(sql: string, params: SqlParameter[], transactionId?: string): Promise<ExecuteStatementCommandOutput> {
  return client().send(
    new ExecuteStatementCommand({
      ...target(),
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
      ...(transactionId ? { transactionId } : {}),
    }),
  );
}

/** Begins a Data API transaction and, under RLS_ENFORCE, scopes it to the request's tenants. */
export async function beginTransaction(): Promise<string> {
  const begun = await client().send(new BeginTransactionCommand({ ...target(), database: config.aurora.database }));
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error('BeginTransactionCommand did not return a transactionId');
  if (rlsEnforced()) {
    try {
      await sendStatement(SET_TENANT_SQL, [{ name: 'app_tenant', value: { stringValue: currentDbTenant() } }], transactionId);
    } catch (err) {
      await rollbackTransaction(transactionId);
      throw err;
    }
  }
  return transactionId;
}

export async function commitTransaction(transactionId: string): Promise<void> {
  await client().send(new CommitTransactionCommand({ ...target(), transactionId }));
}

/** Best-effort: a rollback failure never masks the error that caused it (the transaction times out on its own). */
export async function rollbackTransaction(transactionId: string): Promise<void> {
  try {
    await client().send(new RollbackTransactionCommand({ ...target(), transactionId }));
  } catch {
    // see above
  }
}

/**
 * One statement, raw output. Inside a transaction (`transactionId`) it is sent
 * as is: the transaction already carries the tenant. Outside one, a statement
 * on a tenant table runs in its own scoped transaction when RLS_ENFORCE is on.
 */
export async function executeStatement(
  sql: string, params: SqlParameter[] = [], transactionId?: string,
): Promise<ExecuteStatementCommandOutput> {
  if (transactionId || !rlsEnforced() || !touchesTenantTable(sql)) return sendStatement(sql, params, transactionId);
  const tx = await beginTransaction();
  try {
    const out = await sendStatement(sql, params, tx);
    await commitTransaction(tx);
    return out;
  } catch (err) {
    await rollbackTransaction(tx);
    throw err;
  }
}
