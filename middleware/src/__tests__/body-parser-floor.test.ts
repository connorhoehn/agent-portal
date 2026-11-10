// body-parser 2.0.0–2.3.0 hang on a compressed request body with trailing
// bytes (GHSA-27r3-jxmh-p828), before any auth runs: express.json() and
// express.raw() parse every body the middleware receives. Pin the floor on the
// lockfile (what `npm ci` installs) and on what this process actually loaded.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const atLeast = (version: string, floor: [number, number, number]): boolean => {
  const [a = 0, b = 0, c = 0] = version.split('.').map((n) => parseInt(n, 10));
  for (const [x, y] of [[a, floor[0]], [b, floor[1]], [c, floor[2]]] as const) {
    if (x !== y) return x > y;
  }
  return true;
};

describe('body-parser floor', () => {
  it('the lockfile resolves express 5\'s body-parser to 2.4.0 or later', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const version = lock.packages['node_modules/body-parser']?.version ?? '0.0.0';
    expect(atLeast(version, [2, 4, 0])).toBe(true);
  });

  it('express loads a patched body-parser', () => {
    const fromExpress = createRequire(require.resolve('express'));
    const pkg = JSON.parse(readFileSync(join(dirname(fromExpress.resolve('body-parser')), 'package.json'), 'utf8')) as { version: string };
    expect(atLeast(pkg.version, [2, 4, 0])).toBe(true);
  });
});
