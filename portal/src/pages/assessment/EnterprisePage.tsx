import { KnowledgeExplorer } from './knowledge/KnowledgeExplorer';

// The local enterprise-context tree — reference + template docs
// (docs/assessment-tenant.md). KnowledgeExplorer renders the "Related" rail
// of jump links (Workspace/Prompts/Rules/Teams) under the tree in this mode.
function EnterprisePage() {
  return <KnowledgeExplorer mode="enterprise" />;
}

export default EnterprisePage;
