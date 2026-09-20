jest.mock('../document-canvas.js',()=>({connectDocumentCanvas:jest.fn(async()=>({gatewayUrl:'ws://gateway.example/document-realtime',token:'scoped-token',documentId:'11111111-1111-4111-8111-111111111111'}))}));
import {stageDocumentSourceImages} from '../document-source-upload.js';
import type {Session} from '../../lib/session.js';
const session:Session={sub:'alice',tenant:'assessment',role:'assessor',grants:{assessment:['assessor']},iat:1};
const source={id:'page:123',title:'Guide',classification:'synced',markdown:''};
const originalFetch=global.fetch;
const originalInternal=process.env['DOCUMENT_GATEWAY_INTERNAL_URL'];
const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
beforeEach(()=>{process.env['DOCUMENT_GATEWAY_INTERNAL_URL']='ws://gateway.internal:8080';global.fetch=jest.fn(async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}}));});
afterAll(()=>{global.fetch=originalFetch;if(originalInternal===undefined)delete process.env['DOCUMENT_GATEWAY_INTERNAL_URL'];else process.env['DOCUMENT_GATEWAY_INTERNAL_URL']=originalInternal;});
it('reads only the exact gateway path with scoped authentication and stages deterministic attachment bytes',async()=>{
 const stage=jest.fn(async()=>{});
 const result=await stageDocumentSourceImages(source,session,'![diagram](/api/uploads/abc-123)',stage);
 expect(jest.mocked(fetch).mock.calls[0]![0]!.toString()).toBe('http://gateway.internal:8080/api/uploads/abc-123');
 expect(jest.mocked(fetch).mock.calls[0]![1]).toMatchObject({headers:{authorization:'Bearer scoped-token'},redirect:'error'});
 expect(stage).toHaveBeenCalledWith(expect.objectContaining({asset_base64:png.toString('base64'),content_type:'image/png',operation_id:'11111111-1111-4111-8111-111111111111'}));
 expect(result).toMatch(/^!\[diagram\]\(attachment:canvas-[a-f0-9]{64}\.png\)$/);
 expect(result).not.toContain('scoped-token');
});
it('rejects arbitrary origins and query-bearing upload guesses without fetching them',async()=>{
 for(const url of ['https://evil.example/api/uploads/id','/api/uploads/id?other=1']) await expect(stageDocumentSourceImages(source,session,`![x](${url})`,async()=>{})).rejects.toThrow('Only document-owned');
 expect(fetch).not.toHaveBeenCalled();
});
it('leaves ordinary external URLs alone and rejects mismatched image bytes',async()=>{
 expect(await stageDocumentSourceImages(source,session,'![x](https://example.com/public.png)',async()=>{})).toBe('![x](https://example.com/public.png)');
 expect(fetch).not.toHaveBeenCalled();
 global.fetch=jest.fn(async()=>new Response('not a png',{status:200,headers:{'content-type':'image/png'}}));
 await expect(stageDocumentSourceImages(source,session,'![x](/api/uploads/id)',async()=>{})).rejects.toThrow('do not match');
});
it('does not stage images when current document permission is rejected',async()=>{
 global.fetch=jest.fn(async()=>new Response('',{status:403}));
 const stage=jest.fn(async()=>{});
 await expect(stageDocumentSourceImages(source,session,'![x](/api/uploads/id)',stage)).rejects.toThrow('current document permission');
 expect(stage).not.toHaveBeenCalled();
});
