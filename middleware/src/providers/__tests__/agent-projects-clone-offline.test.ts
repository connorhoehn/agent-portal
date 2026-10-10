// `buildCloneCommand` for a private repository, offline.
//
// Every seeded initiative repository is private and carries the GitHub
// connection (schema/seeds/generate_program_seed.py GH_CONNECTION). The live
// path borrows that connection's token; `borrowApiKey` THROWS under
// MOCK_AGENTCORE by design. So without the mock branch, every offline dispatch
// died at ensureWorkspace (lib/bot-runner.ts) the moment the seed stopped
// claiming the repos were public — the regression this file pins.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));
jest.mock('../connected-sources.js', () => ({
  borrowApiKey: jest.fn(async () => { throw new Error('vault reached with config.mock.agentcore on'); }),
}));

import { buildCloneCommand } from '../agent-projects.js';
import { borrowApiKey } from '../connected-sources.js';
import { agentProjects } from '../../mock/agent-projects.js';
import { fixtureRegistry } from '../../mock/core/index.js';

afterEach(() => { fixtureRegistry.resetAll('default'); });

describe('buildCloneCommand, offline', () => {
  it('seeds every initiative repository as private, behind the GitHub connection', () => {
    const rows = agentProjects.rows();
    expect(rows).toHaveLength(14);
    for (const p of rows) expect(p.connectionName).toBe('orgiq-github-connorhoehnslalom');
  });

  it('builds the credentialed clone without asking the vault', async () => {
    const project = agentProjects.rows().find((p) => p.orgProjectId === 'p-auth-migration')!;
    const { command, redacted } = await buildCloneCommand(project);
    expect(borrowApiKey).not.toHaveBeenCalled();
    expect(command).toContain('git clone --depth 50 https://github.com/connorhoehnslalom/orgiq-auth-service.git');
    // Same shape as the live credentialed branch: the origin is reset to the
    // bare URL after the clone, and nothing token-shaped is in either string.
    expect(command).toContain('remote set-url origin https://github.com/connorhoehnslalom/orgiq-auth-service.git');
    expect(command).not.toContain('x-access-token');
    expect(redacted).toBe(`git clone --depth 50 https://github.com/connorhoehnslalom/orgiq-auth-service.git ${command.match(/orgiq-auth-service\.git (\S+)/)![1]}`);
  });
});
