/** Rewrite only the configured source's attachment convention, never fetch an arbitrary URL. */
export function sourceMarkdownForCanvas(id:string,markdown:string):string {
  if (!/^page:[0-9]+$/.test(id)) throw new Error('A synced source page is required');
  return markdown.replace(/attachment:([^\s)<>]+)/g,(_all,name:string)=>`/api/assessment/knowledge/source/asset?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`);
}
export function canvasMarkdownForSource(id:string,markdown:string):string {
  if (!/^page:[0-9]+$/.test(id)) throw new Error('A synced source page is required');
  return markdown.replace(/\/api\/assessment\/knowledge\/source\/asset\?id=([^&\s)<>]+)&name=([^\s)<>]+)/g,(all,source:string,name:string)=>{
    try { return decodeURIComponent(source)===id ? `attachment:${decodeURIComponent(name)}` : all; } catch { return all; }
  });
}
