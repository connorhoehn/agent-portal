// The microVM runner's configuration (docs/microvm-runner-design.md §5, §6, §9, §10).
//
// Read straight off the environment per call, like routes/devbox.ts, so the
// module stays importable under the CommonJS jest build (config.ts uses
// import.meta) and an operator's change needs no code path of its own.
//
// FAIL CLOSED. `runtimeArn` unset means "this deployment has no microVM
// runtime": every microvm job is held back with `no-microvm-runtime`, and is
// never handed to the fleet instead. The infra lane (infra/lib/middleware-service-stack.ts)
// sets MICROVM_RUNTIME_ARN, MICROVM_RUNS_BUCKET and MICROVM_COMPUTE_USD_PER_SECOND
// only with `-c microvm=true`.

export interface MicrovmConfig {
  /** MICROVM_RUNTIME_ARN — the `<prefix>_microvm` runtime. Null = no runner. */
  runtimeArn: string | null;
  /** MICROVM_RUNS_BUCKET — where transcripts go (`runs/` prefix). Null = no runner. */
  runsBucket: string | null;
  /** MICROVM_COMPUTE_USD_PER_SECOND — active session time, folded to one rate (§6). */
  computeUsdPerSecond: number;
  /**
   * The BFF origin the box's lab broker forwards to. MICROVM_LAB_API_BASE,
   * else `https://lab.<PROJECT_PREFIX>.internal` — the private zone the
   * network stack creates and the runtime's own LAB_API_BASE names.
   */
  labApiBase: string;
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

export function microvmConfig(env: NodeJS.ProcessEnv = process.env): MicrovmConfig {
  const prefix = nonEmpty(env['PROJECT_PREFIX']) ?? 'orgiq';
  return {
    runtimeArn: nonEmpty(env['MICROVM_RUNTIME_ARN']),
    runsBucket: nonEmpty(env['MICROVM_RUNS_BUCKET']),
    computeUsdPerSecond: num(env['MICROVM_COMPUTE_USD_PER_SECOND'], 0),
    labApiBase: nonEmpty(env['MICROVM_LAB_API_BASE']) ?? `https://lab.${prefix}.internal`,
    callbackSecret: nonEmpty(env['LAB_CALLBACK_SECRET']),
    workspaceRoot: (nonEmpty(env['MICROVM_WORKSPACE_ROOT']) ?? '/tmp/devbox-workspace').replace(/\/+$/, ''),
    maxSessionsPerActor: Math.floor(num(env['MICROVM_MAX_SESSIONS_PER_ACTOR'], 2, 1)),
    resumeWindowH: num(env['MICROVM_RESUME_WINDOW_H'], 72, 0),
    batch: Math.floor(num(env['MICROVM_DISPATCH_BATCH'], 4, 1)),
    region: nonEmpty(env['AWS_REGION']) ?? 'us-east-1',
    tenant: 'orgiq',
  };
}
