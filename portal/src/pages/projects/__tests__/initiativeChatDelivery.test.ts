import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InitiativeDiscussionDelivery, inquiryInvitationFeedback, invitationTargets, mentionedInquiryPeople, readInitiativeDestination, rememberInitiativeDestination } from '../initiativeChatDelivery.ts';

const people = [{ userId: 'caleb', displayName: 'Caleb Turner' }, { userId: 'caleb-jr', displayName: 'Caleb Turner Jr' }, { userId: 'nora', displayName: 'Nora DaSilva' }];
test('mentions remain exact current-directory people, including longer names and multiple mentions', () => {
  assert.deepEqual(mentionedInquiryPeople('@Caleb Turner Jr and @Nora DaSilva, please review', people).map(p => p.userId), ['caleb-jr', 'nora']);
  assert.deepEqual(mentionedInquiryPeople('email@Caleb Turner or @Unknown Person', people), []);
  const targets = invitationTargets('@Caleb Turner, @Nora DaSilva', people); assert.ok(Array.isArray(targets));
  assert.deepEqual(targets.map(p => p.userId), ['caleb', 'nora']);
  const lower = invitationTargets('@caleb turner', people); assert.ok(Array.isArray(lower)); assert.equal(lower[0]!.userId, 'caleb');
  assert.equal(typeof invitationTargets('@Caleb Turner can you join', people), 'string');
  assert.equal(typeof invitationTargets('caleb', people), 'string');
});
function transport() {
  const listeners = new Set<(frame: Record<string, unknown>) => void>(); const sent: Array<{text: string; metadata: Record<string, unknown>}> = [];
  return { sent, listen: (h: (frame: Record<string, unknown>) => void) => { listeners.add(h); return () => {listeners.delete(h);}; },
    emit: (frame: Record<string, unknown>) => { for (const h of listeners) h(frame); },
    sendMessage: (text: string, metadata: Record<string, unknown>) => { sent.push({text, metadata}); } };
}
const base = { scopeKey: 'actor:initiative', channel: 'orgiq:initiative:p-observability', userId: 'actor', text: '@Caleb Turner let’s chat', metadata: { pageReference: { kind: 'initiative', id: 'p-observability' } }, current: () => true, newId: () => 'delivery-one' };
function acknowledge(t: ReturnType<typeof transport>, id='message-one') {
  t.emit({type:'chat',action:'sent',channel:base.channel,messageId:id});
  t.emit({type:'chat',action:'message',channel:base.channel,message:{id,channel:base.channel,userId:base.userId,metadata:{clientDeliveryId:t.sent.at(-1)!.metadata.clientDeliveryId}}});
}
test('discussion sends to captured channel and clears only after matched native persisted receipt', async () => {
  const sender=new InitiativeDiscussionDelivery(), t=transport(); let settled=false;
  const pending=sender.send({...base,...t,signal:new AbortController().signal}).then(ok=>{settled=true;return ok;});
  assert.equal(settled,false); assert.equal(t.sent[0]!.text,base.text); assert.deepEqual(t.sent[0]!.metadata.pageReference,base.metadata.pageReference);
  t.emit({type:'chat',action:'sent',channel:'wrong',messageId:'wrong'}); assert.equal(settled,false);
  acknowledge(t); assert.equal(await pending,true);
});
test('denial and timeout retain retry identity without a DM fallback', async () => {
  const sender=new InitiativeDiscussionDelivery(),t=transport();let ids=0;
  const input={...base,...t,newId:()=>`delivery-${++ids}`,signal:new AbortController().signal,timeoutMs:5};
  const refused=sender.send(input);t.emit({type:'error',service:'chat',channel:base.channel,error:'Posting denied'});await assert.rejects(refused,/Posting denied/);
  const retry=sender.send(input);assert.equal(t.sent[1]!.metadata.clientDeliveryId,t.sent[0]!.metadata.clientDeliveryId);acknowledge(t);assert.equal(await retry,true);
  await assert.rejects(sender.send({...input,text:'Later message'}),/not confirmed/);assert.equal(t.sent.length,3);
});
test('a changed actor or destination cannot clear a draft after a late receipt', async () => {
  const sender=new InitiativeDiscussionDelivery(),t=transport();let current=true;
  const pending=sender.send({...base,...t,current:()=>current,signal:new AbortController().signal});current=false;acknowledge(t);assert.equal(await pending,false);
  const abort=new AbortController();const other=sender.send({...base,...t,signal:abort.signal});abort.abort();await assert.rejects(other,/conversation changed/);
});
test('destination preferences are actor/tenant/subject scoped and retain unavailable exact choices without storing drafts', () => {
  const items = new Map<string,string>(); const storage = { getItem: (key:string) => items.get(key) ?? null, setItem:(key:string,value:string) => { items.set(key,value); } };
  rememberInitiativeDestination(storage, 'orgiq:actor:initiative', { recipient:'person:caleb', mode:'chat' });
  assert.deepEqual(readInitiativeDestination(storage, 'orgiq:actor:initiative'), {recipient:'person:caleb',mode:'chat'});
  assert.equal(readInitiativeDestination(storage, 'orgiq:other:initiative'), null);
  assert.equal(readInitiativeDestination(storage, 'assessment:actor:initiative'), null);
  assert.equal(readInitiativeDestination(storage, 'orgiq:actor:other'), null);
  rememberInitiativeDestination(storage, 'ended-huddle', {recipient:'huddle:previous-call',mode:'chat'});
  assert.deepEqual(readInitiativeDestination(storage, 'ended-huddle'), {recipient:'huddle:previous-call',mode:'chat'});
  items.set('initiative-composer-destination:invalid',JSON.stringify({recipient:'https://external.invalid',mode:'chat',html:'secret'}));
  assert.equal(readInitiativeDestination(storage, 'invalid'), null);
  assert.ok([...items.values()][0]?.includes('person:caleb')); assert.ok(![...items.values()][0]?.includes('html'));
  const blocked={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
  assert.equal(readInitiativeDestination(blocked,'scope'),null);assert.doesNotThrow(()=>rememberInitiativeDestination(blocked,'scope',{recipient:null,mode:'agent'}));
});
test('invitation receipts follow only native request/call/recipient correlation without claiming a media join', () => {
  const receipt={requestId:'request-one',callId:'call-one',userIds:['caleb']};
  const row={...receipt,userId:'caleb',displayName:'Caleb Turner',state:'requested' as const};
  assert.equal(inquiryInvitationFeedback(receipt,[row],null),null);
  assert.equal(inquiryInvitationFeedback(receipt,[{...row,requestId:'other',state:'failed',error:'wrong'}],null),null);
  assert.equal(inquiryInvitationFeedback(receipt,[{...row,callId:'other',state:'accepted'}],null),null);
  assert.match(inquiryInvitationFeedback(receipt,[{...row,state:'failed',error:'Posting denied'}],null)!,/Invitation to Caleb Turner failed: Posting denied/);
  assert.equal(inquiryInvitationFeedback(receipt,[{...row,state:'accepted'}],null),'Caleb Turner accepted the invitation.');
  assert.equal(inquiryInvitationFeedback(receipt,[row],'Uncorrelated older gateway refusal'),'Invitation request is unconfirmed: Uncorrelated older gateway refusal');
});
