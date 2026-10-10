import type { Plugin } from 'vite';

/** The command chip replaces its typed trigger visually, while the document
 * retains the trigger for execution, draft persistence and undo. The pinned
 * library hid it only for commands with a selected argument or inline layout. */
export function patchSharedComposer(source: string, id: string): string | null {
  id = id.split('?')[0]!;
  if (!id.includes('/@connorhoehnslalom/ui-components/dist/') || !/\/RichChatComposer-[^/]+\.js$/.test(id)) return null;
  const start = source.indexOf('function wa(e, t, n, r = !1) {');
  const end = source.indexOf('\nvar Ta = ', start);
  if (start < 0 || end < 0) throw new Error('Shared composer prefix patch needs review for this library build');
  let body = source.slice(start, end);
  for (const [before, after] of [
    ['\n\tif (!n && !r) return null;', ''],
    ['} else if (r) s = a.length - a.trimStart().length + o.trigger.length;\n\telse return null;',
      '} else s = a.length - a.trimStart().length + o.trigger.length;'],
  ]) {
    if (body.split(before).length !== 2) throw new Error('Shared composer command-prefix structure changed');
    body = body.replace(before, after);
  }
  const next = source.slice(0, start) + body + source.slice(end);
  // A hidden command-prefix decoration reports a zero-size rectangle at
  // (0, 0). Anchor that suggestion to its visible editor rather than the
  // window corner. A real caret (zero width, positive height) remains exact.
  const anchor = '\t\tplace(r, i) {\n\t\t\tif (!e || !r) return;';
  if (next.split(anchor).length !== 2) throw new Error('Shared composer suggestion-position structure changed');
  return next.replace(anchor, '\t\tplace(r, i) {\n\t\t\tif (r && r.width === 0 && r.height === 0) r = i?.getBoundingClientRect() ?? r;\n\t\t\tif (!e || !r) return;');
}

export function sharedComposer(): Plugin {
  return { name: 'work-shared-composer', enforce: 'pre', transform(source, id) {
    const code = patchSharedComposer(source, id);
    return code === null ? null : { code, map: null };
  } };
}
