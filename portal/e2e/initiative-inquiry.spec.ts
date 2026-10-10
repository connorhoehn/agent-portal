import {test,expect} from './cdpTest';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
test.use({baseURL:'http://localhost:5183',viewport:{width:1440,height:900}});

async function recordProof(page: Page, apiWrites: string[], errors: string[], observations?:unknown) {
  const body=JSON.stringify({proof:await page.evaluate(()=>(window as any).__initiativeInquiry.proof),apiWrites,errors,observations,
    scope:'Actual InitiativeComposer and native shared editor; explicit in-memory authority, chat, comment and call fixture. No real message, notification, invitation, reset, job, or role/grant change.'},null,2);
  await writeFile(test.info().outputPath('fixture-proof.json'),body);
  await test.info().attach('fixture-proof',{body,contentType:'application/json'});
}

async function mountFixture(page: Page, delayedRuntime=false) {
  const apiWrites:string[]=[],errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>{if(route.request().method()!=='GET'){apiWrites.push(route.request().url());return route.fulfill({status:409,body:'Fixture forbids native writes'});}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(route.request().url().includes('/people/shared')?{tenant:'orgiq',me:{userId:'fixture-actor',displayName:'Fixture Actor'},lobby:'orgiq:lobby',dmPrefix:'orgiq:dm:',people:[{userId:'caleb',displayName:'Caleb Turner'},{userId:'nora',displayName:'Nora DaSilva'}]}:{})});});
  const source=(path:string)=>`**/src/${path}*`;
  await page.route(source('lib/auth.tsx'),route=>route.fulfill({contentType:'application/javascript',body:`export function useSession(){return{session:window.__initiativeInquiry?.session??null};} export function SessionProvider({children}){return children;}`}));
  await page.route(source('lib/capabilities.tsx'),route=>route.fulfill({contentType:'application/javascript',body:`export function useCapabilities(){return{can:()=>true};}`}));
  await page.route(source('components/shell/EmbeddedSocial.tsx'),route=>route.fulfill({contentType:'application/javascript',body:`export function useEmbeddedSocial(){return window.__initiativeInquiry?.social??null;}`}));
  await page.route(source('components/shell/HuddleChat.tsx'),route=>route.fulfill({contentType:'application/javascript',body:`export function useHuddleChat(){return window.__initiativeInquiry?.huddle??null;}`}));
  await page.route(source('lib/conversationCall.tsx'),route=>route.fulfill({contentType:'application/javascript',body:`export function useCallHost(){return window.__initiativeInquiry?.host??null;} export function CallBlock(){return null;} export function callDrawn(){return false;}`}));
  await page.route(source('pages/projects/initiativeComment.ts'),route=>route.fulfill({contentType:'application/javascript',body:`export async function postInitiativeComment(...args){const fixture=window.__initiativeInquiry;fixture.proof.comments.push(args);await new Promise(resolve=>fixture.commentWaiters.push(resolve));}`}));
  await page.route('**/__initiative-inquiry*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/initiative-inquiry.tsx"></script></body></html>`}));
  await page.goto(`/__initiative-inquiry${delayedRuntime?'?delayedRuntime=1':''}`);return{apiWrites,errors};
}

