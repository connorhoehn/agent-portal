// The microVM runner's configuration (docs/microvm-runner-design.md §5, §6, §9, §10).
//
// Read straight off the environment per call, like routes/devbox.ts, so the
// module stays importable under the CommonJS jest build (config.ts uses
// import.meta) and an operator's change needs no code path of its own.
//
// FAIL CLOSED. `runtimeArn` unset means "this deployment has no microVM
// runtime": every microvm job is held back with `no-microvm-runtime`, and is
// never handed to the fleet instead. The infra lane (infra/lib/middleware-service-stack.ts)
// sets MICROVM_RUNTIME_ARN, MICROVM_RUNS_BUCKET, MICROVM_COMPUTE_USD_PER_SECOND and MICROVM_LAB_API_BASE
// only with `-c microvm=true`.
//
// SSM FALLBACK. When MICROVM_RUNTIME_ARN (or MICROVM_RUNS_BUCKET) is unset,
// `loadMicrovmParameters` reads the parameters OrgIQ-MicrovmRuntime writes
// (`/<prefix>/microvm/runtime-arn`, `endpoint-arn`, `runs-bucket`) ONCE at
// start-up and caches them here; the environment always wins. A parameter
// that does not exist leaves the value null, so a deployment with neither
// still holds every job back as `no-microvm-runtime`.

export interface MicrovmConfig {
  /** MICROVM_RUNTIME_ARN, else the cached `/<prefix>/microvm/runtime-arn`. Null = no runner. */
  runtimeArn: string | null;
  /** MICROVM_ENDPOINT_ARN, else the cached `/<prefix>/microvm/endpoint-arn` (informational). */
  endpointArn: string | null;
  /** MICROVM_RUNS_BUCKET, else the cached `/<prefix>/microvm/runs-bucket`. Null = no runner. */
  runsBucket: string | null;
  /** MICROVM_COMPUTE_USD_PER_SECOND — active session time, folded to one rate (§6). */
  computeUsdPerSecond: number;
  /**
   * The BFF origin the box's lab broker forwards to. MICROVM_LAB_API_BASE,
   * else `https://lab.<PROJECT_PREFIX>.internal` — the private zone the
   * network stack creates and the runtime's own LAB_API_BASE names.
   */
  labApiBase: string;
  /** Where labApiBase came from: the env (infra sets it from the runtime's LAB_API_BASE) or the default. */
  labApiBaseSource: 'env' | 'default';
  /**
   * The fleet secret the broker signs the lab envelope with. The microVM
   * execution role has no Secrets Manager grant (§12), so it rides the boot
   * payload; the BFF already holds it as LAB_CALLBACK_SECRET.
   */
  callbackSecret: string | null;
  /**
   * Where the box's workspace is. main.py confines the clone target under
   * realpath(workspace); with no session storage (§2) that is its tempdir
   * fallback, `<tempdir>/devbox-workspace`. MICROVM_WORKSPACE_ROOT overrides.
   * Only the pre-boot default: once a boot reports its `workspace_root`, the
   * dispatcher uses that (lib/microvm-dispatcher.ts `learnedWorkspaceRoot`).
   */
  workspaceRoot: string;
  /** MICROVM_MAX_SESSIONS_PER_ACTOR (default 2, §10 item 10). */
  maxSessionsPerActor: number;
  /** MICROVM_RESUME_WINDOW_H (default 72, §9). */
  resumeWindowH: number;
  /** MICROVM_DISPATCH_BATCH — jobs judged per tick (default 4). */
  batch: number;
  /** AWS_REGION, for the presigner. */
  region: string;
  /** The tenant microVM runs are charged to and keyed by (the only tenant that dispatches devbox work). */
  tenant: string;
}

