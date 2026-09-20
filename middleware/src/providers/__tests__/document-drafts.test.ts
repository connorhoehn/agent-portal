jest.mock('../../lib/authz.js',()=>({isAllowed:jest.fn(async()=>true)}));
jest.mock('../../config.js',()=>({config:{mock:{aurora:false}}}));
jest.mock('../aurora.js',()=>({withTransaction:jest.fn()}));
jest.mock('../document-mapping.js',()=>({documentSourceRevision:()=> 'hash',ensureDocumentMapping:jest.fn(async()=>({document_id:'uuid'})),advanceDocumentSourceRevision:jest.fn(async()=>true)}));
jest.mock('../document-source.js',()=>({DocumentSourceError:class extends Error {constructor(public status:number,message:string){super(message);}},sourceConfigured:()=>false,readSourceTree:jest.fn()}));
jest.mock('../../lib/assessment-broker.js',()=>({assessmentBroker:{publish:jest.fn()}}));
import {createDocumentDraft,recordDraftPublication} from '../document-drafts.js';
import {withTransaction} from '../aurora.js';
import {ensureDocumentMapping,advanceDocumentSourceRevision} from '../document-mapping.js';
import {isAllowed} from '../../lib/authz.js';
import {assessmentBroker} from '../../lib/assessment-broker.js';
import type {Session} from '../../lib/session.js';
const session:Session={sub:'creator',tenant:'assessment',role:'assessor',grants:{assessment:['assessor']},iat:1};
let tx:jest.Mock;
beforeEach(()=>{
 jest.clearAllMocks();jest.mocked(isAllowed).mockResolvedValue(true);
 tx=jest.fn(async(sql:string)=>sql.startsWith('SELECT')?[{key:'enterprise_context',id:'parent'}]:[]);
 jest.mocked(withTransaction).mockImplementation(async work=>work(tx));
});
it('creates node, body, and verified creator mapping in one transaction',async()=>{
 const result=await createDocumentDraft({title:'New draft',sectionKey:'enterprise_context',parentId:'parent'},session);
 expect(result).toMatchObject({ok:true,documentId:'uuid',title:'New draft'});
 expect(withTransaction).toHaveBeenCalledTimes(1);
 expect(tx.mock.calls.map(call=>call[0])).toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO assessment_knowledge_nodes'),expect.stringContaining('INSERT INTO assessment_knowledge_docs')]));
 expect(ensureDocumentMapping).toHaveBeenCalledWith(result.id,'hash','creator',tx);
 expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
});
it('rejects parent outside the local section before any INSERT',async()=>{
 tx.mockResolvedValueOnce([{key:'enterprise_context'}]).mockResolvedValueOnce([]);
 await expect(createDocumentDraft({title:'Draft',sectionKey:'enterprise_context',parentId:'other'},session)).rejects.toMatchObject({status:400});
 expect(tx.mock.calls.some(call=>call[0].startsWith('INSERT'))).toBe(false);
 expect(ensureDocumentMapping).not.toHaveBeenCalled();
});
it('a mapping failure escapes the transaction and does not announce a draft',async()=>{
 jest.mocked(ensureDocumentMapping).mockRejectedValueOnce(new Error('mapping unavailable'));
 await expect(createDocumentDraft({title:'Draft',sectionKey:'enterprise_context'},session)).rejects.toThrow('mapping unavailable');
 expect(assessmentBroker.publish).not.toHaveBeenCalled();
});
it('rejects unauthorized callers and never remotely creates a page',async()=>{
 jest.mocked(isAllowed).mockResolvedValueOnce(false);
 await expect(createDocumentDraft({title:'Draft',sectionKey:'enterprise_context'},session)).rejects.toMatchObject({status:403});
 await expect(createDocumentDraft({title:'Draft',sectionKey:'enterprise_context',sourceParentId:'page:1'},session)).rejects.toMatchObject({status:503});
 expect(withTransaction).not.toHaveBeenCalled();
});

it('records new remote page association and revision in one transaction',async()=>{
 tx.mockResolvedValueOnce([{id:'draft:11111111-1111-4111-8111-111111111111'}]);
 expect(await recordDraftPublication('draft:11111111-1111-4111-8111-111111111111','uuid','123','old','new')).toBe(true);
 expect(advanceDocumentSourceRevision).toHaveBeenCalledWith('uuid','old','new',tx);
 expect(tx.mock.calls[0][0]).toContain('published_page_id');
});
it('rolls back association if the source baseline changed concurrently',async()=>{
 tx.mockResolvedValueOnce([{id:'draft:11111111-1111-4111-8111-111111111111'}]);
 jest.mocked(advanceDocumentSourceRevision).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
 expect(await recordDraftPublication('draft:11111111-1111-4111-8111-111111111111','uuid','123','old','new')).toBe(false);
});

it('accepts a replay whose exact remote association and revision were already recorded',async()=>{
 tx.mockResolvedValueOnce([{id:'draft:11111111-1111-4111-8111-111111111111'}]);
 jest.mocked(advanceDocumentSourceRevision).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 expect(await recordDraftPublication('draft:11111111-1111-4111-8111-111111111111','uuid','123','old','new')).toBe(true);
 expect(advanceDocumentSourceRevision).toHaveBeenLastCalledWith('uuid','new','new',tx);
});
