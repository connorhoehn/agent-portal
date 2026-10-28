// Shared helpers for the deployed-stack probes. Packages resolve through
// middleware/node_modules (a script outside middleware/ cannot `import 'ws'`
// by name), AWS goes through the CLI's default profile, and no secret value is
// ever printed.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const middleware = resolve(root, 'middleware');
const requireFromMiddleware = createRequire(resolve(middleware, 'package.json'));

/** Import a package as middleware/ would. */
export async function mwImport<T = any>(specifier: string): Promise<T> {
  return import(pathToFileURL(requireFromMiddleware.resolve(specifier)).href);
}
/** Import a middleware source file (tsx compiles it). */
export async function mwSource<T = any>(relative: string): Promise<T> {
  return import(pathToFileURL(resolve(middleware, relative)).href);
}

export const LAB_ACCOUNT = '647757222309';
export function aws(args: string[]): string {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function assertLabAccount(): void {
  const account = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  if (account !== LAB_ACCOUNT) throw new Error(`credentials are for ${account}, not ${LAB_ACCOUNT}; run aws-azure-login`);
}
export function stackOutput(stack: string, key: string): string {
  return aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text']);
}
export function secretValue(id: string): string {
  return aws(['secretsmanager', 'get-secret-value', '--secret-id', id, '--query', 'SecretString', '--output', 'text']);
}

/** One SELECT through the Data API as the cluster admin (the read-only role cannot read app_users). */
export function aurora(sql: string): any[][] {
  const cluster = aws(['rds', 'describe-db-clusters', '--query', "DBClusters[?contains(DBClusterIdentifier,'orgiq')].DBClusterArn | [0]", '--output', 'text']);
  const secret = stackOutput('OrgIQ-Aurora', 'CredentialsSecretArn');
  const out = JSON.parse(aws(['rds-data', 'execute-statement', '--resource-arn', cluster, '--secret-arn', secret,
    '--database', 'orgiq', '--sql', sql, '--output', 'json']));
  return (out.records ?? []).map((row: any[]) => row.map(f => f.isNull ? null : Object.values(f)[0]));
}

/** A seeded user's real grants and epoch, so a probe's token passes principal revalidation. */
export function directoryUser(userId: string): { name: string; epoch: number; grants: Record<string, string[]> } {
  if (!/^[a-z0-9-]+$/.test(userId)) throw new Error('user id must be like u-farah');
  const rows = aurora(`SELECT u.display_name, u.session_epoch, r.tenant_id, r.role FROM app_users u
    LEFT JOIN user_tenant_roles r ON r.user_id = u.id WHERE u.id = '${userId}'`);
  if (!rows.length) throw new Error(`${userId} is not in app_users`);
  const grants: Record<string, string[]> = {};
  for (const [, , tenant, role] of rows) if (tenant && role) (grants[tenant] ??= []).push(role);
  return { name: rows[0][0], epoch: Number(rows[0][1] ?? 0), grants };
}

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
export function args(name: string): string[] {
  return process.argv.flatMap((a, i) => a === `--${name}` ? [process.argv[i + 1]!] : []);
}
