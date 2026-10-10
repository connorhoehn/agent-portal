jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
import { selectMockResponse } from '../responses.js';
import '../work-items.js';
describe('Observability demo answers', () => {
  it('keeps scoped dependency questions on the actual work items', () => {
    const result = selectMockResponse('Find the dependency issue in Observability Platform. Use authenticated access.');
    expect(result.response).toContain('ORG-OBS-11');
    expect(result.response).toContain('Waiting on the dependency map');
    expect(result.response).not.toContain('Auth Middleware');
    expect(result.toolCalls).toEqual([]);
  });
  it('does not mistake author or authenticated for an auth question', () => {
    expect(selectMockResponse('What did the author say?').response).not.toContain('Auth Middleware');
    expect(selectMockResponse('authenticated access').response).not.toContain('Auth Middleware');
    expect(selectMockResponse('Find authentication migration decisions').response).toContain('Auth Middleware');
  });
});
