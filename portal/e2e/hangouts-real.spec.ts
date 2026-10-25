import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { openAsClone } from './realSession';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import auditAdapter from './ui-dom-audit.adapter';
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });
async function recordPeers(context: BrowserContext) {
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    (window as any).__hangoutPCs = peers;
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(Target, args) { const pc = Reflect.construct(Target, args); peers.push(pc); return pc; } });
  });
}
async function inbound(page: Page) {
  return page.evaluate(async () => {
    let audio = 0, video = 0;
    for (const pc of (window as any).__hangoutPCs ?? []) {
      if(pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((r: any) => { if(r.type==='inbound-rtp' && !r.isRemote) { if((r.kind??r.mediaType)==='audio')audio+=r.totalSamplesReceived??0;else video+=r.framesDecoded??0; } });
    }
    return { audio, video };
  });
}
async function leaveCall(page: Page) {
  const tab = page.getByRole('tab', { name: 'Call', exact: true });
  if (await tab.isVisible().catch(() => false)) await tab.click();
  const leave = page.getByTestId('call-dock-leave');
  if (!await leave.isVisible().catch(() => false)) return;
  await leave.click();
  const confirm = page.getByTestId('call-dock-leave-confirm-leave');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}
test('saved hangout layout persists and temporary rooms move real media without changing the saved plan', async ({ browser }) => {
  test.setTimeout(240000);
  const out = test.info().outputPath('hangouts');
  await fs.mkdir(out, { recursive: true });
  const opts = { baseURL: 'http://127.0.0.1:5183', label:'hangout-layout-proof', viewport:{width:1440,height:960}, landing:null, preJoin:'remembered' as const, contextOptions:{permissions:['camera','microphone']}, prepare:recordPeers };
  const owner = await openAsClone(browser,'u-mira',{...opts,tenant:'social',role:'community-admin'});
  const guest = await openAsClone(browser,'u-sana',{...opts,tenant:'social',role:'participant'});
  let slug:string|null=null;
  const entries:Array<{user:string;lobby:string;status:number}>=[];
  for(const person of [owner,guest]) person.page.on('response',r=>{if(r.request().method()==='POST' && new URL(r.url()).pathname==='/api/video/sessions')entries.push({user:person.cloneId,lobby:r.request().postDataJSON().lobbyName,status:r.status()});});
  try {
    const auditSkill = process.env.UI_DOM_AUDIT_SKILL;
    const audit = auditSkill ? await import(pathToFileURL(`${auditSkill}/scripts/run.mjs`).href) : null;
    const measured: Array<{ state: string; width: number; theme: string; issues: unknown[] }> = [];
    const measure = async (state: string, conversation = false) => {
      if (!audit) return;
      await owner.page.mouse.move(1, 1);
      await owner.page.waitForLoadState('networkidle');
      for (const width of [1440, 900]) {
        await owner.page.setViewportSize({ width, height: 960 });
        for (const theme of ['light', 'dark']) {
          await auditAdapter.theme(owner.page, theme);
          const result = await audit.measureCase(owner.page, { contract: audit.loadContract(), selectors: auditAdapter.selectors,
            required: ['$header', '$footer'], composerExpectation: conversation ? { mode: 'required' }
              : { mode: 'exempt', reason: 'Hangout call, activity or configuration; conversation has its own tab.' } });
          measured.push({ state, width, theme, route: new URL(owner.page.url()).pathname, ...result });
          await fs.writeFile(`${out}/audit.json`, JSON.stringify(measured, null, 2));
          await owner.page.screenshot({ path: `${out}/audit-${state}-${theme}-${width}.png`, fullPage: true });
        }
      }
      await owner.page.setViewportSize({ width: 1440, height: 960 });
      await auditAdapter.theme(owner.page, 'light');
    };
    await owner.page.goto('/social/rooms');
    await owner.page.addStyleTag({ content: '*,*::before,*::after { transition-duration: 0s !important; }' });
    await owner.page.getByTestId('social-directory-new-room').click();
    const name=`Hangout verification ${crypto.randomUUID().slice(0, 8)}`;
    await owner.page.getByTestId('new-hangout-room-name').fill(name);
    await owner.page.getByTestId('new-hangout-room-description').fill('Disposable live verification of saved layout and temporary breakouts.');
    const created=owner.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/social/rooms');
    await owner.page.getByTestId('new-hangout-room-submit').click();
    const creation=await created;expect(creation.status()).toBe(201);slug=(await creation.json()).room.slug;
    await owner.page.getByRole('tab', { name: 'Activity', exact: true }).click();
    // Repeated configuration must not leave orphaned activity sections behind.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(owner.page.getByTestId('hangout-activity')).toHaveCount(1);
      await owner.page.getByRole('button',{name:'Configure hangout',exact:true}).click();
      await owner.page.getByRole('dialog',{name:'Configure hangout'}).getByRole('button',{name:'Cancel',exact:true}).click();
      await expect(owner.page.getByTestId('hangout-activity')).toHaveCount(1);
    }
    await owner.page.getByRole('button',{name:'Configure hangout',exact:true}).click();
    const modal=owner.page.getByRole('dialog',{name:'Configure hangout'});
    await measure('settings');
    await modal.getByRole('combobox',{name:'Join with',exact:true}).click();
    await owner.page.getByRole('option',{name:'Microphones only; cameras off',exact:true}).click();
    const configured = owner.page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/social/rooms/${slug}`);
    await modal.getByRole('button',{name:'Save configuration',exact:true}).click();
    expect((await configured).status()).toBe(200);
    await owner.page.getByRole('tab', { name: 'Rooms', exact: true }).click();
    await owner.page.getByRole('button', { name: 'Edit saved layout', exact: true }).click();
    await owner.page.getByRole('button',{name:'Add room',exact:true}).click();
    const editor = owner.page.getByRole('dialog', { name: 'Edit room', exact: true });
    await editor.getByRole('textbox',{name:'Room name',exact:true}).fill('Design');
    const people=(await (await owner.context.request.get('/api/social/people')).json()).people;
    const guestName=people.find((p:any)=>p.userId==='u-sana').displayName;
    const picker=editor.getByRole('combobox',{name:'Assigned people',exact:true});
    await picker.fill(guestName);
    await owner.page.getByRole('option',{name:guestName,exact:true}).click();
    await measure('room-editor');
    await editor.getByRole('button', { name: 'Done', exact: true }).click();
    await owner.page.getByRole('button',{name:'Add room',exact:true}).click();
    await editor.getByRole('textbox',{name:'Room name',exact:true}).fill('Engineering');
    await editor.getByRole('button', { name: 'Done', exact: true }).click();
    await measure('saved-layout');
    await owner.page.screenshot({path:`${out}/configuration.png`,fullPage:true});
    const saved=owner.page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/social/rooms/${slug}`);
    await owner.page.getByRole('button',{name:'Save layout',exact:true}).click();
    const save=await saved;expect(save.status(),await save.text()).toBe(200);
    // Clone identities deliberately stay out of the user directory. The UI assigned
    // the seed; bind this disposable plan to its isolated clone through the same API.
    const visiblePlan=(await save.json()).room.plan;
    const rebound=await owner.context.request.patch(`/api/social/rooms/${slug}`,{data:{plan:{...visiblePlan,expectedVersion:visiblePlan.version,rooms:visiblePlan.rooms.map((r:any)=>({...r,members:r.members.map((id:string)=>id==='u-sana'?guest.cloneId:id)}))}}});
    expect(rebound.ok(),await rebound.text()).toBe(true);
    const persisted=(await (await owner.context.request.get(`/api/social/rooms/${slug}`)).json()).room;
    expect(persisted.plan.rooms).toHaveLength(2);expect(persisted.plan.rooms[0].members).toEqual([guest.cloneId]);expect(persisted.settings.audioOnly).toBe(true);
    await owner.page.reload();await expect(owner.page.getByTestId('hangout-saved-rooms')).toContainText('Engineering');
    // Reload replaces the document (and the prior style tag). Disable motion
    // before switching themes so contrast is measured after the color change.
    await owner.page.addStyleTag({ content: '*,*::before,*::after { transition-duration: 0s !important; }' });
    await guest.page.goto(`/social/rooms?room=${slug}`);
    await expect(guest.page.getByRole('button',{name:'Configure hangout',exact:true})).toHaveCount(0);
    await expect(owner.page.getByTestId('social-room-join')).toBeEnabled({timeout:20000});
    await owner.page.getByTestId('social-room-join').click();
    await expect(owner.page.getByTestId('call-dock-leave')).toBeVisible({timeout:20000});
    await guest.page.getByTestId('social-room-join').click();
    await expect(guest.page.getByTestId('hangout-call-stage')).toContainText('2 connected',{timeout:30000});
    await expect.poll(async()=> (await inbound(guest.page)).audio,{timeout:30000}).toBeGreaterThan(0);
    expect((await inbound(guest.page)).video).toBe(0);
    // The dedicated call page owns the one media sink even with chat open.
    const stage = owner.page.getByTestId('hangout-call-stage');
    await expect(stage.getByTestId('shell-call-media')).toHaveAttribute('data-placement', 'stage');
    await expect(stage.getByTestId('social-call-dock')).toHaveAttribute('data-layout', 'stage');
    await expect(owner.page.getByTestId('shell-call-media')).toHaveCount(1);
    await expect(owner.page.getByTestId('shell-call-dock-media')).toHaveCount(0);
    for (const width of [1440, 900]) {
      await owner.page.setViewportSize({ width, height: 960 });
      if (width === 900) {
        await expect(owner.page.getByTestId('huddle-chat-panel')).toHaveCount(0);
        await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeGreaterThan(400);
      }
      for (const theme of ['light', 'dark']) {
        await auditAdapter.theme(owner.page, theme);
        await owner.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        await expect(stage.getByTestId('call-dock-mic')).toBeVisible();
        await expect(stage.getByTestId('call-dock-camera')).toBeVisible();
        await expect(stage.getByTestId('call-dock-leave')).toBeVisible();
        await expect(owner.page.getByTestId('hangout-activity')).toHaveCount(0);
        const geometry = await stage.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return { width: innerWidth, bounds: { left: bounds.left, right: bounds.right },
            controls: [...element.querySelectorAll('[data-testid="social-call-dock-controls"] button')].map(control => {
              const r = control.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width };
            }).filter(r => r.width > 0) };
        });
        expect(geometry.controls.length).toBeGreaterThan(0);
        for (const control of geometry.controls) {
          expect(control.left).toBeGreaterThanOrEqual(geometry.bounds.left - 1);
          expect(control.right).toBeLessThanOrEqual(Math.min(geometry.bounds.right, geometry.width) + 1);
        }
        await owner.page.screenshot({ path: `${out}/stage-${theme}-${width}.png`, fullPage: true });
      }
    }
    await owner.page.setViewportSize({ width: 1440, height: 960 });
    await auditAdapter.theme(owner.page, 'light');
    await measure('call');
    await owner.page.getByRole('button',{name:'Configure hangout',exact:true}).click();
    await owner.page.getByRole('dialog',{name:'Configure hangout'}).getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(owner.page.getByTestId('hangout-activity')).toHaveCount(0);
    await expect(stage.getByTestId('shell-call-media')).toHaveCount(1);
    await expect(owner.page.getByTestId('huddle-chat-panel')).toHaveCount(0);
    await owner.page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(owner.page.getByTestId('huddle-thread')).toBeVisible();
    await expect(owner.page.getByTestId('huddle-chat-panel')).toHaveCount(0);
    await expect(owner.page.getByTestId('shell-call-media')).toBeHidden();
    await expect(owner.page.getByTestId('shell-call-dock-media')).toHaveCount(0);
    await measure('conversation', true);
    await owner.page.screenshot({ path: `${out}/room-conversation.png`, fullPage: true });
    await owner.page.getByRole('tab', { name: 'Rooms', exact: true }).click();
    await owner.page.getByRole('tab', { name: 'This call', exact: true }).click();
    await owner.page.getByRole('button',{name:'Use saved rooms in this call',exact:true}).click();
    const live=owner.page.getByTestId('hangout-live-rooms');
    await expect(live.getByTestId('breakout-room')).toHaveCount(2,{timeout:15000});
    await live.getByTestId('breakout-open-all').click();
    await expect.poll(()=>entries.some(e=>e.user===guest.cloneId&&e.lobby===`social:room:${slug}~breakout~${persisted.plan.rooms[0].id}`&&e.status<300),{timeout:30000}).toBe(true);
    await live.locator(`[data-testid="breakout-room"][data-room-id="${persisted.plan.rooms[0].id}"]`).getByTestId('breakout-room-join').click();
    await expect.poll(async()=> (await inbound(guest.page)).audio,{timeout:30000}).toBeGreaterThan(0);
    await live.getByTestId('breakout-add-room').click();
    await expect(live.getByTestId('breakout-room')).toHaveCount(3,{timeout:15000});
    expect((await (await owner.context.request.get(`/api/social/rooms/${slug}`)).json()).room.plan).toEqual(persisted.plan);
    await measure('live-rooms');
    await owner.page.screenshot({path:`${out}/live-rooms.png`,fullPage:true});
    await live.getByTestId('breakout-end').click();
    await expect.poll(()=>entries.filter(e=>e.user===guest.cloneId&&e.lobby===`social:room:${slug}`&&e.status<300).length,{timeout:30000}).toBeGreaterThan(1);
    await leaveCall(guest.page);await leaveCall(owner.page);
    await expect.poll(async()=> (await (await owner.context.request.get(`/api/social/rooms/${slug}/activity`)).json()).sessions?.some((s:any)=>s.people.some((p:any)=>p.userId===guest.cloneId)),{timeout:15000}).toBe(true);
    await owner.page.getByRole('tab', { name: 'Rooms', exact: true }).click();
    await owner.page.reload();await expect(owner.page.getByTestId('hangout-saved-rooms')).toContainText('Engineering');
    await owner.page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(owner.page.getByTestId('hangout-activity')).toHaveCount(1);
    await expect(owner.page.getByTestId('hangout-activity')).toContainText('participated');
    await measure('activity');
    await owner.page.screenshot({path:`${out}/activity.png`,fullPage:true});
    await fs.writeFile(`${out}/proof.json`,JSON.stringify({savedLayout:true,assignedBeforeCall:true,cloneAssignmentSetupViaAPI:true,audioOnlyJoin:true,realInboundAudio:true,temporaryRoomDoesNotChangeSavedLayout:true,breakoutMoves:entries,attendanceRecorded:true,persistedPlan:persisted.plan},null,2));
    expect([...owner.errors,...guest.errors]).toEqual([]);
    expect(measured.filter(result => result.issues.length).map(({ state, width, theme, issues }) => ({ state, width, theme, issues })),
      'Every captured UI state must be stable and pass its contracts').toEqual([]);
  } finally {
    for(const person of [guest,owner]) await leaveCall(person.page).catch(()=>{});
    try {
      if(slug) { const t=await (await owner.context.request.get('/api/session/realtime-token')).json();const r=await owner.context.request.post(`${t.platformApiUrl}/api/rooms/${encodeURIComponent(slug)}/archive`,{headers:{Authorization:`Bearer ${t.token}`}}).catch(() => { throw new Error('Could not archive the verification hangout'); });expect(r.ok()).toBe(true); }
    } finally { await guest.close();await owner.close(); }
  }
});
