/** What the private card's frame says it is waiting for (a `localMessages` `note`). */
export const heldRunNote = (kind: 'summary' | 'diagram' | 'doc' | 'agent'): string =>
  kind === 'agent' ? 'Only you can see this. Nothing runs until you approve the plan.'
    : `Only you can see this. ${kind === 'summary' || kind === 'diagram' ? 'Post it when it is ready.' : 'Save it as a document when it is ready.'}`;
