import type { Construct } from 'constructs';

/**
 * Boolean CDK context flags, read the same way everywhere.
 *
 * `--context k=true` arrives as the string "true"; tests and cdk.json can pass
 * a real boolean. Anything else that is set (e.g. "yes") is refused, so a
 * typo on a security flag fails the synth instead of silently taking the
 * default. Every flag is listed, with its default and reason, in
 * infra/SECURITY-NOTES.md.
 */
export function contextFlag(scope: Construct, key: string, fallback: boolean): boolean {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw new Error(`--context ${key} must be true or false, got ${JSON.stringify(v)}`);
}

/**
 * `protectData` (default true): deletion protection on, and RETAIN on Aurora,
 * the documents bucket and the Cognito user pool. `-c protectData=false` is for
 * throwaway stacks only.
 */
export const protectData = (scope: Construct): boolean => contextFlag(scope, 'protectData', true);

/**
 * `dbMasterSecret` (default false): the one-release fallback that hands the
 * Aurora master secret back to the middleware, the writer agents and the
 * knowledge base instead of their scoped service roles.
 */
export const dbMasterSecret = (scope: Construct): boolean => contextFlag(scope, 'dbMasterSecret', false);

/**
 * `authDev` (default false): the Cognito app client's admin-password flow and
 * the localhost callback/logout URLs. Development pools only.
 */
export const authDev = (scope: Construct): boolean => contextFlag(scope, 'authDev', false);
