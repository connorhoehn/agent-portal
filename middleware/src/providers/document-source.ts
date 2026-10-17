import { sourceMarkdownForCanvas, canvasMarkdownForSource } from './document-source-assets.js';
export { sourceMarkdownForCanvas, canvasMarkdownForSource } from './document-source-assets.js';
import type { Session } from '../lib/session.js';
import { isAllowed } from '../lib/authz.js';
import { advanceDocumentSourceRevision, documentSourceRevision } from './document-mapping.js';

export interface SourceTree { root_page_id: string; pulled_at: string; nodes: Array<{page_id:string; title:string; parent_id:string|null; position:number; has_children:boolean; version:number}> }
export interface SourcePage { markdown:string; source_revision:string; meta:{page_id:string; title:string; parent_id:string|null; last_pulled_at:string; version:number; webui_url?:string}; has_local_edits:boolean }
export interface CanvasSource { id:string; title:string; classification:string; markdown:string; editable?:boolean; source_parent_id?:string|null; published_page_id?:string|null }
export class DocumentSourceError extends Error { constructor(public readonly status:number,message:string) { super(message); } }
export function sourceConfigured():boolean { return Boolean(process.env['ASSESSMENT_SOURCE_URL'] || process.env['ASSESSMENT_SOURCE_SECRET']); }
function configuration() {
  const base=process.env['ASSESSMENT_SOURCE_URL']; const secret=process.env['ASSESSMENT_SOURCE_SECRET'];
  if(!base || !secret?.trim()) throw new DocumentSourceError(503,'Document source is not configured');
  const url=new URL('/api/v1/internal/document-source/operation',base);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new DocumentSourceError(503,'Invalid document source configuration');
  return {url,secret};
}
function pageId(id:string):string {
  const match=/^page:([0-9]+)$/.exec(id);
  if(!match) throw new DocumentSourceError(400,'A synced source page is required');
  return match[1]!;
}
async function request(payload:Record<string,unknown>,asset=false):Promise<any> {
  const {url,secret}=configuration();
  let response:Response;
  try { response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-document-source-key':secret},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(30_000)}); }
  catch { throw new DocumentSourceError(502,'Document source is unavailable; check its recorded state before retrying a mutation'); }
  if(!response.ok) {
    const body=await response.json().catch(()=>({}));
    throw new DocumentSourceError([400,401,403,404,409,503].includes(response.status)?response.status:502,typeof body.detail==='string'?body.detail:'Document source request failed');
  }
  if(asset) {
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>20*1024*1024) throw new DocumentSourceError(502,'Source asset exceeds the supported size');
    return {bytes,contentType:response.headers.get('content-type') || 'application/octet-stream'};
  }
  return response.json();
}
async function requireWriter(session:Session) {
  if(session.tenant!=='assessment'||!await isAllowed(session,'ManageKnowledge')) throw new DocumentSourceError(403,'Document source changes are not authorized');
}
export async function readSourceTree():Promise<SourceTree> { return request({action:'tree',actor:'assessment-reader'}); }
export async function readSourcePage(id:string):Promise<SourcePage> { return request({action:'read',actor:'assessment-reader',page_id:pageId(id)}); }
export async function readSourceAsset(id:string,filename:string):Promise<{bytes:Buffer;contentType:string}> {
  if(!/^[\w][\w. -]*$/.test(filename)||filename.includes('..')) throw new DocumentSourceError(400,'Invalid asset name');
  return request({action:'asset',actor:'assessment-reader',page_id:pageId(id),filename},true);
}
export async function moveSourcePage(id:string,parentId:string,position:number,session:Session):Promise<{ok:true;tree_refresh_failed?:boolean}> {
  await requireWriter(session);
  if(!Number.isSafeInteger(position)||position<0) throw new DocumentSourceError(400,'A nonnegative sibling position is required');
  return request({action:'move',actor:session.sub,page_id:pageId(id),parent_id:pageId(parentId),position});
}
async function projection(source:CanvasSource,session:Session) {
  await requireWriter(session);
  const {readDocumentCanvasProjection}=await import('./document-canvas.js');
  const saved=await readDocumentCanvasProjection(source,session);
  const canonical=source.id.startsWith('page:')?canvasMarkdownForSource(source.id,saved.markdown):saved.markdown;
  const {stageDocumentSourceImages}=await import('./document-source-upload.js');
  const markdown=await stageDocumentSourceImages(source,session,canonical,async asset=>{
    const target=source.id.startsWith('draft:') && !source.published_page_id ? {parent_id:pageId(source.source_parent_id ?? '')} : {page_id:source.published_page_id ?? pageId(source.id)};
    await request({action:'stage-asset',actor:session.sub,...target,...asset});
  });
  return {...saved,markdown};
}
export async function previewSourceChanges(source:CanvasSource,session:Session):Promise<Record<string,unknown>> {
  const saved=await projection(source,session);
  const newPage=source.id.startsWith('draft:') && !source.published_page_id;
  const target=newPage ? {action:'preview-create',parent_id:pageId(source.source_parent_id ?? ''),title:source.title} : {action:'preview',page_id:source.published_page_id ?? pageId(source.id)};
  const changes=await request({...target,actor:session.sub,markdown:saved.markdown,expected_revision:saved.sourceRevision,canvas_version:saved.version});
  return {...changes,canvasVersion:saved.version,sourceRevision:saved.sourceRevision,projectionHash:reviewHash(source,saved.markdown)};
}
function reviewHash(source:CanvasSource,markdown:string):string { return documentSourceRevision(source.id.startsWith('draft:') && !source.published_page_id ? JSON.stringify({markdown,title:source.title,parent:source.source_parent_id}) : markdown); }
export interface ReviewedSourceProjection { canvasVersion?:string; sourceRevision:string; projectionHash:string }
export async function publishSourcePage(source:CanvasSource,session:Session,expected:ReviewedSourceProjection):Promise<Record<string,unknown>> {
  const saved=await projection(source,session);
  if(!expected || expected.sourceRevision!==saved.sourceRevision || expected.projectionHash!==reviewHash(source,saved.markdown)) throw new DocumentSourceError(409,'Document changed after preview; review the latest changes before publishing');
  const newPage=source.id.startsWith('draft:') && !source.published_page_id;
  const target=newPage ? {action:'create',parent_id:pageId(source.source_parent_id ?? ''),title:source.title,operation_id:saved.documentId} : {action:'publish',page_id:source.published_page_id ?? pageId(source.id)};
  const result=await request({...target,actor:session.sub,markdown:saved.markdown,expected_revision:saved.sourceRevision,canvas_version:saved.version});
  if(result.published===true) {
    const revision=typeof result.source_revision==='string' && /^[a-f0-9]{64}$/.test(result.source_revision) ? result.source_revision : null;
    let recorded=false;
    try {
      if(revision) {
        if(newPage) { const {recordDraftPublication}=await import('./document-drafts.js'); recorded=await recordDraftPublication(source.id,saved.documentId,String(result.page_id ?? ''),saved.sourceRevision,revision); }
        else recorded=await advanceDocumentSourceRevision(saved.documentId,saved.sourceRevision,revision);
      }
    } catch { /* Remote publish succeeded: never report this as safe to repeat. */ }
    if(!recorded) return {...result,reconciliation_needed:true,warning:'Published remotely; document baseline could not be recorded. Refresh before another publication.'};
  }
  return result;
}
export async function pullSourcePage(source:CanvasSource,session:Session):Promise<Record<string,unknown>> {
  const saved=await projection(source,session);
  // Pull cannot silently replace collaborative edits. Return new source as a
  // review candidate; applying it to the binary requires a separate explicit merge.
  if(documentSourceRevision(saved.markdown)!==saved.sourceRevision) {
    // Schema conversion can normalize harmless Markdown whitespace. Compare to
    // the same canvas projection of the exact imported source before declaring
    // a conflict; never compare to a newer upstream body as the baseline.
    if(documentSourceRevision(source.markdown)!==saved.sourceRevision) throw new DocumentSourceError(409,'Source baseline changed; review before pulling');
    const [{createCanvasSeed,exportCanvasProjection},{documentCanvasSchema}]=await Promise.all([import('@connorhoehn/realtime-modules/server'),import('../lib/document-canvas-schema.js')]);
    const baselineSeed=createCanvasSeed(sourceMarkdownForCanvas(source.id,source.markdown),{schema:documentCanvasSchema});
    const baseline=canvasMarkdownForSource(source.id,exportCanvasProjection(baselineSeed.snapshot).markdown);
    if(saved.markdown!==baseline) throw new DocumentSourceError(409,'Document has collaborative edits; publish or review them before pulling');
  }
  const result=await request({action:'pull',actor:session.sub,page_id:pageId(source.id),expected_revision:saved.sourceRevision});
  return {...result,canvas_reconciliation_required:result.source_revision!==saved.sourceRevision};
}
