// Editorial display names for the original library. Match the source title,
// not an ID: a user-authored rename must always win. Full text stays in the
// version and clipboard; these labels are used by navigation and reading chrome.
const TITLES: Readonly<Record<string, string>> = {
  'Propose an idle-capacity teardown that gets approved': 'Idle capacity teardown',
  'Bring SSO up on a new origin without breaking the picker': 'SSO setup for a new origin',
  'Tell a flaky test from a real regression': 'Flaky test investigation',
  'Cut one tenant over from SAML to Cognito': 'SAML to Cognito migration',
  'Release a packed-tarball library and move every consumer pin to it': 'Library release and consumer updates',
  'Write a journey map, walk it as a clone and seal its log': 'Journey validation',
  "Call the gateway's presence API with the captured client": 'Gateway presence API',
  'Deploy a Mac-built image to Fargate without exec format errors': 'ARM64 image deployment to Fargate',
  'Wake a cold Aurora Data API and retry the first call': 'Aurora cold start recovery',
  'Ingest a document into the knowledge base after a PII scan': 'Document ingestion and PII review',
  "Debug a websocket app's traffic over the DevTools protocol": 'WebSocket debugging',
  'Get an auth-service pull request through the CSRF check': 'CSRF checks for authentication changes',
  "Move one service's metrics off StatsD without losing an alert": 'StatsD migration',
  'Verify a dependency pin bump against what is actually installed': 'Dependency update verification',
  'Tell "stack healthy" from "service serving" on ECS Fargate': 'ECS service readiness',
  "Pin a Bedrock knowledge base's search type and prove the ranking order": 'Knowledge base search validation',
  'Deploy container runtimes after their repositories have images': 'Container runtime deployment',
  "Prove an agent's spans actually export (ADOT, not vanilla OTel)": 'Agent trace export',
  'Reach a load balancer when a custodian keeps closing its security group': 'Load balancer access',
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
