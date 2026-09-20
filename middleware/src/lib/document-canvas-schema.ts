import { createRequire } from 'node:module';

// Realtime's adapters ship CJS. Resolve all headless TipTap nodes through that
// same entry graph: mixing its CJS declarations with ESM declarations creates
// two incompatible Editor types even when both resolve to the same version.
const require = createRequire(import.meta.url);
const { getSchema } = require('@tiptap/core') as typeof import('@tiptap/core', { with: { 'resolution-mode': 'require' } });
const { StarterKit } = require('@tiptap/starter-kit') as typeof import('@tiptap/starter-kit', { with: { 'resolution-mode': 'require' } });
const { TaskList } = require('@tiptap/extension-task-list') as typeof import('@tiptap/extension-task-list', { with: { 'resolution-mode': 'require' } });
const { TaskItem } = require('@tiptap/extension-task-item') as typeof import('@tiptap/extension-task-item', { with: { 'resolution-mode': 'require' } });
const { Image } = require('@tiptap/extension-image') as typeof import('@tiptap/extension-image', { with: { 'resolution-mode': 'require' } });
const { TableKit } = require('@tiptap/extension-table') as typeof import('@tiptap/extension-table', { with: { 'resolution-mode': 'require' } });
const { TextStyleKit } = require('@tiptap/extension-text-style') as typeof import('@tiptap/extension-text-style', { with: { 'resolution-mode': 'require' } });
const { createCanvasExtensions, MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign } = require('@connorhoehnslalom/realtime-modules/adapters/tiptap') as typeof import('@connorhoehnslalom/realtime-modules/adapters/tiptap');

/** Same nodes as CanvasDocumentView; no DOM or editor instance. */
export const documentCanvasSchema = getSchema([
  StarterKit.configure({ undoRedo: false }), TaskList, TaskItem.configure({ nested: true }),
  ...createCanvasExtensions({ MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign, TextStyleKit, Image, TableKit }),
]);
