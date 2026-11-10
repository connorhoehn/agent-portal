// The one switch that may open a security default (docs/fail-open-audit.md §2).
//
// `insecureDevMode()` is true only when INSECURE_DEV_MODE=true AND NODE_ENV is
// not production. Nothing else opens anything: an unset NODE_ENV, a missing
// secret or a missing policy store fails closed exactly as production does.
// `npm run dev`, `dev:mock`, the compose files and the jest setup set the flag;
// the ECS task never does (infra/test/middleware-service-stack.test.ts).
// Every middleware module imports the helper from this path.
//
// The library helper (service-runtime) vetoes only an exact
// `NODE_ENV=production`; this one also treats `Production`, `PRODUCTION`,
// `prod` and padded values as production, so a mistyped deployment value
// cannot leave the dev shortcuts on. Same exports, same signatures.

const FLAG = 'INSECURE_DEV_MODE';

/** NODE_ENV names production: `production` or `prod`, any case, trimmed. */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env['NODE_ENV'] ?? '').trim().toLowerCase();
  return value === 'production' || value === 'prod';
}

/** The explicit dev flag is on (trimmed, case-insensitive `true`), and this is not production. */
export function insecureDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FLAG] ?? '').trim().toLowerCase() === 'true' && !isProductionEnv(env);
}

/**
 * Boot gate for a named shortcut (`SKIP_AUTH`, `AUTH_DEMO_MODE`, …): the
 * shortcut is set but the dev flag is not, or this is production. Throws so
 * the process refuses to start instead of running open by accident.
 */
export function assertDevShortcutAllowed(shortcut: string, env: NodeJS.ProcessEnv = process.env): void {
  const value = (env[shortcut] ?? '').trim().toLowerCase();
  if (value !== 'true' && value !== '1') return;
  if (isProductionEnv(env)) throw new Error(`${shortcut}=${env[shortcut]} is not allowed in production`);
  if (!insecureDevMode(env)) throw new Error(`${shortcut}=${env[shortcut]} requires ${FLAG}=true (local development only)`);
}

let announced = false;

/** Log the one loud start-up line once per process when dev mode is on; returns the mode. */
export function announceInsecureDevMode(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.warn(line),
): boolean {
  const on = insecureDevMode(env);
  if (on && !announced) {
    announced = true;
    log(`[${FLAG}] insecure development mode is ON: authentication, authorization and signing shortcuts are enabled. Never set this in a deployed environment.`);
  }
  return on;
}
