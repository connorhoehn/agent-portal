jest.mock('../document-drafts.js',()=>({recordDraftPublication:jest.fn(async()=>true)}));
jest.mock('@connorhoehnslalom/realtime-modules/server', () => ({ createCanvasSeed: jest.fn(() => ({snapshot:'baseline'})), exportCanvasProjection: jest.fn(() => ({markdown:'base normalized'})) }));
jest.mock('../../lib/document-canvas-schema.js', () => ({ documentCanvasSchema:{} }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../document-canvas.js', () => ({ readDocumentCanvasProjection: jest.fn() }));
jest.mock('../document-mapping.js', () => ({ documentSourceRevision: (s:string) => require('node:crypto').createHash('sha256').update(s).digest('hex'), advanceDocumentSourceRevision: jest.fn(async () => true) }));
import { createHash } from 'node:crypto';
import { isAllowed } from '../../lib/authz.js';
import { readDocumentCanvasProjection } from '../document-canvas.js';
import { advanceDocumentSourceRevision } from '../document-mapping.js';
import { publishSourcePage, previewSourceChanges, pullSourcePage, moveSourcePage, readSourceAsset, sourceMarkdownForCanvas, canvasMarkdownForSource } from '../document-source.js';
import type { Session } from '../../lib/session.js';
const session:Session={sub:'alice',tenant:'assessment',role:'assessor',grants:{assessment:['assessor']},iat:1};
const source={id:'page:123',title:'Guide',classification:'synced',markdown:'base'};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const reviewed={canvasVersion:'41',sourceRevision:hash('base'),projectionHash:hash('acknowledged edit')};
const originalFetch=global.fetch;
const originalEnv={...process.env};
beforeEach(()=>{
  jest.clearAllMocks();
  Object.assign(process.env,{ASSESSMENT_SOURCE_URL:'http://source:8001',ASSESSMENT_SOURCE_SECRET:'test-key'});
  jest.mocked(isAllowed).mockResolvedValue(true);
  jest.mocked(readDocumentCanvasProjection).mockResolvedValue({markdown:'acknowledged edit',sourceRevision:hash('base'),documentId:'uuid',version:'42'});
  jest.mocked(advanceDocumentSourceRevision).mockResolvedValue(true);
  global.fetch=jest.fn(async()=>new Response(JSON.stringify({published:true,source_revision:hash('acknowledged edit')}),{status:200}));
});
afterAll(()=>{process.env=originalEnv;global.fetch=originalFetch;});
it('publishes the saved binary projection and advances its baseline',async()=>{
  await publishSourcePage(source,session,reviewed);
  const init=jest.mocked(fetch).mock.calls[0]![1]!;
  expect(JSON.parse(init.body as string)).toMatchObject({markdown:'acknowledged edit',expected_revision:hash('base'),canvas_version:'42',actor:'alice'});
  expect(init.redirect).toBe('error');
  expect(advanceDocumentSourceRevision).toHaveBeenCalledWith('uuid',hash('base'),hash('acknowledged edit'));
});
it('reports remote success plus local CAS failure as reconciliation',async()=>{
  jest.mocked(advanceDocumentSourceRevision).mockResolvedValue(false);
  expect(await publishSourcePage(source,session,reviewed)).toMatchObject({published:true,reconciliation_needed:true});
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('preview never advances a baseline',async()=>{
  await previewSourceChanges(source,session);
  expect(JSON.parse(jest.mocked(fetch).mock.calls[0]![1]!.body as string).action).toBe('preview');
  expect(advanceDocumentSourceRevision).not.toHaveBeenCalled();
});
it('denied mutations and pull over collaborative edits never reach the source',async()=>{
  jest.mocked(isAllowed).mockResolvedValueOnce(false);
  await expect(publishSourcePage(source,session,reviewed)).rejects.toMatchObject({status:403});
  await expect(pullSourcePage(source,session)).rejects.toMatchObject({status:409});
  expect(fetch).not.toHaveBeenCalled();
});
it('preserves successful remote move with failed tree refresh',async()=>{
  global.fetch=jest.fn(async()=>new Response(JSON.stringify({ok:true,tree_refresh_failed:true}),{status:200}));
  expect(await moveSourcePage('page:123','page:1',2,session)).toEqual({ok:true,tree_refresh_failed:true});
});
it('roundtrips scoped attachments and rejects asset path traversal',async()=>{
  const canonical='![diagram](attachment:architecture.png)';
  const display=sourceMarkdownForCanvas('page:123',canonical);
  expect(display).toContain('/api/assessment/knowledge/source/asset?id=page%3A123&name=architecture.png');
  expect(canvasMarkdownForSource('page:123',display)).toBe(canonical);
  expect(canvasMarkdownForSource('page:999',display)).toBe(display);
  await expect(readSourceAsset('page:123','../secret')).rejects.toMatchObject({status:400});
  expect(fetch).not.toHaveBeenCalled();
});
it('preserves source conflicts without automatically retrying publication',async()=>{
  global.fetch=jest.fn(async()=>new Response(JSON.stringify({detail:'Remote source version changed'}),{status:409}));
  await expect(publishSourcePage(source,session,reviewed)).rejects.toMatchObject({status:409});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(advanceDocumentSourceRevision).not.toHaveBeenCalled();
});

it('permits a pull when only the canonical schema normalized source formatting',async()=>{
  jest.mocked(readDocumentCanvasProjection).mockResolvedValue({markdown:'base normalized',sourceRevision:hash('base'),documentId:'uuid',version:'42'});
  global.fetch=jest.fn(async()=>new Response(JSON.stringify({ok:true,source_revision:hash('changed source')}),{status:200}));
  expect(await pullSourcePage(source,session)).toMatchObject({ok:true,canvas_reconciliation_required:true});
  expect(advanceDocumentSourceRevision).not.toHaveBeenCalled();
});

it('rejects changed content or source revision after a preview without reaching upstream',async()=>{
  await expect(publishSourcePage(source,session,{...reviewed,projectionHash:hash('old preview')})).rejects.toMatchObject({status:409});
  await expect(publishSourcePage(source,session,{...reviewed,sourceRevision:hash('old source')})).rejects.toMatchObject({status:409});
  expect(fetch).not.toHaveBeenCalled();
});

it('publishes a new local draft using its stable canvas UUID and recorded target parent',async()=>{
 const draft={...source,id:'draft:11111111-1111-4111-8111-111111111111',source_parent_id:'page:1'};
 const projectionHash=hash(JSON.stringify({markdown:'acknowledged edit',title:draft.title,parent:draft.source_parent_id}));
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({published:true,page_id:'456',source_revision:hash('acknowledged edit')}),{status:200}));
 await publishSourcePage(draft,session,{sourceRevision:hash('base'),projectionHash});
 expect(JSON.parse(jest.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({action:'create',parent_id:'1',operation_id:'uuid',markdown:'acknowledged edit'});
 const {recordDraftPublication}=await import('../document-drafts.js');
 expect(recordDraftPublication).toHaveBeenCalledWith(draft.id,'uuid','456',hash('base'),hash('acknowledged edit'));
});

it('records the authoritative re-pulled source hash when the source normalizes Markdown',async()=>{
 const actual=hash('normalized upstream markdown');
 global.fetch=jest.fn(async()=>new Response(JSON.stringify({published:true,source_revision:actual}),{status:200}));
 await publishSourcePage(source,session,reviewed);
 expect(advanceDocumentSourceRevision).toHaveBeenCalledWith('uuid',hash('base'),actual);
});
