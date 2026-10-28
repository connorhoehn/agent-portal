import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DE-17: one checked-in file per environment (`infra/environments/<name>.json`)
 * names the account, region, resource prefix and stack-id prefix. `bin/app.ts`
 * takes `env` from here, never from the shell, so credentials for another
 * account cannot deploy this fleet: CDK refuses a stack whose explicit account
 * differs from the credentials.
 *
 * No secrets in these files. `alertEmail` is personal data and deliberately not
 * a key; pass it as `--context alertEmail=` or keep it in SSM.
 */
export const ENVIRONMENTS_DIR = join(__dirname, '..', 'environments');
export const DEFAULT_ENVIRONMENT = 'lab';

export const KNOWN_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
] as const;

export interface Environment {
  readonly name: string;
  readonly account: string;
  readonly region: string;
  /** Lower-case resource prefix: `orgiq-*` names, `/orgiq/...` SSM paths. */
  readonly prefix: string;
  /** CloudFormation stack-id prefix: `OrgIQ` gives `OrgIQ-Foundation`. */
  readonly stackPrefix: string;
  readonly edge: { readonly mode: 'cloudfront' | 'domain'; readonly certificateArn?: string; readonly portalAlbOriginHost?: string };
  readonly features: { readonly social: boolean; readonly documents: boolean; readonly devbox: boolean };
  readonly monthlyBudgetUsd: number;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,19}$/;
const PREFIX_RE = /^[a-z][a-z0-9-]{1,14}$/;
const STACK_PREFIX_RE = /^[A-Z][A-Za-z0-9]{1,23}$/;

export function forbiddenAccounts(dir = ENVIRONMENTS_DIR): string[] {
  const raw = JSON.parse(readFileSync(join(dir, 'forbidden-accounts.json'), 'utf8'));
  if (!Array.isArray(raw.accounts) || !raw.accounts.every((a: unknown) => typeof a === 'string' && /^\d{12}$/.test(a))) {
    throw new Error('environment: forbidden-accounts.json must hold an "accounts" array of 12-digit strings');
  }
  return raw.accounts;
}

function fail(name: string, msg: string): never {
  throw new Error(`environment "${name}": ${msg}`);
}

export function parseEnvironment(name: string, raw: unknown, forbidden: readonly string[]): Environment {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(name, 'must be a JSON object');
  const o = raw as Record<string, any>;
  const allowed = new Set(['name', 'account', 'region', 'prefix', 'stackPrefix', 'edge', 'features', 'monthlyBudgetUsd']);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) fail(name, k === 'alertEmail'
      ? '"alertEmail" is personal data; pass --context alertEmail=... or keep it in SSM'
      : `unknown key "${k}"`);
  }
  if (o.name !== name) fail(name, `"name" is "${o.name}" but the file is ${name}.json`);
  if (typeof o.account !== 'string' || !/^\d{12}$/.test(o.account)) fail(name, 'account must be a 12-digit string');
  if (forbidden.includes(o.account)) fail(name, `account ${o.account} is forbidden (environments/forbidden-accounts.json)`);
  if (typeof o.region !== 'string' || !(KNOWN_REGIONS as readonly string[]).includes(o.region)) {
    fail(name, `region must be one of ${KNOWN_REGIONS.join(', ')}`);
  }
  if (typeof o.prefix !== 'string' || !PREFIX_RE.test(o.prefix)) fail(name, `prefix must match ${PREFIX_RE}`);
  if (typeof o.stackPrefix !== 'string' || !STACK_PREFIX_RE.test(o.stackPrefix)) fail(name, `stackPrefix must match ${STACK_PREFIX_RE}`);

  const edge = o.edge ?? { mode: 'cloudfront' };
  if (typeof edge !== 'object' || Array.isArray(edge)) fail(name, 'edge must be an object');
  for (const k of Object.keys(edge)) {
    if (k === 'portalAliases' || k === 'portalCertificateArn') {
      fail(name, 'edge.portalAliases is not supported yet (no CloudFront alias in PortalStack); use edge.mode "domain" for the ALB only');
    }
    if (!['mode', 'certificateArn', 'portalAlbOriginHost'].includes(k)) fail(name, `edge has unknown key "${k}"`);
  }
  if (edge.mode !== 'cloudfront' && edge.mode !== 'domain') fail(name, 'edge.mode must be "cloudfront" or "domain"');
  if (edge.mode === 'domain') {
    if (typeof edge.certificateArn !== 'string' || !edge.certificateArn.startsWith('arn:aws:acm:')) fail(name, 'edge.certificateArn must be an ACM ARN in domain mode');
    if (typeof edge.portalAlbOriginHost !== 'string' || !edge.portalAlbOriginHost) fail(name, 'edge.portalAlbOriginHost is required in domain mode');
  } else if (edge.certificateArn !== undefined || edge.portalAlbOriginHost !== undefined) {
    fail(name, 'edge.certificateArn / portalAlbOriginHost only apply to mode "domain"');
  }

  const f = o.features ?? {};
  if (typeof f !== 'object' || Array.isArray(f)) fail(name, 'features must be an object');
  for (const k of Object.keys(f)) {
    if (!['social', 'documents', 'devbox'].includes(k)) fail(name, `features has unknown key "${k}"`);
    if (typeof f[k] !== 'boolean') fail(name, `features.${k} must be a boolean`);
  }
  const budget = o.monthlyBudgetUsd ?? 200;
  if (typeof budget !== 'number' || !(budget > 0)) fail(name, 'monthlyBudgetUsd must be a positive number');

  return {
    name, account: o.account, region: o.region, prefix: o.prefix, stackPrefix: o.stackPrefix,
    edge: { mode: edge.mode, ...(edge.certificateArn && { certificateArn: edge.certificateArn }),
      ...(edge.portalAlbOriginHost && { portalAlbOriginHost: edge.portalAlbOriginHost }) },
    features: { social: f.social === true, documents: f.documents === true, devbox: f.devbox === true },
    monthlyBudgetUsd: budget,
  };
}

/** `dir` defaults to infra/environments; tests point it at a fixture directory. */
export function loadEnvironment(name: string = DEFAULT_ENVIRONMENT, dir: string = ENVIRONMENTS_DIR): Environment {
  if (!NAME_RE.test(name)) throw new Error(`environment: "${name}" is not a valid environment name (${NAME_RE})`);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`environment: ${file} does not exist`);
  // The forbidden list always comes from the real directory, never a fixture's.
  return parseEnvironment(name, JSON.parse(readFileSync(file, 'utf8')), forbiddenAccounts());
}

/** The stack id for a short name: `stackId(env, 'Foundation')` is `OrgIQ-Foundation` on lab. */
export const stackId = (env: Pick<Environment, 'stackPrefix'>, short: string): string => `${env.stackPrefix}-${short}`;
