// One spec for the Knowledge rail, shared by KnowledgeLayout (/admin/knowledge*)
// and IngestLayout (/admin/ingest/*). The five pipeline pages used to fly a
// second rail titled "Knowledge pipeline" with numbered labels ("1 · Sources")
// and a "← Knowledge" back-link, so clicking Sources from the Knowledge rail
// replaced the rail with a differently named one and Overview / Registry
// vanished. Same pages, one rail, one set of words.
import type { SubNavItem } from '@connorhoehn/ui-components/shared';

export const KNOWLEDGE_ITEMS: SubNavItem[] = [
  { path: '/admin/knowledge',          label: 'Overview', group: 'Knowledge' },
  { path: '/admin/knowledge/registry', label: 'Registry', group: 'Knowledge' },
];

// The ingest pipeline, in run order: content is pulled from a source, the run
// is recorded, the result lands in storage, storage is registered as a
// knowledge-base data source, and a schedule keeps it current. hr-admin only:
// /admin/ingest/* routes are hr-admin-gated, so showing these to an
// org-leader gave them five links that all silently bounced to /.
export const PIPELINE_ITEMS: SubNavItem[] = [
  { path: '/admin/ingest/crawl',       label: 'Sources',  group: 'Pipeline' },
  { path: '/admin/ingest/history',     label: 'Runs',     group: 'Pipeline' },
  { path: '/admin/ingest/storage',     label: 'Storage',  group: 'Pipeline' },
  { path: '/admin/ingest/sources',     label: 'KB sync',  group: 'Pipeline' },
  { path: '/admin/ingest/schedules',   label: 'Schedule', group: 'Pipeline' },
];

/** The rail for a role: every role gets Knowledge; only ingest-capable roles get the Pipeline group. */
export function knowledgeItemsFor(role: string | undefined): SubNavItem[] {
  const canIngest = role === 'hr-admin' || role === 'admin';
  // A rail with one group draws no group heading.
  return canIngest
    ? [...KNOWLEDGE_ITEMS, ...PIPELINE_ITEMS]
    : KNOWLEDGE_ITEMS.map(({ group: _group, ...rest }) => rest);
}
