// Editorial display names for the original library. Match the source title,
// not an ID: a user-authored rename must always win. Full text stays in the
// version and clipboard; these labels are used by navigation and reading chrome.
const TITLES: Readonly<Record<string, string>> = {
  'Bring SSO up on a new origin without breaking the picker': 'SSO setup for a new origin',
  'Cut one tenant over from SAML to Cognito': 'SAML to Cognito migration',
  'Release a packed-tarball library and move every consumer pin to it': 'Library release and consumer updates',
  'Write a journey map, walk it as a clone and seal its log': 'Journey validation',
  "Call the gateway's presence API with the captured client": 'Gateway presence API',
  "Debug a websocket app's traffic over the DevTools protocol": 'WebSocket debugging',
  'Get an auth-service pull request through the CSRF check': 'CSRF checks for authentication changes',
};

export function runbookDisplayTitle(title: string): string {
  return TITLES[title.trim()] ?? title.trim();
}

/** Reading-only header. Stored markdown and its checksum remain unchanged. */
export function runbookReadingMarkdown(markdown: string): string {
  return markdown.replace(/^# (.+)$/m, (_, title: string) => `# ${runbookDisplayTitle(title)}`);
}

export function briefReadingMarkdown(markdown: string): string {
  return markdown
    .replace(/^# Session brief[^\n]*\n+(?:> Assembled[^\n]*\n+)?/, '# Session brief\n\n')
    .replace(/^(## Your task)\n\*\*(.+?)\*\*([^\n]*)\n/m, (_all, section: string, title: string, meta: string) => `${section}\n\n### ${title}\n\n_${meta.trim()}_\n\n`)
    .replace(/\n(Labels: [^\n]+)/, '\n\n_$1_')
    .replace(/^(## The project)\n\*\*(.+?)\*\* — ([^\n]*)/m, '$1\n\n### $2\n\n_$3_');
}
