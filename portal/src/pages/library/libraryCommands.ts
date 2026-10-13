// The Agent library's bounded command grammar: search, the Kind facet, refresh
// and opening one asset by exact id or name. No React — testable under
// node:test. Nothing here edits, promotes or retires an asset.
import type { CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import { KIND_LABEL, KIND_ORDER } from './libraryFormat.ts';
import type { LibraryAsset } from './types';

/** `show skill assets`, `filter evaluator`, `show system prompt assets` … — the Kind select's options. */
export const LIBRARY_GRAMMAR: CollectionGrammar = {
  noun: 'assets',
  filters: Object.fromEntries(KIND_ORDER.map((kind) => [KIND_LABEL[kind].toLowerCase(), kind])),
};

/** The rows `open` may resolve: the assets the table currently shows. */
export const libraryTargets = (assets: readonly LibraryAsset[]) => assets.map((asset) => ({ id: asset.id, title: asset.name }));
