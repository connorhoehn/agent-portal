/** The Details shortcut belongs to the page, never to a text-editing control. */
export function isDetailsShortcut(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented' | 'target'> & Partial<Pick<KeyboardEvent, 'composedPath'>>): boolean {
  if (!event.shiftKey || event.key.toLowerCase() !== 'i' || event.ctrlKey || event.metaKey || event.altKey
    || event.repeat || event.isComposing || event.defaultPrevented) return false;
  const path = event.composedPath?.() ?? [event.target];
  return !path.some(target => {
    if (!target || typeof target !== 'object') return false;
    const node = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => Element | null };
    return node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(node.tagName ?? '')
      || !!node.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-keyboard-shortcuts="off"]');
  });
}
