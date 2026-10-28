/**
 * Prints an environment as KEY=value lines for deploy.sh / destroy.sh:
 *   node --require ts-node/register scripts/print-environment.ts lab
 * Exits non-zero (message on stderr) for an invalid or forbidden environment.
 */
import { loadEnvironment } from '../lib/environment';

try {
  const e = loadEnvironment(process.argv[2] || 'lab', process.env.ORGIQ_ENV_DIR || undefined);
  for (const [k, v] of Object.entries({
    ENV_NAME: e.name, ENV_ACCOUNT: e.account, ENV_REGION: e.region, ENV_PREFIX: e.prefix, ENV_STACK_PREFIX: e.stackPrefix,
  })) console.log(`${k}=${v}`);
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(2);
}
