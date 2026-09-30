// Which knowledge sources the collaborative canvas may edit, for a role that
// holds ManageKnowledge. Its own module so the canvas route (and its tests)
// can ask without loading the canvas schema.

export interface EditableSource { id: string; editable?: boolean; classification: string }

/** Local documents and synced pages; and prompts — edited through a draft: the
 * canvas is the prompt's draft, while the published prompt the fleet reads
 * stays the stored Markdown and moves only through its promotion path (never a
 * canvas projection — `readDocumentCanvasProjection` still refuses prompts). */
export function canvasSourceEditable(source: EditableSource): boolean {
  return source.id.startsWith('prompt:') || source.editable === true || source.classification === 'synced';
}
