// The boot-time half of the stale-capability-id check (src/config.ts).
//
// Two ways this check could do harm, both offline and both asserted here:
// firing during `npm run dev:mock`, where none of these ids means anything and
// four other dev servers may be running; and telling an operator to edit a
// file the process is not actually reading.
//
// Why a subprocess. config.ts uses `import.meta.url` to locate .env.aws, and
// the jest tsconfig compiles to CommonJS — so ts-jest cannot transform it
// (TS1343) and no test in this repo imports it for real; they all mock it. A
// mocked config cannot answer "is this silent in dev:mock", which is the
// question that matters. So these run the module in a real Node ESM process,
// the same way the server does, and read back what it decided.
//
// What is NOT covered: the live AWS listing. That needs credentials. Its
// classification logic is covered offline in
// schema/test_reconcile_capabilities.py, and it is reached here only through
// providers/capability-reconcile.ts, which has its own mock-mode tests.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

/** Run a snippet in a real ESM process with config.ts loaded for real. */
function inRealProcess(snippet: string, env: Record<string, string> = {}) {
  return execFileSync(TSX, ['--eval', snippet], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      // Jest's own markers would trip the skip guard and mask everything.
      NODE_ENV: 'development',
      JEST_WORKER_ID: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
  });
}

const IMPORT = `import { capabilityCheckSkipReason, staleCapabilityLines } from './src/config.ts';`;

let probe: {
  skip: Record<string, string | null>;
  lines: Record<string, string[]>;
};

beforeAll(() => {
  const out = inRealProcess(`${IMPORT}
    const cfgd = { BROWSER_ID: 'orgiq_browser-abc' };
    const none = new Map();
    const shadowed = new Map([['MEMORY_ID', { shell: 'm-shell', file: 'm-file' }]]);
    const mk = (envVar, id) =>({ envVar, configuredId: id, detail: id + ' does not exist in this account.' });
    console.log(JSON.stringify({
      skip: {
        configured:   capabilityCheckSkipReason({ ...cfgd }),
        devOffline:   capabilityCheckSkipReason({ ...cfgd, DEV_OFFLINE: 'true' }),
        mockAgentcore:capabilityCheckSkipReason({ ...cfgd, MOCK_AGENTCORE: 'true' }),
        nodeEnvTest:  capabilityCheckSkipReason({ ...cfgd, NODE_ENV: 'test' }),
        jestWorker:   capabilityCheckSkipReason({ ...cfgd, JEST_WORKER_ID: '3' }),
        empty:        capabilityCheckSkipReason({}),
        blank:        capabilityCheckSkipReason({ BROWSER_ID: '', MEMORY_ID: '   ' }),
        switchedOff:  capabilityCheckSkipReason({ ...cfgd, CAPABILITY_STARTUP_CHECK: 'off' }),
      },
      lines: {
        clean:    staleCapabilityLines([], none),
        two:      staleCapabilityLines([mk('BROWSER_ID','orgiq_browser-DEAD'), mk('MEMORY_ID','orgiq_memory-DEAD')], none),
        browser:  staleCapabilityLines([mk('BROWSER_ID','orgiq_browser-DEAD')], none),
        allThree: staleCapabilityLines([mk('BROWSER_ID','b'), mk('BROWSER_PROFILE_ID','p'), mk('CODE_INTERPRETER_ID','c')], none),
        fromFile: staleCapabilityLines([mk('MEMORY_ID','m')], none),
        fromShell:staleCapabilityLines([mk('MEMORY_ID','m-shell')], shadowed),
      },
    }));
  `);
  probe = JSON.parse(out.trim().split('\n').at(-1)!);
}, 90_000);

