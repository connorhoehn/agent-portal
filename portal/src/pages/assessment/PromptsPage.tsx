import { KnowledgeExplorer } from './knowledge/KnowledgeExplorer';

// Every agentic process (the nine slash commands under .claude/commands/) —
// name, argument-hint and body, in the same canvas editor as every other
// document page. A role that may edit (ManageKnowledge) edits a prompt through
// a draft (docs/assessment-documents-parity-goal.md decision 7): the published
// prompt the fleet reads changes only through its promotion path. Rename,
// move and New page stay off in this mode, and the server refuses a prompt
// rename (409).
function PromptsPage() {
  return <KnowledgeExplorer mode="prompts" />;
}

export default PromptsPage;
