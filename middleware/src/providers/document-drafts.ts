import { randomUUID } from 'node:crypto';
import type { Session } from '../lib/session.js';
import { isAllowed } from '../lib/authz.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { knowledgeDocs, knowledgeSections, type KnowledgeDoc } from '../mock/assessment.js';
import { withTransaction } from './aurora.js';
import { documentSourceRevision, ensureDocumentMapping } from './document-mapping.js';
import { DocumentSourceError, readSourceTree, sourceConfigured } from './document-source.js';
import { assessmentBroker } from '../lib/assessment-broker.js';
export interface CreateDocumentDraft { title:string;sectionKey:string;parentId?:string|null;sourceParentId?:string }
const str=(name:string,value:string|null)=>({name,value:value===null?{isNull:true as const}:{stringValue:value}});
export async function createDocumentDraft(input:CreateDocumentDraft,session:Session) {
  if(session.tenant!=='assessment'||!await isAllowed(session,'ManageKnowledge')) throw new DocumentSourceError(403,'Draft creation is not authorized');
  const title=input.title?.trim();
  if(!title||title.length>240) throw new DocumentSourceError(400,'A title of 1–240 characters is required');
  if(!input.sectionKey || input.sectionKey==='prompts') throw new DocumentSourceError(400,'An editable local section is required');
  if(input.sourceParentId) {
    if(!sourceConfigured()) throw new DocumentSourceError(503,'Document source is not configured');
    const parent=/^page:([0-9]+)$/.exec(input.sourceParentId)?.[1];
    if(!parent || !(await readSourceTree()).nodes.some(node=>node.page_id===parent)) throw new DocumentSourceError(400,'Source parent is outside the configured tree');
  }
  const id=`draft:${randomUUID()}`; const now=config.mock.aurora ? clock.nowIso() : new Date().toISOString();
  const doc:KnowledgeDoc={id,title,classification:'internal',markdown:'',editable:true,path:`drafts/${id.slice(6)}.md`,updated_at:now,source_parent_id:input.sourceParentId ?? null,published_page_id:null};
  const parentId=input.parentId ?? null;
  let documentId:string;
  if(config.mock.aurora) {
    const section=knowledgeSections().find(row=>row.key===input.sectionKey && row.kind==='local');
    if(!section || (parentId && !section.nodes.some(node=>node.id===parentId && node.editable!==false))) throw new DocumentSourceError(400,'Draft parent must belong to an editable local section');
    const mapping=await ensureDocumentMapping(id,documentSourceRevision(doc.markdown),session.sub);
    documentId=mapping.document_id;
    knowledgeDocs().push(doc);
    section.nodes.push({id,title,parent_id:parentId,is_dir:false,classification:'internal',editable:true,viewable:true,updated_at:now});
  } else {
    documentId=await withTransaction(async tx=>{
      if(input.sectionKey==='workspace_drafts') await tx("INSERT INTO assessment_knowledge_sections (key,title,kind,position) VALUES ('workspace_drafts','Workspace drafts','local',50) ON CONFLICT (key) DO NOTHING");
      const sections=await tx('SELECT key FROM assessment_knowledge_sections WHERE key = :section AND kind = :kind FOR UPDATE',[str('section',input.sectionKey),str('kind','local')]);
      if(!sections.length) throw new DocumentSourceError(400,'An editable local section is required');
      if(parentId) {
        const parents=await tx('SELECT id FROM assessment_knowledge_nodes WHERE id = :parent AND section_key = :section AND editable IS DISTINCT FROM FALSE FOR UPDATE',[str('parent',parentId),str('section',input.sectionKey)]);
        if(!parents.length) throw new DocumentSourceError(400,'Draft parent must belong to the selected local section');
      }
      await tx(`INSERT INTO assessment_knowledge_nodes (id,section_key,parent_id,title,is_dir,classification,editable,viewable,position,updated_at)
        VALUES (:id,:section,:parent,:title,FALSE,'internal',TRUE,TRUE,(SELECT COALESCE(MAX(position),-1)+1 FROM assessment_knowledge_nodes WHERE section_key=:section AND parent_id IS NOT DISTINCT FROM :parent),CAST(:now AS timestamptz))`,[str('id',id),str('section',input.sectionKey),str('parent',parentId),str('title',title),str('now',now)]);
      await tx(`INSERT INTO assessment_knowledge_docs (id,title,classification,path,markdown,editable,updated_at,source_parent_id,published_page_id)
        VALUES (:id,:title,'internal',:path,'',TRUE,CAST(:now AS timestamptz),:sourceParent,NULL)`,[str('id',id),str('title',title),str('path',doc.path),str('now',now),str('sourceParent',doc.source_parent_id ?? null)]);
      return (await ensureDocumentMapping(id,documentSourceRevision(doc.markdown),session.sub,tx)).document_id;
    });
  }
  assessmentBroker.publish({type:'knowledge.doc.saved',id,stamp:now,by:session.sub,ts:now});
  return {ok:true as const,id,documentId,title};
}