describe('capabilityCheckSkipReason', () => {
  it('runs when capability ids are configured and nothing is mocked', () => {
    expect(probe.skip['configured']).toBeNull();
  });

  // The load-bearing case: `npm run dev:mock` sets both of these.
  it('is silent under dev:mock', () => {
    expect(probe.skip['devOffline']).toBe('offline');
    expect(probe.skip['mockAgentcore']).toBe('mock');
  });

  it('is silent under jest, by either signal', () => {
    expect(probe.skip['nodeEnvTest']).toBe('test');
    expect(probe.skip['jestWorker']).toBe('test');
  });

  it('is silent when nothing is configured — unset is not broken', () => {
    expect(probe.skip['empty']).toBe('unconfigured');
    expect(probe.skip['blank']).toBe('unconfigured');
  });

  it('can be switched off outright', () => {
    expect(probe.skip['switchedOff']).toBe('disabled');
  });
});

describe('staleCapabilityLines', () => {
  it('says nothing when nothing is stale', () => {
    expect(probe.lines['clean']).toEqual([]);
  });

  it('gives one line per dead id plus one fix line, not a paragraph', () => {
    const lines = probe.lines['two']!;
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
  });

  it('names the id and what its absence actually looks like', () => {
    const line = probe.lines['browser']![0]!;
    expect(line).toContain('BROWSER_ID=orgiq_browser-DEAD');
    // The reason this is worth logging at all: the symptom does not resemble
    // a configuration problem.
    expect(line).toContain('no JavaScript-only pages');
  });

  it('distinguishes the three symptoms rather than repeating one message', () => {
    const lines = probe.lines['allThree']!;
    expect(lines[0]).toContain('fails SOFT');
    expect(lines[1]).toContain('bare 500');
    expect(lines[2]).toContain('not found');
  });

  it('attributes a file-sourced id to the file', () => {
    expect(probe.lines['fromFile']![0]).toContain('from middleware/.env.aws');
  });

  // config.ts only fills vars that are `undefined`, so a shell export wins.
  // Reporting that id as if it came from the file would send the operator to
  // edit something the process never reads.
  it('attributes a shell-sourced id to the shell, and says the file edit will not help', () => {
    const lines = probe.lines['fromShell']!;
    expect(lines[0]).toContain('exported by your shell, overriding .env.aws');
    expect(lines.at(-1)).toContain('unset MEMORY_ID');
  });

  it('does not tell you to unset anything when nothing is shadowed', () => {
    expect(probe.lines['fromFile']!.at(-1)).not.toContain('unset');
    expect(probe.lines['fromFile']!.at(-1)).toContain('reconcile_capabilities --write');
  });
});

describe('loading config.ts in the offline modes', () => {
  // Not "does it warn" — does it *boot*. A diagnostic that can abort startup
  // is worse than the silence it replaces, and dev:mock is where it would
  // land, since every capability id there is meaningless.
  it('is completely silent, and exits 0, under dev:mock', () => {
    const out = inRealProcess(`import './src/config.ts'; console.log('BOOTED');`, {
      DEV_OFFLINE: 'true',
      MOCK_AGENTCORE: 'true',
      MOCK_AURORA: 'true',
      MOCK_GUARDRAILS: 'true',
      MOCK_CLOUDWATCH: 'true',
    });
    expect(out).toContain('BOOTED');
    expect(out).not.toContain('[capabilities]');
  }, 90_000);

  it('still boots with a deliberately bogus capability id and no credentials', () => {
    // The probe cannot reach AWS on this box; an unreachable service must
    // report nothing rather than crash the process or hang it open. If the
    // unref'd timer were wrong, this call would sit until the timeout.
    const out = inRealProcess(`import './src/config.ts'; console.log('BOOTED');`, {
      BROWSER_ID: 'orgiq_browser-DOES-NOT-EXIST',
      AWS_ACCESS_KEY_ID: 'AKIAINVALIDINVALID00',
      AWS_SECRET_ACCESS_KEY: 'invalid',
      AWS_SESSION_TOKEN: 'invalid',
    });
    expect(out).toContain('BOOTED');
  }, 90_000);
});
