import { KnowledgeExplorer } from './knowledge/KnowledgeExplorer';

// Every agentic process (the nine slash commands under .claude/commands/) —
// name, argument-hint and body, read-only (docs/assessment-tenant.md
// "Prompts mode lists the 9 command names with their argument-hint and a
// read-only body"). KnowledgeExplorer suppresses the Edit affordance in this
// mode regardless of `doc.editable` — see DocPane's `canEdit`.
function PromptsPage() {
  return <KnowledgeExplorer mode="prompts" />;
}

export default PromptsPage;
