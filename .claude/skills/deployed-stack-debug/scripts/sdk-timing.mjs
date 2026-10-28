// Preload (NODE_OPTIONS="--import <abs path>/sdk-timing.mjs"): log every AWS SDK call with its
// duration, and the middleware frames that asked for a directory read or an AVP decision.
// Run from middleware/ so @smithy/smithy-client resolves.
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const { Client } = require('@smithy/smithy-client');
const send = Client.prototype.send;
Client.prototype.send = async function (cmd, ...rest) {
  const t = Date.now();
  const stack = new Error().stack ?? '';
  try { return await send.call(this, cmd, ...rest); }
  finally {
    const ms = Date.now() - t;
    const what = String(cmd.input?.sql ?? cmd.input?.action?.actionId ?? cmd.input?.TableName ?? '').replace(/\s+/g, ' ').slice(0, 90);
    process.stderr.write(`[sdk] ${new Date().toISOString().slice(11, 23)} ${String(ms).padStart(5)}ms ${cmd.constructor.name} ${what}\n`);
    if (/SELECT u.id, u.display_name/.test(what) || cmd.constructor.name === 'IsAuthorizedCommand') {
      const frames = (stack.split('\n').filter(l => l.includes('/middleware/src/') && !l.includes('aurora.ts')).slice(0, 5).map(l => l.trim().replace(/.*middleware\/src\//, '').replace(/\)$/, '')));
      process.stderr.write(`[sdk-stack] ${frames.join(' <- ')}\n`);
    }
  }
};
