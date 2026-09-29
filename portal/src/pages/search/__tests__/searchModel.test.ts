import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchMigration, readSearchEvidence, linkSearchCitations, stripSourceUris } from '../searchModel.ts';

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

test('the composer issues queries: a bare send replaces q; a send with context or a selection keeps it',async()=>{
  const { nextQueryAfterSend, nextTabAfterSend } = await import('../searchModel.ts');
  const text='What connects these 3 records, and what needs attention?';
  assert.equal(nextQueryAfterSend({q:'Who can help finish Auth Migration?',attached:3,selected:3,text}),'Who can help finish Auth Migration?');
  assert.equal(nextQueryAfterSend({q:'auth',attached:0,selected:0,text}),text);
  assert.equal(nextQueryAfterSend({q:null,attached:2,selected:0,text}),null);
  assert.equal(nextQueryAfterSend({q:'',attached:0,selected:1,text}),null);
  assert.equal(nextQueryAfterSend({q:null,attached:0,selected:0,text:'  Who knows SAML?  '}),'Who knows SAML?');
  assert.equal(nextTabAfterSend('results'),'answer');
  assert.equal(nextTabAfterSend(null),'answer');
  assert.equal(nextTabAfterSend('answer'),'answer');
  assert.equal(nextTabAfterSend('connections'),'connections');
});

test('the assistant strip one-liner is plain text without Markdown or s3 URIs',async()=>{
  const { assistantStripText } = await import('../searchModel.ts');
  const md='## Summary\n\n**Key Decisions:**\n- **Sarah Thompson** owns [Auth Migration](/iq/projects/auth) [1]\n- See _the_ `ADR` (s3://orgiq-documents-1/adr-d-aurora.md)\n\nSource: s3://bucket/key.md';
  assert.equal(assistantStripText(md),'Summary Key Decisions: Sarah Thompson owns Auth Migration [1] See the ADR Source:');
  assert.equal(assistantStripText('snake_case_name stays'),'snake_case_name stays');
});

test('stripSourceUris drops the raw sources line and bare s3 URIs, keeps prose', () => {
  const md = '**Key decisions**\n\nStart with Vera Green [1].\n\nSources: s3://orgiq-documents/a.md, s3://orgiq-documents/b.md\n';
  const out = stripSourceUris(md);
  assert.equal(out.includes('s3://'), false);
  assert.equal(/Sources/i.test(out), false);
  assert.ok(out.includes('**Key decisions**'));
  assert.ok(out.includes('Start with Vera Green [1].'));
  assert.equal(stripSourceUris('See s3://bucket/x.md for details.'), 'See  for details.');
  assert.equal(stripSourceUris('Sources:\n- s3://bucket/x.md\n- s3://bucket/y.md\nDone.'), 'Done.');
  assert.equal(stripSourceUris('Answer.\n\n*Sources: s3://bucket/x.md, s3://bucket/y.md*'), 'Answer.');
  assert.equal(stripSourceUris('Answer.\n\n**Sources:** s3://bucket/x.md'), 'Answer.');
});

test('nextQueryAfterSend: a bare message is the new query; a question about attached or selected records keeps q', async () => {
  const { nextQueryAfterSend } = await import('../searchModel.ts');
  assert.equal(nextQueryAfterSend({ q: null, attached: 0, selected: 0, text: 'Who can help?' }), 'Who can help?');
  assert.equal(nextQueryAfterSend({ q: 'old query', attached: 0, selected: 0, text: 'new query' }), 'new query');
  assert.equal(nextQueryAfterSend({ q: 'old query', attached: 2, selected: 0, text: 'What connects these?' }), 'old query');
  assert.equal(nextQueryAfterSend({ q: 'old query', attached: 0, selected: 3, text: 'What connects these?' }), 'old query');
  assert.equal(nextQueryAfterSend({ q: null, attached: 0, selected: 3, text: 'What connects these?' }), null);
  assert.equal(nextQueryAfterSend({ q: 'old query', attached: 0, selected: 0, text: '   ' }), 'old query');
});

test('searchTitle shows the first sentence of a long prompt whole; the header truncates it and carries the full text', async () => {
  const { searchTitle } = await import('../searchModel.ts');
  assert.equal(searchTitle('Who can help finish Auth Migration?'), 'Who can help finish Auth Migration?');
  assert.equal(searchTitle('Help me prioritize the next changes and explain the tradeoffs. Open work on Auth Migration: - Refresh loop'), 'Help me prioritize the next changes and explain the tradeoffs.');
  assert.equal(searchTitle('x'.repeat(100)), 'x'.repeat(100));
  assert.equal(searchTitle('first line\nsecond line'), 'first line');
  assert.equal(searchTitle('   '), '');
});