test('initiative inquiry keeps destination drafts and uses confirmed chat or explicit native invitation only',async({page})=>{
  test.setTimeout(60000);const {apiWrites,errors}=await mountFixture(page);const composer=page.getByTestId('inquiry-composer'),input=()=>composer.getByTestId('rich-chat-composer-input');
  await expect(input()).toBeVisible();await input().fill('@Caleb Turner lets chat');
  await expect(composer.getByTestId('initiative-mentioned-person-actions')).toContainText('mentions this conversation');
  await page.getByRole('button',{name:'Join fixture huddle',exact:true}).click();await expect(input()).toContainText('@Caleb Turner lets chat');
  await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Initiative discussion');
  await composer.getByRole('button',{name:'Huddle chat',exact:true}).click();await expect(input()).toBeEmpty();
  await input().fill('Unsent huddle text');await composer.getByLabel('Chat recipient').selectOption('discussion');await expect(input()).toContainText('@Caleb Turner lets chat');
  await composer.getByTestId('rich-chat-composer-send').click();await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Confirming message');
  // Native input is locked while a send is pending. Exercise a later host /
  // programmatic edit through Tiptap's existing public DOM editor binding.
  await input().evaluate(element=>(element as HTMLElement & {editor:{commands:{setContent(html:string):void}}}).editor.commands.setContent('<p>Newer draft survives confirmation</p>'));
  await page.getByRole('button',{name:'Confirm fixture receipt',exact:true}).click();
  await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Message saved to Initiative discussion');await expect(input()).toContainText('Newer draft survives confirmation');
  const confirmed=await page.evaluate(()=>(window as any).__initiativeInquiry.proof.sends);expect(confirmed).toHaveLength(1);expect(confirmed[0].text).toBe('@Caleb Turner lets chat');
  await page.reload();await expect(input()).toContainText('Newer draft survives confirmation');
  await input().fill('@Caleb Turner private question');await composer.getByRole('button',{name:'Inquire privately',exact:true}).click();
  await expect(input()).toContainText('@Caleb Turner private question');await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Caleb Turner');
  await expect(composer.getByRole('button',{name:'Shared work with Caleb Turner',exact:true})).toBeVisible();
  const before=await page.evaluate(()=>(window as any).__initiativeInquiry.proof);expect(before.dms).toEqual([]);
  await page.reload();await expect(input()).toContainText('@Caleb Turner private question');await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Caleb Turner');
  await page.getByRole('button',{name:'Switch fixture actor',exact:true}).click();await expect(input()).toBeEmpty();await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Initiative discussion');
  await input().fill('Other actor draft');await page.getByRole('button',{name:'Switch fixture actor',exact:true}).click();await expect(input()).toContainText('@Caleb Turner private question');await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Caleb Turner');
  await page.getByRole('button',{name:'Join fixture huddle',exact:true}).click();await input().fill('/invite @Caleb Turner');
  await composer.getByTestId('rich-chat-composer-send').click();await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Invitation requested for Caleb Turner');
  await page.getByRole('button',{name:'Reject fixture invitation',exact:true}).click();await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Invitation to Caleb Turner failed: Fixture invitation denied');
  await page.getByRole('button',{name:'Accept fixture invitation',exact:true}).click();await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Caleb Turner accepted the invitation');await expect(composer.getByTestId('initiative-chat-receipt')).not.toContainText('joined');
  await input().fill('Existing private inquiry');await composer.getByRole('button',{name:'Huddle chat',exact:true}).click();await input().fill('/inquire @Caleb Turner can we review this work?');
  await composer.getByTestId('rich-chat-composer-send').click();await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Caleb Turner');
  await expect(input()).toContainText('Existing private inquiry');await expect(composer.getByTestId('initiative-inquiry-handoff')).toContainText('can we review this work?');
  await composer.getByRole('button',{name:'Add to inquiry',exact:true}).click();await expect(input()).toContainText('Existing private inquiry');await expect(input()).toContainText('can we review this work?');
  const proof=await page.evaluate(()=>(window as any).__initiativeInquiry.proof);
  expect(proof.invitations).toEqual([[{userId:'caleb',displayName:'Caleb Turner'}]]);expect(proof.dms).toEqual([]);expect(proof.huddleSends).toEqual([]);expect(proof.sends).toEqual([]);
  expect(apiWrites).toEqual([]);expect(errors).toEqual([]);await page.screenshot({path:test.info().outputPath('initiative-inquiry.png')});
  await recordProof(page,apiWrites,errors);
});

