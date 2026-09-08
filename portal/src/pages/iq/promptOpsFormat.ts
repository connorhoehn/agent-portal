// Pure parsing/labeling logic for PromptOpsHomePage, split out so it can be
// unit-tested without mounting the page.

/** `…:prompt/ABC123:1` → { id: 'ABC123', version: '1' } (version '' = DRAFT). */
export function parseArn(arn: string | undefined): { id: string; version: string } {
  const tail = (arn ?? '').split('/').pop() ?? '';
  const [id = '', version = ''] = tail.split(':');
  return { id, version };
}

export function subjectLabel(arn: string | undefined, names: Map<string, string>): string {
  const { id, version } = parseArn(arn);
  if (!id) return '—';
  return `${names.get(id) ?? id} · ${version ? `v${version}` : 'DRAFT'}`;
}

/** `orgiq-search-system-prompt` → `orgiq_search` (the runtime that owns it). */
export function runtimeForSystemPrompt(name: string): string | null {
  const m = /^orgiq-(.+)-system-prompt$/.exec(name);
  return m?.[1] ? `orgiq_${m[1].replace(/-/g, '_')}` : null;
}

/** `orgiq_search` → `orgiq-search-system-prompt` (the library entry it reads). */
export function systemPromptForRuntime(name: string): string {
  return `orgiq-${name.replace(/^orgiq_/, '').replace(/_/g, '-')}-system-prompt`;
}
