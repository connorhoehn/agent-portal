import { createGatewayRest, type GatewayRest } from '@connorhoehnslalom/realtime-modules/client';
import type { RealtimeTokenSource } from './realtimeToken.ts';

/** The socket may outlive its handshake token. HTTP must use a fresh bearer
 * without reconnecting the live call or retaining an expired token in a closure. */
export function portalGatewayRest(url: string, tokens: RealtimeTokenSource,
  factory: typeof createGatewayRest = createGatewayRest): GatewayRest {
  const invoke = async <T>(run: (rest: GatewayRest) => Promise<T>): Promise<T> => {
    const request = async (force = false) => {
      const token = await tokens.get({ force });
      const rest = factory(url, token.token, '');
      if (!rest) throw new Error('The gateway HTTP endpoint is unavailable.');
      return run(rest);
    };
    try { return await request(); }
    catch (error) {
      // One credential refresh for an expired/revoked bearer. A real refusal
      // still reaches the caller; never retry 403 or weaken the server gate.
      if ((error as { status?: number })?.status !== 401) throw error;
      return request(true);
    }
  };
  return {
    listPins: channel => invoke(rest => rest.listPins!(channel)),
    pin: input => invoke(rest => rest.pin!(input)),
    unpin: (channel, messageId) => invoke(rest => rest.unpin!(channel, messageId)),
    getCapability: (name, channel) => invoke(rest => rest.getCapability!(name, channel)),
    getFeatureFlag: name => invoke(rest => rest.getFeatureFlag!(name)),
  };
}
