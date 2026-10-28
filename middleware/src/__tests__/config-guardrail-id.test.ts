// config.guardrail.id — the one guardrail the editor, the metrics route and the
// capability readout target. The deployed BFF sets only GUARDRAIL_ID_MEMBER /
// _ORG_LEADER / _HR_ADMIN, so a bare env('GUARDRAIL_ID') was '' in the cloud and
// every call went to Bedrock with an empty identifier (DE-12). Subprocess for
// the reason config-realtime-endpoints.test.ts gives: config.ts uses import.meta.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

function guardrailConfig(env: Record<string, string>): { id: string; byRole: Record<string, string> } {
  const out = execFileSync(TSX, ['--eval', `import { config } from './src/config.ts';
    console.log(JSON.stringify(config.guardrail));`], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], DEV_OFFLINE: 'true', CAPABILITY_STARTUP_CHECK: 'off', ...env } as NodeJS.ProcessEnv,
  });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

describe('config.guardrail.id', () => {
  it('falls back to the member guardrail when only the per-role ids are set (the deployed shape)', () => {
    const g = guardrailConfig({ GUARDRAIL_ID_MEMBER: 'gr-member', GUARDRAIL_ID_ORG_LEADER: 'gr-leader', GUARDRAIL_ID_HR_ADMIN: 'gr-hr' });
    expect(g.id).toBe('gr-member');
    expect(g.byRole).toEqual({ member: 'gr-member', 'org-leader': 'gr-leader', 'hr-admin': 'gr-hr' });
  });

  it('an explicit GUARDRAIL_ID still wins, and nothing set stays empty', () => {
    expect(guardrailConfig({ GUARDRAIL_ID: 'gr-one', GUARDRAIL_ID_MEMBER: 'gr-member' }).id).toBe('gr-one');
    expect(guardrailConfig({}).id).toBe('');
  });
});