test('an Agent draft typed before the discussion mounts keeps its signed actor identity and saved text',async({page})=>{
  const {apiWrites,errors}=await mountFixture(page,true);const composer=page.getByTestId('inquiry-composer'),input=()=>composer.getByTestId('rich-chat-composer-input');
  await input().fill('Unsent question before the initiative thread is ready');
  await page.getByRole('button',{name:'Mount fixture discussion',exact:true}).click();await expect(input()).toContainText('Unsent question before the initiative thread is ready');
  await page.reload();await expect(input()).toContainText('Unsent question before the initiative thread is ready');
  await page.getByRole('button',{name:'Mount fixture discussion',exact:true}).click();await expect(input()).toContainText('Unsent question before the initiative thread is ready');
  const proof=await page.evaluate(()=>(window as any).__initiativeInquiry.proof);expect(proof.sends).toEqual([]);expect(proof.dms).toEqual([]);expect(proof.invitations).toEqual([]);
  expect(apiWrites).toEqual([]);expect(errors).toEqual([]);await recordProof(page,apiWrites,errors);
});


test('denial, late receipts and a missing private destination retain the exact draft without fallback',async({page})=>{
  const {apiWrites,errors}=await mountFixture(page);const composer=page.getByTestId('inquiry-composer'),input=()=>composer.getByTestId('rich-chat-composer-input');
  await input().fill('@Caleb Turner initiative note');await composer.getByTestId('rich-chat-composer-send').click();
  await page.getByRole('button',{name:'Deny fixture send',exact:true}).click();
  await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Fixture posting denied');await expect(input()).toContainText('@Caleb Turner initiative note');
  await composer.getByTestId('rich-chat-composer-send').click();await composer.getByLabel('Chat recipient').selectOption('person:caleb');
  await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('Confirmation stopped');
  await input().fill('New private text');await page.getByRole('button',{name:'Confirm fixture receipt',exact:true}).click();await expect(input()).toContainText('New private text');
  await page.getByRole('button',{name:'Toggle fixture Caleb availability',exact:true}).click();await expect(input()).toContainText('New private text');
  await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Unavailable person');await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();
  await page.getByRole('button',{name:'Toggle fixture Caleb availability',exact:true}).click();await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Caleb Turner');
  const proof=await page.evaluate(()=>(window as any).__initiativeInquiry.proof);expect(proof.dms).toEqual([]);expect(proof.invitations).toEqual([]);expect(apiWrites).toEqual([]);expect(errors).toEqual([]);
  await recordProof(page,apiWrites,errors);
});

test('a late work-item comment cannot clear another actor or destination draft or refresh the wrong view',async({page})=>{
  const {apiWrites,errors}=await mountFixture(page);await page.getByRole('button',{name:'Use fixture work item',exact:true}).click();
  const composer=page.getByTestId('inquiry-composer'),input=()=>composer.getByTestId('rich-chat-composer-input');
  await input().fill('/comment Native fixture comment');await composer.getByTestId('rich-chat-composer-send').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__initiativeInquiry.proof.comments.length)).toBe(1);
  await composer.getByLabel('Chat recipient').selectOption('person:caleb');
  await input().evaluate(element=>(element as HTMLElement & {editor:{commands:{setContent(html:string):void}}}).editor.commands.setContent('<p>New private draft</p>'));
  await page.getByRole('button',{name:'Confirm fixture comment',exact:true}).click();await expect(input()).toContainText('New private draft');
  await expect.poll(()=>page.evaluate(()=>(window as any).__initiativeInquiry.proof.commentRefreshes)).toBe(0);
  await composer.getByLabel('Chat recipient').selectOption('discussion');await input().fill('/comment Other fixture comment');await composer.getByTestId('rich-chat-composer-send').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__initiativeInquiry.proof.comments.length)).toBe(2);
  await page.getByRole('button',{name:'Switch fixture actor',exact:true}).click();await expect(input()).toBeEmpty();await input().fill('Other actor work-item draft');
  await page.getByRole('button',{name:'Confirm fixture comment',exact:true}).click();await expect(input()).toContainText('Other actor work-item draft');
  await expect.poll(()=>page.evaluate(()=>(window as any).__initiativeInquiry.proof.commentRefreshes)).toBe(0);expect(apiWrites).toEqual([]);expect(errors).toEqual([]);
  await recordProof(page,apiWrites,errors);
});

