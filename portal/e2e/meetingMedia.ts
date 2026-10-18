import type { BrowserContext } from '@playwright/test';

const FAKE_PLATFORM = 'http://meeting-media.test';

/** Media is signalling-only: one shared fake session, every join answered. */
export async function fakeMeetingMedia(context: BrowserContext, label: string) {
  await context.route('**/api/session/realtime-token', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, platformApiUrl: FAKE_PLATFORM, videoUrl: null } });
  });
  await context.route(`${FAKE_PLATFORM}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: 200, json: path.endsWith('/join') ? { participantId: `participant-${label}`, token: null }
      : path.endsWith('/end') ? { ok: true } : { sessionId: 'meeting-signalling-only' } });
  });
}
