import { BedrockAgentCoreControlClient, GetBrowserCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { config } from '../config.js';

/** Public browser crawls must not inherit an operator's VPC-connected browser. */
export async function requirePublicBrowser(): Promise<void> {
  if (config.mock?.agentcore) return; // The mock provider makes no browser network requests.
  const browserId = config.agentcore.browserId;
  if (!browserId) throw new Error('BROWSER_ID is required for public browser crawling');
  const client = new BedrockAgentCoreControlClient({ region: config.region });
  try {
    const browser = await client.send(new GetBrowserCommand({ browserId }), { abortSignal: AbortSignal.timeout(8_000) });
    if (browser.networkConfiguration?.networkMode !== 'PUBLIC') {
      throw new Error('Browser crawling requires an AWS PUBLIC network browser');
    }
  } finally {
    client.destroy();
  }
}
