import { KnowledgeExplorer } from './knowledge/KnowledgeExplorer';

// The synced space(s) — page tree, doc view, right-hand activity bar
// (docs/assessment-tenant.md "Workspace page (/workspace)"). Headerless by
// design, same as the source: the explorer's own breadcrumb ("Home ›
// Workspace › <doc>") carries the page identity, so a PageHeader above it
// would only repeat that first crumb.
function WorkspacePage() {
  return <KnowledgeExplorer mode="workspace" />;
}

export default WorkspacePage;
