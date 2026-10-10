import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import { writeFile } from 'node:fs/promises';

test.use({ viewport: { width: 1440, height: 960 }, actionTimeout: 5_000, navigationTimeout: 15_000 });
const GROUP = '/iq/communication?group=initiative%3Ap-observability';

test('native Work initiative context synchronizes Communication footer and focuses the existing discussion composer', async ({ page }) => {
  const errors: string[] = [], forbiddenWrites: string[] = [], statuses: { path: string; status: number }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await signIn(page, 'u-eli', { expectTenant: 'orgiq', expectRole: 'sme' });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/social/plane') || url.pathname === '/api/me/groups' || url.pathname === '/api/session/me') statuses.push({ path: url.pathname, status: response.status() });
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && (/\/api\/(?:social\/(?:plane\/)?(?:channels|rooms|teams|dms)(?:\/|$)|calls(?:\/|$)|video\/sessions(?:\/|$))/.test(path))) forbiddenWrites.push(`${request.method()} ${path}`);
  });
  await page.goto(GROUP);
  const group = page.getByTestId('plane-group-pane'); await expect(group).toBeVisible();
  await expect(group).toContainText('Observability Platform');
  const footer = page.getByTestId('shell-footer-context');
  await expect(footer).toContainText('Observability Platform'); await expect(footer).not.toContainText('No huddle here');
  const input = page.getByTestId('scope-discussion-panel-composer').locator('[contenteditable="true"]');
  await expect(input).toBeVisible();
  await footer.getByRole('button', { name: 'Message', exact: true }).click(); await expect(input).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('native-initiative-footer-focus.png') });
  const channelsResponse = await page.request.get('/api/social/plane/channels');
  expect(channelsResponse.status()).toBe(200);
  const channels = (await channelsResponse.json()).channels as { slug: string; joined: boolean }[];
  const general = channels.find(channel => channel.slug === 'general');
  expect(general).toBeDefined();
  await page.goto('/iq/communication/channels/general');
  if (general?.joined) await expect(footer).toContainText('#general');
  else {
    await expect(page.getByTestId('social-channel-not-joined')).toBeVisible();
    await expect(footer).toContainText('No huddle here');
    await expect(footer.getByRole('button', { name: 'Huddle', exact: true })).toBeDisabled();
  }
  const groupsResponse = await page.request.get('/api/me/groups?kind=initiative');
  expect(groupsResponse.status()).toBe(200);
  const costGroup = (await groupsResponse.json()).items.find((group: { name: string }) => group.name === 'Cost Optimization') as { id: string } | undefined;
  expect(costGroup).toBeDefined();
  await page.goto(`/iq/communication?group=${encodeURIComponent(`initiative:${costGroup!.id}`)}`);
  await expect(footer).toContainText('Cost Optimization');
  await page.goto(GROUP); await expect(footer).toContainText('Observability Platform');
  await page.goto('/iq/communication/calls'); await expect(footer).toContainText('No huddle here');
  expect(errors).toEqual([]); expect(forbiddenWrites).toEqual([]);
  const proof = { scope: 'Real Eli home Work SME session; current native group/thread/footer reads; only Message focus and navigation, no messages or calls', generalJoined: general?.joined, statuses, errors, forbiddenWrites };
  await writeFile(test.info().outputPath('native-communication-proof.json'), JSON.stringify(proof, null, 2));
});

test('fixture list outages retain successful sources and group context, expose scoped retries, and recover', async ({ page }) => {
  await page.goto('/'); await signIn(page, 'u-eli', { expectTenant: 'orgiq', expectRole: 'sme' });
  let failed = true;
  const reads = ['channels', 'teams', 'rooms'];
  for (const source of reads) await page.route(`**/api/social/plane/${source}`, async route => {
    if (failed) return route.fulfill({ status: 503, json: { error: `${source} upstream is temporarily unavailable` } });
    return route.continue();
  });
  await page.goto(GROUP);
  const rail = page.getByTestId('social-chat-rail');
  await expect(page.getByTestId('plane-group-pane')).toBeVisible();
  await expect(page.getByTestId('shell-footer-context')).toContainText('Observability Platform');
  const channelsStatus = page.getByTestId('social-channels-read-status');
  await expect(channelsStatus).toHaveAttribute('data-read-state', 'unavailable');
  await expect(rail).not.toContainText('No conversations yet');
  const teamsHeading = rail.getByRole('button', { name: /^Teams\b/ }).first();
  if (await teamsHeading.getAttribute('aria-expanded') === 'false') await teamsHeading.click();
  await expect(page.getByTestId('social-teams-read-status')).toBeVisible();
  const roomsHeading = rail.getByRole('button', { name: /^Rooms\b/ }).first();
  if (await roomsHeading.getAttribute('aria-expanded') === 'false') await roomsHeading.click();
  await expect(page.getByTestId('hangout-rooms-error')).toBeVisible();
  await expect(rail.getByText('No rooms yet', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('fixture-source-outages-retain-group.png') });
  failed = false;
  await page.getByRole('button', { name: 'Retry channels', exact: true }).click();
  await expect(channelsStatus).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry teams', exact: true }).click();
  await expect(page.getByTestId('social-teams-read-status')).toHaveCount(0);
  await page.getByTestId('hangout-rooms-error').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('hangout-rooms-error')).toHaveCount(0);
  await expect(page.getByTestId('shell-footer-context')).toContainText('Observability Platform');
  expect((await (await page.request.get('/api/session/me')).json()).sub).toBe('u-eli');
  await page.screenshot({ path: test.info().outputPath('fixture-source-recovery.png') });
});
