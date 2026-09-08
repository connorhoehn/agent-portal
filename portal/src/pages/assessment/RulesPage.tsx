import { KnowledgeExplorer } from './knowledge/KnowledgeExplorer';

// The guardrail doc itself — root CLAUDE.md, `rule:CLAUDE.md` (the one
// classification collapsed from the source's per-file rule collection; see
// docs/knowledge-library.md "Classifications"). Editable + versioned like
// any other local doc.
function RulesPage() {
  return <KnowledgeExplorer mode="rules" />;
}

export default RulesPage;
