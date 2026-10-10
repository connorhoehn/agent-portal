// Where a document dock send goes, by composer mode. Pure so the contract the
// parity judge states (agent -> drafter, chat -> conversation) is testable.
export type DockSendResult = boolean | Promise<boolean>;

export function routeDockSend(
  mode: string,
  routes: { agentEditable: boolean; agent: () => DockSendResult; chat: () => DockSendResult },
): DockSendResult {
  if (mode === 'agent') return routes.agentEditable ? routes.agent() : false;
  if (mode !== 'chat') return false;
  return routes.chat();
}
