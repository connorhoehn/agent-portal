// The library's `cursor()` feature, mounted on the BFF gateway (realtime-parity
// gap 4). Channel authority is NOT decided here: the router subscribes and
// publishes as `cursor:<channel>`, `baseChannel` strips the prefix, and the
// same live family rule that admits presence/chat on `assessment:doc:<id>`
// answers (an ephemeral service publishes under the family's READ authority,
// lib/tenant-channels.ts). A refusal is `AUTHZ_CHANNEL_DENIED`.
//
// Identity is the library's (0.114): `cursor({ resolveIdentity })` stamps the
// token's userId and display name, initials and a user-derived colour from the
// socket's auth context, and `metadataAllowlist: []` drops every other client
// key. What this file adds is the position: only numeric {x,y} in the canvas /
// freeform modes crosses, so nothing else a client typed rides the frame.

import { cursor, defineFeature, type RealtimeFeature } from '@connorhoehnslalom/realtime-modules/server';

const MODES = new Set(['freeform', 'canvas']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function tenantCursor(): RealtimeFeature {
  const feature = cursor({
    authorizeChannel: () => true,
    metadataAllowlist: [],
    resolveIdentity: ctx => {
      const userId = typeof ctx['userId'] === 'string' ? ctx['userId'] : '';
      if (!userId) return null;
      const name = typeof ctx['displayName'] === 'string' && ctx['displayName'] ? ctx['displayName'] : userId;
      return { userId, displayName: name };
    },
  });
  return defineFeature({ ...feature, create(context) {
    const service = feature.create(context);
    const handle = service.handleAction.bind(service);
    service.handleAction = async (clientId: string, action: string, data: Record<string, unknown>) => {
      if (action !== 'update') return handle(clientId, action, data);
      const position = data?.['position'] as Record<string, unknown> | undefined;
      const mode = typeof data?.['mode'] === 'string' && MODES.has(data['mode'] as string) ? data['mode'] as string : 'canvas';
      if (!position || !finite(position['x']) || !finite(position['y'])) {
        context.router.sendToClient(clientId, { type: 'error', service: 'cursor', error: 'A cursor update carries a numeric x and y' });
        return;
      }
      return handle(clientId, 'update', { channel: data['channel'], mode, position: { x: position['x'], y: position['y'] }, metadata: { mode } });
    };
    return service;
  } });
}
