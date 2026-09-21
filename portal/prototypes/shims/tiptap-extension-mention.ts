// A stand-in for `@tiptap/extension-mention`, for prototypes only.
//
// `RichChatComposer` (ui-components/social/rich-composer) imports the real
// extension, which is a peer the portal does not install — the app never
// mounts the rich composer. Vite then externalizes it, and the built page
// throws `Could not resolve "@tiptap/extension-mention"` on load: a blank
// screen for a missing @-mention feature nobody was sketching.
//
// This is the smallest node that satisfies the composer: a mention is an
// inline atom that renders as `@label`. Typing `@` in a prototype will NOT
// open a people menu — that is the trade. The moment a prototype needs real
// mentions, add the peer to portal/package.json and delete the alias in
// vite.prototype.config.ts; nothing else changes.
import { Node, mergeAttributes } from '@tiptap/core';

export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,
  addOptions() {
    return { HTMLAttributes: {}, renderText: ({ node }: { node: { attrs: { label?: string; id?: string } } }) => `@${node.attrs.label ?? node.attrs.id ?? ''}` };
  },
  addAttributes() {
    return { id: { default: null }, label: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-mention': '' }, this.options.HTMLAttributes, HTMLAttributes), `@${node.attrs.label ?? node.attrs.id ?? ''}`];
  },
  renderText({ node }) {
    return `@${node.attrs.label ?? node.attrs.id ?? ''}`;
  },
});

export default Mention;
