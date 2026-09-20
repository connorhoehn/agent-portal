// Creates a uniquely named local test draft on the isolated document stack.
// No source publication, shared browser cookies, or reference-stack mutations.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const req = createRequire(resolve(__dirname, '../../middleware/package.json'));
const WebSocket = req('ws'); const Y = req('yjs');
const base = process.env.DOCUMENT_TEST_BFF || 'http://127.0.0.1:3001';
async function persona(userId, role) {
 const jar=new Map();
 async function post(path,body) {
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:JSON.stringify(body)});
  for(const line of response.headers.getSetCookie()) {const pair=line.split(';')[0];const at=pair.indexOf('=');if(pair.slice(at+1))jar.set(pair.slice(0,at),pair.slice(at+1));else jar.delete(pair.slice(0,at));}
  const data=await response.json(); if(!response.ok)throw Error(`${path}: ${response.status} ${data.error||''}`);return data;
 }
 const who=await post('/api/session/login',{userId});
 if(role && who.role!==role)await post('/api/session/role',{role});
 return post;
}
function open(grant) {
 const ws=new WebSocket(grant.gatewayUrl,['document-grant-v1',grant.token]);const messages=[];const waiters=[];
 ws.on('message',b=>{const m=JSON.parse(b.toString());messages.push(m);for(const w of [...waiters])if(w.test(m)){clearTimeout(w.timer);waiters.splice(waiters.indexOf(w),1);w.resolve(m);}});
 function wait(test) {const found=messages.find(test);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const w={test,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(Error('Timed out waiting for document frame: '+messages.map(x=>x.type+':'+(x.action||x.message||'')).join(', ')));},15000)};waiters.push(w);});}
 const ready=new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 const send=(action,data={})=>ws.send(JSON.stringify({service:'crdt',action,channel:`doc:${grant.documentId}`,...data}));
 return {ws,wait,send,ready,messages};
}
(async()=>{
 if(process.argv.includes('--verify')) {
  const proof=JSON.parse(require('node:fs').readFileSync(process.argv[process.argv.indexOf('--verify')+1],'utf8'));
  const settings=JSON.parse(require('node:fs').readFileSync(resolve(__dirname,'../../.scratch/document-workspace/settings.json'),'utf8'));
  const {createDocumentGrant}=req('@connorhoehnslalom/realtime-modules/server');
  const sessionId=Buffer.from(JSON.stringify({role:'assessor',epoch:0,iat:Date.now()})).toString('base64url');
  const grant={documentId:proof.documentId,gatewayUrl:'ws://127.0.0.1:18081',token:createDocumentGrant({iss:settings.DOCUMENT_GRANT_ISSUER,sub:'u-asha',tenantId:'assessment',documentId:proof.documentId,operations:['read'],sessionId,sessionEpoch:0},{privateKey:settings.DOCUMENT_GRANT_PRIVATE_KEY,keyId:settings.DOCUMENT_GRANT_KEY_ID})};
  const client=open(grant);await client.ready;client.send('subscribe');const snapshot=await client.wait(m=>m.type==='crdt:snapshot');
  const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(snapshot.snapshot,'base64'));assert.ok(doc.getXmlFragment('body').toString().includes(proof.marker));
  client.ws.close();doc.destroy();console.log(JSON.stringify({documentId:proof.documentId,coldCacheContentPreserved:true}));return;
 }
 const write=await persona('u-farah','lead-assessor'); const read=await persona('u-asha');
 const draft=await write('/api/assessment/knowledge/doc/create',{title:'Integration proof '+randomUUID(),sectionKey:'workspace_drafts'});
 const writer=await write('/api/assessment/knowledge/canvas',{id:draft.id});const reader=await read('/api/assessment/knowledge/canvas',{id:draft.id});
 assert.equal(writer.canEdit,true);assert.equal(reader.canEdit,false);
 const a=open(writer),b=open(reader);await Promise.all([a.ready,b.ready]);a.send('subscribe');b.send('subscribe');
 const [sa,sb]=await Promise.all([a.wait(m=>m.type==='crdt:snapshot'),b.wait(m=>m.type==='crdt:snapshot')]);
 const da=new Y.Doc(),db=new Y.Doc();Y.applyUpdate(da,Buffer.from(sa.snapshot,'base64'));Y.applyUpdate(db,Buffer.from(sb.snapshot,'base64'));
 const before=Y.encodeStateVector(da);const marker='Durable proof '+randomUUID();const paragraph=new Y.XmlElement('paragraph');const txt=new Y.XmlText();txt.insert(0,marker);paragraph.insert(0,[txt]);da.getXmlFragment('body').push([paragraph]);
 const update=Buffer.from(Y.encodeStateAsUpdate(da,before)).toString('base64');const updateId=randomUUID();a.send('update',{update,updateId});
 await a.wait(m=>m.type==='crdt:persisted'&&m.updateId===updateId);
 const remote=await b.wait(m=>m.type==='crdt:update'&&m.update===update);Y.applyUpdate(db,Buffer.from(remote.update,'base64'));assert.match(db.getXmlFragment('body').toString(),new RegExp(marker));
 b.send('update',{update,updateId:'unauthorized-'+updateId});await b.wait(m=>m.type==='crdt:persistence-error'||m.type==='error');
 a.ws.close();b.ws.close();const fresh=open(await read('/api/assessment/knowledge/canvas',{id:draft.id}));await fresh.ready;fresh.send('subscribe');const snap=await fresh.wait(m=>m.type==='crdt:snapshot');const reloaded=new Y.Doc();Y.applyUpdate(reloaded,Buffer.from(snap.snapshot,'base64'));assert.match(reloaded.getXmlFragment('body').toString(),new RegExp(marker));fresh.ws.close();
 console.log(JSON.stringify({sourceId:draft.id,documentId:draft.documentId,writerReceipt:true,readerConverged:true,readOnlyWriteRejected:true,reloadPreserved:true,marker},null,2));da.destroy();db.destroy();reloaded.destroy();
})().catch(e=>{console.error(e.message);process.exitCode=1;setTimeout(()=>process.exit(1),100);});
