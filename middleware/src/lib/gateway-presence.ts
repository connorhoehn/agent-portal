// The library's `presence()` feature, mounted on the BFF gateway, with the
// status line bounded where it is written.
//
// A person's status line (`metadata.statusMessage`, set from Social's profile
// page or the voice navigator's set_status) is shown to every peer on the
// footer and read to their voice navigator. The 120-character cap used to be
// the client's (portal profileModel.ts STATUS_MESSAGE_MAX) and the library
// only bounds the whole metadata object (4 KB), so a hand-made frame could
// store and fan out a longer or multi-line one. Every `set` now passes through
// here: the line is made one line without control characters and cut to
// STATUS_MESSAGE_MAX; anything that is not a string is dropped.

import { defineFeature, type RealtimeFeature } from '@connorhoehn/realtime-modules/server';

/** The longest status line a presence entry keeps (portal profileModel.ts STATUS_MESSAGE_MAX). */
export const STATUS_MESSAGE_MAX = 120;

/** The status line as stored: one line, no control characters, at most STATUS_MESSAGE_MAX; null clears it. */
export function boundStatusMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return line ? [...line].slice(0, STATUS_MESSAGE_MAX).join('') : null;
}

export function boundedPresence(feature: RealtimeFeature): RealtimeFeature {
  return defineFeature({ ...feature, create(context) {
    const service = feature.create(context);
    const handle = service.handleAction.bind(service);
    service.handleAction = async (clientId: string, action: string, data: Record<string, unknown>) => {
      const metadata = data?.['metadata'];
      if (action !== 'set' || !metadata || typeof metadata !== 'object' || !('statusMessage' in metadata)) {
        return handle(clientId, action, data);
      }
      const bounded = boundStatusMessage((metadata as Record<string, unknown>)['statusMessage']);
      return handle(clientId, action, { ...data, metadata: { ...(metadata as Record<string, unknown>), statusMessage: bounded } });
    };
    return service;
  } });
}
