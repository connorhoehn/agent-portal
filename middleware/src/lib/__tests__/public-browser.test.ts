const send = jest.fn();
const destroy = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class { send = send; destroy = destroy; },
  GetBrowserCommand: class { constructor(readonly input: unknown) {} },
}));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { agentcore: false }, agentcore: { browserId: 'configured-browser' } } }));
import { config } from '../../config.js';
import { requirePublicBrowser } from '../public-browser.js';
const testConfig = config as unknown as { mock: { agentcore: boolean }; agentcore: { browserId: string } };
beforeEach(() => { jest.clearAllMocks(); testConfig.mock.agentcore = false; testConfig.agentcore.browserId = 'configured-browser'; });
it('checks the actual configured browser and accepts only PUBLIC networking', async () => {
  send.mockResolvedValue({ networkConfiguration: { networkMode: 'PUBLIC' } });
  await requirePublicBrowser();
  expect(send.mock.calls[0][0].input).toEqual({ browserId: 'configured-browser' });
  expect(destroy).toHaveBeenCalled();
});
it.each(['VPC', 'SANDBOX', undefined])('fails closed for network mode %s', async networkMode => {
  send.mockResolvedValue({ networkConfiguration: { networkMode } });
  await expect(requirePublicBrowser()).rejects.toThrow('PUBLIC');
});
it('fails closed when the control plane lookup fails', async () => {
  send.mockRejectedValue(new Error('access denied'));
  await expect(requirePublicBrowser()).rejects.toThrow('access denied');
});
it('fails closed without a configured browser', async () => {
  testConfig.agentcore.browserId = '';
  await expect(requirePublicBrowser()).rejects.toThrow('BROWSER_ID');
  expect(send).not.toHaveBeenCalled();
});
it('does not contact AWS for the explicitly mocked provider', async () => {
  testConfig.mock.agentcore = true;
  await requirePublicBrowser();
  expect(send).not.toHaveBeenCalled();
});
