import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchMigration, readSearchEvidence, linkSearchCitations } from '../searchModel.ts';

test('legacy links preserve identifiers, query and hash while choosing the matching Search view',()=>{
  const url=new URL(searchMigration('/iq/explore','?focus=p-2,p-3&layout=radial&entities=people&extra=kept','#graph'),'http://local');
  assert.equal(url.pathname,'/iq/search');assert.equal(url.searchParams.get('selection'),'person:p-2,person:p-3');
  assert.equal(url.searchParams.get('focus'),'p-2,p-3');assert.equal(url.searchParams.get('tab'),'connections');assert.equal(url.searchParams.get('extra'),'kept');assert.equal(url.hash,'#graph');
  const ask=new URL(searchMigration('/iq/invoke','?session=one&prompt=Question&agentId=advisor'),'http://local');
  assert.equal(ask.searchParams.get('tab'),'answer');assert.equal(ask.searchParams.get('session'),'one');assert.equal(ask.searchParams.get('agentId'),'advisor');
});
test('only numbered server search context becomes linked evidence',()=>{
  const record={id:'one',type:'initiative',title:'A project',href:'/iq/projects/one',n:2};
  const records=readSearchEvidence([{name:'search_context',result:JSON.stringify({records:[record,{...record,id:'bad',href:'javascript:alert(1)'}]})},{name:'other',result:JSON.stringify({records:[{...record,n:3}]})}]);
  assert.deepEqual(records,[record]);
  assert.equal(linkSearchCitations('Supported [2], unknown [3], [2](https://example.com)',records),'Supported [2](/iq/projects/one), unknown [3], [2](https://example.com)');
  assert.deepEqual(readSearchEvidence([{name:'search_context',result:'{"records":['}]),[]);
});