test('both invitation entry points require a fresh matching directory and cannot invite a replacement call',async({page})=>{
  const {apiWrites,errors}=await mountFixture(page);const composer=page.getByTestId('inquiry-composer'),input=()=>composer.getByTestId('rich-chat-composer-input');
  await page.getByRole('button',{name:'Join fixture huddle',exact:true}).click();
  await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toContainText('Huddle');
  await composer.getByLabel('Chat recipient').selectOption('discussion');
  await page.route('**/api/people/shared',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({tenant:'assessment',me:{userId:'fixture-actor',displayName:'Fixture Actor'},lobby:'assessment:lobby',dmPrefix:'assessment:dm:',people:[{userId:'caleb',displayName:'Caleb Turner'}]})}));
  await input().fill('@Caleb Turner lets review');await composer.getByRole('button',{name:'Invite to huddle',exact:true}).click();
  await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('does not match this session');await expect(input()).toContainText('@Caleb Turner lets review');
  await input().fill('/invite @Caleb Turner');await composer.getByTestId('rich-chat-composer-send').click();
  await expect(composer).toContainText('does not match this session');await expect(input()).toContainText('/invite @Caleb Turner');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let directoryRequested=false;
  await page.route('**/api/people/shared',async route=>{directoryRequested=true;await held;await route.fulfill({contentType:'application/json',body:JSON.stringify({tenant:'orgiq',me:{userId:'fixture-actor',displayName:'Fixture Actor'},lobby:'orgiq:lobby',dmPrefix:'orgiq:dm:',people:[{userId:'caleb',displayName:'Caleb Turner'}]})});});
  await composer.getByTestId('rich-chat-composer-send').click();await expect.poll(()=>directoryRequested).toBe(true);
  await page.getByRole('button',{name:'Switch fixture call',exact:true}).click();release();await expect(composer.getByTestId('rich-chat-composer-send')).toBeEnabled();
  await expect(input()).toContainText('/invite @Caleb Turner');const proof=await page.evaluate(()=>(window as any).__initiativeInquiry.proof);
  expect(proof.invitations).toEqual([]);expect(proof.sends).toEqual([]);expect(proof.dms).toEqual([]);expect(apiWrites).toEqual([]);expect(errors).toEqual([]);
  await recordProof(page,apiWrites,errors);
});

