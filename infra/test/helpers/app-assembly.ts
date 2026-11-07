/**
 * Synthesise the WHOLE CDK app (bin/app.ts) in-process, with no AWS calls.
 *
 * Why not `cdk synth`: the CLI resolves `env` from ambient credentials, which
 * turns both VPC-owning stacks (OrgIQ-Aurora, OrgIQ-MiddlewareService) into
 * account-specific stacks that need the availability-zones context provider —
 * i.e. a live STS call. On a box with expired credentials `cdk synth --all`
 * dies with "AWS was not able to validate the provided access credentials".
 *
 * In-process synth has no such problem: with CDK_DEFAULT_ACCOUNT unset the
 * stacks are environment-agnostic, `new ec2.Vpc` falls back to Fn::GetAZs, and
 * nothing reaches the network. That is the whole trick that makes this suite
 * runnable offline.
 *
 * Two things are neutralised before the app is loaded:
 *   - CDK_OUTDIR      → a throwaway temp dir, so tests never touch cdk.out.
 *   - execFileSync    → agentcore-runtime-stack.ts's resolveContainerUri()
 *                       shells out to `aws ecr describe-images` at SYNTH time
 *                       to digest-pin container images. Left alone it would
 *                       fire once per agent against a real AWS endpoint.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';

const APP_ENTRY = require.resolve('../../bin/app');

const AZ_CONTEXT = {
  'availability-zones:account=647757222309:region=us-east-1':
    ['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1d', 'us-east-1e', 'us-east-1f'],
};

// `require`, not `import * as` — a namespace import compiles to an
// __importStar copy whose properties are getter-only, so the stub below would
// throw and, worse, would not be visible to the module under test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('node:child_process') as any;

export interface SynthesisedApp {
  /** Stack name → parsed CloudFormation template (raw JSON). */
  readonly templates: Record<string, any>;
  /** Stack name → assertions Template, for Template.fromJSON-style matching. */
  template(stackName: string): Template;
  readonly stackNames: string[];
  /** Stack name -> `aws://account/region` as written in the cloud assembly manifest. */
  readonly environments: Record<string, string>;
  /** Stack name -> error annotations (`aws:cdk:error`), e.g. cdk-nag findings. */
  readonly errors: Record<string, string[]>;
  /** true when the app produced a template for this stack name. */
  has(stackName: string): boolean;
}

const cache = new Map<string, SynthesisedApp>();

/**
 * @param context CDK context, exactly as `--context k=v` would supply it.
 *                Note `cdk.json`'s `context` block is applied by the CLI, not
 *                by `new cdk.App()`, so it is NOT in effect here — pass what
 *                the scenario under test needs.
 */
export function synthApp(context: Record<string, string> = {}): SynthesisedApp {
  const key = JSON.stringify(context);
  const cached = cache.get(key);
  if (cached) return cached;

  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiq-cdk-test-'));

  const savedOutdir = process.env.CDK_OUTDIR;
  const savedContext = process.env.CDK_CONTEXT_JSON;
  const savedAccount = process.env.CDK_DEFAULT_ACCOUNT;
  const savedExec = childProcess.execFileSync;

  process.env.CDK_OUTDIR = outdir;
  // DE-17: stacks now carry the environment file's explicit account, so the AZ
  // lookup is answered from context (what infra/cdk.context.json does for the
  // CLI) instead of reaching for credentials.
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ ...AZ_CONTEXT, ...context });
  // Environment-agnostic on purpose — see the file header.
  delete process.env.CDK_DEFAULT_ACCOUNT;

  // The runtime stacks call execFileSync('aws', ['ecr', 'describe-images', ...]).
  // Make that a hard failure so the fallback (`:latest`) path is exercised
  // deterministically and no test ever depends on what is in a real registry.
  (childProcess as any).execFileSync = () => {
    throw new Error('execFileSync disabled in tests');
  };

  try {
    delete require.cache[APP_ENTRY];
    require(APP_ENTRY);
  } finally {
    (childProcess as any).execFileSync = savedExec;
    delete require.cache[APP_ENTRY];
    if (savedOutdir === undefined) delete process.env.CDK_OUTDIR;
    else process.env.CDK_OUTDIR = savedOutdir;
    if (savedContext === undefined) delete process.env.CDK_CONTEXT_JSON;
    else process.env.CDK_CONTEXT_JSON = savedContext;
    if (savedAccount !== undefined) process.env.CDK_DEFAULT_ACCOUNT = savedAccount;
  }

  const templates: Record<string, any> = {};
  for (const file of fs.readdirSync(outdir)) {
    if (!file.endsWith('.template.json')) continue;
    const name = file.slice(0, -'.template.json'.length);
    templates[name] = JSON.parse(fs.readFileSync(path.join(outdir, file), 'utf8'));
  }
  const environments: Record<string, string> = {};
  const errors: Record<string, string[]> = {};
  const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
  for (const [name, artifact] of Object.entries<any>(manifest.artifacts ?? {})) {
    if (artifact.type === 'aws:cloudformation:stack') environments[name] = artifact.environment;
    for (const [where, entries] of Object.entries<any>(artifact.metadata ?? {})) {
      for (const e of entries as any[]) {
        if (e.type === 'aws:cdk:error') (errors[name] ??= []).push(`${where}: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
      }
    }
  }
  fs.rmSync(outdir, { recursive: true, force: true });

  const result: SynthesisedApp = {
    templates,
    stackNames: Object.keys(templates).sort(),
    environments,
    errors,
    has: (stackName: string) => stackName in templates,
    template(stackName: string) {
      const t = templates[stackName];
      if (!t) {
        throw new Error(
          `no template for ${stackName}; app produced: ${Object.keys(templates).join(', ')}`,
        );
      }
      return Template.fromJSON(t);
    },
  };
  cache.set(key, result);
  return result;
}

/** Every `Fn::ImportValue` string literal anywhere in a template. */
export function importedExportNames(template: any): Set<string> {
  const found = new Set<string>();
  const walk = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Fn::ImportValue' && typeof v === 'string') found.add(v);
      walk(v);
    }
  };
  walk(template);
  return found;
}

/** Every `Outputs.*.Export.Name` string literal in a template. */
export function exportedNames(template: any): Set<string> {
  const found = new Set<string>();
  for (const output of Object.values<any>(template.Outputs ?? {})) {
    const name = output?.Export?.Name;
    if (typeof name === 'string') found.add(name);
  }
  return found;
}
