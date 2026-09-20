import { createHash } from 'node:crypto';
import type { Session } from '../lib/session.js';
import type { CanvasSource } from './document-source.js';
const MAX_ASSET_BYTES=8*1024*1024;
const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
export interface StagedDocumentAsset { filename:string;asset_base64:string;content_type:string;operation_id:string }
/** Resolve only stored gateway upload IDs through the same verified document grant. */
export async function stageDocumentSourceImages(source:CanvasSource,session:Session,markdown:string,stage:(asset:StagedDocumentAsset)=>Promise<void>):Promise<string> {
  const images=[...markdown.matchAll(/!\[[^\]]*\]\(<?([^\s)<>]+)>?(?:\s+"[^"]*")?\)/g)];
  if(!images.some(match=>match[1]!.includes('/api/uploads/'))) return markdown;
  const {connectDocumentCanvas}=await import('./document-canvas.js');
  const access=await connectDocumentCanvas(source,session,true);
  const publicBase=new URL(access.gatewayUrl);if(publicBase.protocol==='wss:')publicBase.protocol='https:';else if(publicBase.protocol==='ws:')publicBase.protocol='http:';
  const internalBase=new URL(process.env['DOCUMENT_GATEWAY_INTERNAL_URL']||access.gatewayUrl);if(internalBase.protocol==='wss:')internalBase.protocol='https:';else if(internalBase.protocol==='ws:')internalBase.protocol='http:';
  const replacements=new Map<string,string>();
  for(const match of images) {
    const raw=match[1]!;
    if(!raw.includes('/api/uploads/')||replacements.has(raw)) continue;
    const candidate=new URL(raw,publicBase);
    if(candidate.origin!==publicBase.origin || !/^\/api\/uploads\/[A-Za-z0-9_-]{1,160}$/.test(candidate.pathname) || candidate.search || candidate.hash || candidate.username || candidate.password) throw new Error('Only document-owned gateway upload URLs can be transferred to the source');
    const response=await fetch(new URL(candidate.pathname,internalBase),{headers:{authorization:`Bearer ${access.token}`},redirect:'error',signal:AbortSignal.timeout(20_000)});
    if(!response.ok) throw new Error('A document image could not be read with the current document permission');
    const contentType=(response.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase();
    const extension=extensions[contentType];
    if(!extension) throw new Error('Source image transfer currently supports PNG, JPEG, GIF, and WebP');
    const chunks:Uint8Array[]=[];let length=0;
    const reader=response.body?.getReader();
    if(!reader) throw new Error('Document image response has no body');
    try { while(true) { const chunk=await reader.read();if(chunk.done) break;length+=chunk.value.length;if(length>MAX_ASSET_BYTES) {await reader.cancel();throw new Error('Document image exceeds the 8 MB source transfer limit');}chunks.push(chunk.value); } }
    finally {reader.releaseLock();}
    const bytes=Buffer.concat(chunks);
    const signatureOk=contentType==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):contentType==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:contentType==='image/gif'?/^GIF8[79]a/.test(bytes.subarray(0,6).toString()):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!signatureOk) throw new Error('Document image bytes do not match their image content type');
    const filename=`canvas-${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    await stage({filename,asset_base64:bytes.toString('base64'),content_type:contentType,operation_id:access.documentId});
    replacements.set(raw,`attachment:${filename}`);
  }
  return markdown.replace(/(!\[[^\]]*\]\()<?([^\s)<>]+)>?((?:\s+"[^"]*")?\))/g,(all,start:string,url:string,end:string)=>replacements.has(url)?`${start}${replacements.get(url)}${end}`:all);
}