test('ended huddle draft stays scoped, visible and disabled until explicit text recovery or discard',async({page})=>{
  const {apiWrites,errors}=await mountFixture(page);const composer=page.getByTestId('inquiry-composer'),input=()=>composer.getByTestId('rich-chat-composer-input');
  await input().fill('Existing page inquiry');await page.getByRole('button',{name:'Join fixture huddle',exact:true}).click();
  await composer.getByRole('button',{name:'Huddle chat',exact:true}).click();await input().fill('/invite @Caleb Turner');
  await page.getByRole('button',{name:'End fixture huddle retaining draft',exact:true}).click();
  await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Previous huddle');await expect(input()).toContainText('/invite @Caleb Turner');
  await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();await expect(composer.getByTestId('initiative-retired-huddle-draft')).toContainText('Observability fixture');
  await page.screenshot({path:test.info().outputPath('retired-huddle-draft-retained.png')});
  await composer.getByRole('button',{name:'Recover text',exact:true}).click();await expect(composer.getByTestId('initiative-huddle-draft-recovery')).toContainText('Choose a current To destination');
  await expect(composer.getByRole('button',{name:'Add retained text',exact:true})).toBeDisabled();
  await composer.getByLabel('Chat recipient').selectOption('person:caleb');await expect(input()).toContainText('Existing page inquiry');await expect(input()).not.toContainText('/invite');
  await expect(composer.getByTestId('initiative-huddle-draft-recovery')).toContainText('Attached files stay with the original huddle draft');
  await composer.getByRole('button',{name:'Add retained text',exact:true}).click();await expect(input()).toContainText('Existing page inquiry');await expect(input()).toContainText('/invite @Caleb Turner');
  await expect(composer.getByTestId('initiative-chat-receipt')).toContainText('The original huddle draft is retained');
  const retained=await page.evaluate(()=>{const row=(window as any).__initiativeInquiry.retiredDrafts[0];return{html:row.draft.html,files:row.draft.files.map((file:File)=>file.name),page:row.page};});
  expect(retained.html).toContain('/invite');expect(retained.files).toEqual(['retained-fixture.txt']);expect(retained.page).toEqual({kind:'initiative',id:'p-observability'});
  await page.getByRole('button',{name:'Join fixture huddle',exact:true}).click();await expect(input()).toContainText('Existing page inquiry');
  await composer.getByRole('button',{name:'Huddle chat',exact:true}).click();await expect(input()).toBeEmpty();
  await composer.getByRole('button',{name:'Review draft',exact:true}).click();await expect(input()).toContainText('/invite @Caleb Turner');await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();
  await expect(composer.getByRole('button',{name:'Huddle chat',exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath('retired-huddle-draft-with-live-call.png')});
  await composer.getByRole('button',{name:'Huddle chat',exact:true}).click();await input().fill('Second unsent huddle inquiry');
  await page.getByRole('button',{name:'End fixture huddle retaining draft',exact:true}).click();
  await expect(composer.getByTestId('initiative-retired-huddle-draft')).toHaveCount(1);await expect(composer.getByTestId('initiative-retired-huddle-draft')).toContainText('2 unsent huddle drafts');
  await composer.getByLabel('Retained huddle draft').selectOption('fixture-call');await expect(input()).toContainText('/invite @Caleb Turner');
  await page.screenshot({path:test.info().outputPath('retired-huddle-draft-compact.png')});
  await page.getByRole('button',{name:'Switch fixture actor',exact:true}).click();await expect(input()).toBeEmpty();await expect(composer.getByTestId('initiative-retired-huddle-draft')).toHaveCount(0);
  await page.getByRole('button',{name:'Switch fixture actor',exact:true}).click();await expect(input()).toContainText('/invite @Caleb Turner');
  await composer.getByRole('button',{name:'Discard draft',exact:true}).click();await expect(input()).toBeEmpty();await expect(composer.getByTestId('initiative-retired-huddle-draft')).toHaveCount(1);
  await composer.getByRole('button',{name:'Review draft',exact:true}).click();await expect(input()).toContainText('Second unsent huddle inquiry');
  await composer.getByRole('button',{name:'Discard draft',exact:true}).click();await expect(input()).toBeEmpty();await expect(composer.getByTestId('initiative-retired-huddle-draft')).toHaveCount(0);
  await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toHaveText('Previous huddle');await expect(composer.getByTestId('rich-chat-composer-send')).toBeDisabled();
  const proof=await page.evaluate(()=>(window as any).__initiativeInquiry.proof);expect(proof.invitations).toEqual([]);expect(proof.huddleSends).toEqual([]);expect(proof.dms).toEqual([]);expect(proof.sends).toEqual([]);
  expect(apiWrites).toEqual([]);expect(errors).toEqual([]);await recordProof(page,apiWrites,errors,{retainedOriginal:retained,compactNoticeCount:1,scopeIsolation:true,newCallDraftStartsEmpty:true,explicitRecoveryPreservesExistingText:true,explicitDiscards:true});
});


test('a joined huddle offers chat to an initiative reader without moving an existing draft',async({page})=>{
  const {apiWrites,errors}=await mountFixture(page);
  const composer=page.getByTestId('inquiry-composer');
  await expect(composer.getByTestId('rich-chat-composer-input')).toBeVisible();
  await page.getByRole('button',{name:'Revoke fixture posting',exact:true}).click();
  await page.getByRole('button',{name:'Join fixture huddle',exact:true}).click();
  await expect(composer.getByLabel('Chat recipient').locator('option:checked')).toContainText('Huddle');
  const input=composer.getByTestId('rich-chat-composer-input');
  await input.fill('A message for the joined huddle');
  await expect(composer.getByTestId('rich-chat-composer-send')).toBeEnabled();
  await composer.getByTestId('rich-chat-composer-send').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__initiativeInquiry.proof.huddleSends.length)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__initiativeInquiry.proof.sends.length)).toBe(0);
  await expect(composer).not.toContainText('Your draft stays in its chosen destination');
  expect(apiWrites).toEqual([]);expect(errors).toEqual([]);
  await recordProof(page,apiWrites,errors);
});