function num(raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const nonEmpty = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

// ─── The SSM fallback, read once ──────────────────────────────────────────────

export interface MicrovmParameters { runtimeArn: string | null; endpointArn: string | null; runsBucket: string | null }

/** Reads one parameter's value; null when it does not exist. Throws on any other error. */
export type ParameterReader = (name: string) => Promise<string | null>;

const ENV_OF = { runtimeArn: 'MICROVM_RUNTIME_ARN', endpointArn: 'MICROVM_ENDPOINT_ARN', runsBucket: 'MICROVM_RUNS_BUCKET' } as const;

let ssmCache: MicrovmParameters | null = null;
let loading: Promise<MicrovmParameters> | null = null;

export const microvmParameterNames = (prefix: string) => ({
  runtimeArn: `/${prefix}/microvm/runtime-arn`,
  endpointArn: `/${prefix}/microvm/endpoint-arn`,
  runsBucket: `/${prefix}/microvm/runs-bucket`,
});

/** GetParameter through the SDK, loaded lazily so this module stays import-light. */
export const ssmParameterReader = (region: string): ParameterReader => {
  let client: { send: (c: unknown) => Promise<{ Parameter?: { Value?: string } }> } | null = null;
  return async (name) => {
    const ssm = await import('@aws-sdk/client-ssm');
    client ??= new ssm.SSMClient({ region }) as never;
    try {
      const out = await client!.send(new ssm.GetParameterCommand({ Name: name }));
      return nonEmpty(out.Parameter?.Value);
    } catch (err) {
      if ((err as { name?: string }).name === 'ParameterNotFound') return null;
      throw err;
    }
  };
};

/**
 * Start-up: fill whatever the environment leaves unset from SSM, once. Idempotent
 * (a second call returns the first's result). Offline (MOCK_AGENTCORE) and with
 * every value already in the env it reads nothing. A read error leaves that
 * value null — fail closed, the job waits as `no-microvm-runtime`.
 */
export function loadMicrovmParameters(
  read?: ParameterReader, env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = (m) => console.log(m),
): Promise<MicrovmParameters> {
  if (ssmCache) return Promise.resolve(ssmCache);
  if (loading) return loading;
  loading = (async () => {
    const prefix = nonEmpty(env['PROJECT_PREFIX']) ?? 'orgiq';
    const names = microvmParameterNames(prefix);
    const out: MicrovmParameters = { runtimeArn: null, endpointArn: null, runsBucket: null };
    const offline = env['MOCK_AGENTCORE'] === 'true';
    // The endpoint ARN rides along with the runtime ARN; the bucket stands alone.
    const needed: Array<keyof MicrovmParameters> = [
      ...(!nonEmpty(env[ENV_OF.runtimeArn]) ? ['runtimeArn' as const, ...(!nonEmpty(env[ENV_OF.endpointArn]) ? ['endpointArn' as const] : [])] : []),
      ...(!nonEmpty(env[ENV_OF.runsBucket]) ? ['runsBucket' as const] : []),
    ];
    if (!offline && needed.length) {
      const reader = read ?? ssmParameterReader(nonEmpty(env['AWS_REGION']) ?? 'us-east-1');
      for (const k of needed) {
        try { out[k] = await reader(names[k]); } catch (err) {
          log(`[microvm] SSM ${names[k]} unreadable (${(err as { name?: string }).name ?? 'error'}); left unset`);
        }
      }
    }
    if (!offline) for (const k of needed) log(`[microvm] ${ENV_OF[k]} unset; ${names[k]} ${out[k] ? 'found in SSM' : 'not in SSM'}`);
    ssmCache = out;
    loading = null;
    return out;
  })();
  return loading;
}

/** Tests: forget the cached parameters. */
export function _resetMicrovmParameters(next: MicrovmParameters | null = null): void {
  ssmCache = next;
  loading = null;
}

export function microvmConfig(env: NodeJS.ProcessEnv = process.env): MicrovmConfig {
  const prefix = nonEmpty(env['PROJECT_PREFIX']) ?? 'orgiq';
  const labEnv = nonEmpty(env['MICROVM_LAB_API_BASE']);
  return {
    runtimeArn: nonEmpty(env['MICROVM_RUNTIME_ARN']) ?? ssmCache?.runtimeArn ?? null,
    endpointArn: nonEmpty(env['MICROVM_ENDPOINT_ARN']) ?? ssmCache?.endpointArn ?? null,
    runsBucket: nonEmpty(env['MICROVM_RUNS_BUCKET']) ?? ssmCache?.runsBucket ?? null,
    computeUsdPerSecond: num(env['MICROVM_COMPUTE_USD_PER_SECOND'], 0),
    labApiBase: labEnv ?? `https://lab.${prefix}.internal`,
    labApiBaseSource: labEnv ? 'env' : 'default',
    callbackSecret: nonEmpty(env['LAB_CALLBACK_SECRET']),
    workspaceRoot: (nonEmpty(env['MICROVM_WORKSPACE_ROOT']) ?? '/tmp/devbox-workspace').replace(/\/+$/, ''),
    maxSessionsPerActor: Math.floor(num(env['MICROVM_MAX_SESSIONS_PER_ACTOR'], 2, 1)),
    resumeWindowH: num(env['MICROVM_RESUME_WINDOW_H'], 72, 0),
    batch: Math.floor(num(env['MICROVM_DISPATCH_BATCH'], 4, 1)),
    region: nonEmpty(env['AWS_REGION']) ?? 'us-east-1',
    tenant: 'orgiq',
  };
}
