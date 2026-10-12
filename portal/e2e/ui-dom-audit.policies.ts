/** Reviewed Pipeline policies; exceptions require positive evidence of the view. */
export type ComposerPolicy = { mode: 'required' } | { mode: 'exempt'; reason: string };
export interface PipelineViewEvidence {
  graph?: boolean;
  communicationOverview?: boolean;
  socialAccessRequired?: boolean;
  configurationForm?: boolean;
  settingsPlaceholder?: boolean;
  missingDeck?: boolean;
}
export function pipelineComposerPolicy(path: string, view: PipelineViewEvidence = {}): ComposerPolicy | undefined {
  const pathname = new URL(path, 'http://audit.local').pathname;
  if (/^\/pipelines(?:\/(?:runs(?:\/[^/]+)?|definitions|runbooks|queues|artifacts|approvals|agents|bots|commands))?$/.test(pathname)) return { mode: 'required' };
  if (pathname === '/pipelines/activity' && view.graph) return { mode: 'exempt', reason: 'The spatial work graph uses its own date, focus and node controls; collection commands are available in Runs.' };
  if (pathname === '/pipelines/communication') {
    if (view.socialAccessRequired) return { mode: 'exempt', reason: 'Social access is unavailable for this viewer; the visible access state explains how to obtain it.' };
    if (view.communicationOverview) return { mode: 'exempt', reason: 'The communication directory has no selected conversation. Selecting a channel or person opens its contextual composer.' };
  }
  if (pathname === '/pipelines/configuration' && view.configurationForm) return { mode: 'exempt', reason: 'This single-setting approval-authority form uses an explicit role selector and Save action, rather than a searchable collection.' };
  if (pathname === '/pipelines/settings' && view.settingsPlaceholder) return { mode: 'exempt', reason: 'The preferences feature is not available yet; the page displays its registration state and exposes no configurable data.' };
  if (/^\/pipelines\/decks\/[^/]+$/.test(pathname)) return view.missingDeck
    ? { mode: 'exempt', reason: 'The report endpoint returned 404 and its load-error view is visible; there is no document to compose against. Loaded report coverage remains separate.' }
    : { mode: 'required' };
  return undefined;
}
