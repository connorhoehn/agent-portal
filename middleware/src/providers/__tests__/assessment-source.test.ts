jest.mock('../../config.js',()=>({config:{mock:{aurora:false}}}));
jest.mock('../assessment-aurora.js',()=>({fetchKnowledgeTree:jest.fn(async()=>[{key:'enterprise_context',title:'Drafts',kind:'local',nodes:[{id:'local:one',title:'Draft',parent_id:null,is_dir:false}]}]),fetchKnowledgeDoc:jest.fn(async()=>null)}));
jest.mock('../document-source.js',()=>({sourceConfigured:jest.fn(()=>true),readSourceTree:jest.fn(async()=>({root_page_id:'10',pulled_at:'2026-09-20T00:00:00Z',nodes:[{page_id:'10',title:'Real source',parent_id:null,position:0,has_children:true,version:3},{page_id:'11',title:'Child',parent_id:'10',position:0,has_children:false,version:1}]})),readSourcePage:jest.fn(async()=>({markdown:'real body',meta:{page_id:'11',title:'Real title',last_pulled_at:'2026-09-20T00:00:00Z'}}))}));
import {sourceConfigured,readSourcePage} from '../document-source.js';
import * as A from '../assessment-aurora.js';
import {getKnowledgeTree,getKnowledgeDoc,pullKnowledgeSection,publishKnowledgeDoc} from '../assessment.js';
beforeEach(()=>jest.clearAllMocks());
it('replaces source fixture tree with real nodes while preserving local drafts',async()=>{
 const result=await getKnowledgeTree();
 expect(result.sourceConfigured).toBe(true);
 expect(result.sections[0]!.nodes[0]!.id).toBe('local:one');
 expect(result.sections[1]!.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id:'page:11',parent_id:'page:10',editable:true})]));
});
it('reads canonical source Markdown and does not overwrite local drafts',async()=>{
 expect(await getKnowledgeDoc('page:11')).toMatchObject({markdown:'real body',title:'Real title',classification:'synced'});
 expect(readSourcePage).toHaveBeenCalledWith('page:11');
 await getKnowledgeDoc('local:one');
 expect(A.fetchKnowledgeDoc).toHaveBeenCalledWith('local:one');
});
it('refuses legacy fabricated publish and section pull in configured mode',async()=>{
 expect(await pullKnowledgeSection('confluence')).toMatchObject({ok:false,status:409});
 expect(await publishKnowledgeDoc('local:one')).toMatchObject({ok:false,status:409});
});
it('unconfigured production never fabricates page bodies or successful source mutations',async()=>{
 jest.mocked(sourceConfigured).mockReturnValue(false);
 expect(await getKnowledgeDoc('page:100002')).toBeNull();
 expect(await pullKnowledgeSection('confluence')).toMatchObject({ok:false,status:503});
 expect(await publishKnowledgeDoc('local:one')).toMatchObject({ok:false,status:503});
});
