// Edits made on the slide itself (PresentationEditor's regions, ui-components 2.550.0) are saved as they happen: each
// one is sent to the deck's operations route as one small operation on the saved head, and the revision it writes
// becomes the editor's base. The editor has already applied the edit to its draft, so the picture shows it at once
// (the library's overlay holds the new words until the next preview lands).
//
// An edit is sent only while the saved head is in view and the slide is already saved; otherwise (an older version
// open, a slide added and not saved yet) it stays in the draft for Save, like any other edit. Removing a row needs no
// confirm: the person clicked Remove on that row. Undo and the version list keep working: undo edits the draft, and
// every operation is a version.

import { useCallback, useEffect, useRef } from 'react';
import { applyDeckOperations, type DeckOperation, type DeckSpec, type DeckTenantId } from './deckApi';

export type DeckStyleName = 'bold' | 'editorial' | 'minimal' | 'playful' | 'corporate';
const STYLES: readonly DeckStyleName[] = ['bold', 'editorial', 'minimal', 'playful', 'corporate'];
const BUILTINS = ['product', 'engineering', 'plain'];

/** The deck's style, read from its theme reference `{ ref: '<base>-<style>' }`; without one, its theme's own. */
export function deckStyleOf(theme: DeckSpec['theme']): DeckStyleName {
  const ref = typeof theme === 'object' && theme && 'ref' in theme ? String(theme.ref) : typeof theme === 'string' ? theme : '';
  const m = /^(.+)-([a-z]+)$/.exec(ref);
  if (m && (STYLES as readonly string[]).includes(m[2]!)) return m[2] as DeckStyleName;
  return ref === 'plain' ? 'minimal' : 'bold';
}

/** The same theme in `style`, as the server's `set_style` writes it. */
export function withDeckStyle(theme: DeckSpec['theme'], style: DeckStyleName, tenant: DeckTenantId): NonNullable<DeckSpec['theme']> {
  const ref = typeof theme === 'object' && theme && 'ref' in theme ? String(theme.ref) : typeof theme === 'string' ? theme : undefined;
  const m = ref ? /^(.+)-([a-z]+)$/.exec(ref) : null;
  const base = m && (STYLES as readonly string[]).includes(m[2]!) ? m[1]! : ref;
  return { ref: `${base && (BUILTINS.includes(base) || base === tenant) ? base : base === undefined ? 'product' : tenant}-${style}` };
}

/** Starter words for a new row's required fields: the format refuses a blank title, label or name. */
const STARTER: Record<string, string> = { title: 'New item', label: 'New stage', name: 'New person', role: 'Role', value: '0', date: 'Date', text: 'New point' };

/** A row the editor just added, its blank required words filled; optional blanks dropped. */
function filledRow(row: unknown): unknown {
  if (typeof row === 'string') return row.trim() ? row : 'New point';
  if (Array.isArray(row)) return row.map((cell) => (typeof cell === 'string' && !cell.trim() ? '–' : cell));
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (typeof v === 'string' && !v.trim()) { if (STARTER[k] && k !== 'text') out[k] = STARTER[k]; }
    else out[k] = v;
  }
  return out;
}

/** The list at `list` on a slide (`items`, `table.rows`, `comparison.left.points`). */
function listAt(slide: Record<string, unknown>, list: string): unknown[] | null {
  let at: unknown = slide;
  for (const key of list.replace(/\[(\d+)\]/g, '.$1').split('.')) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  return Array.isArray(at) ? at : null;
}

/** The slide field a row list lives under: `table.rows` is `table`, `bullets` is `bullets`. */
const topField = (list: string): string => list.split(/[.[]/)[0]!;

interface InPlaceInput {
  tenant: DeckTenantId;
  deckId: string;
  /** The saved head, when it is the version in view; null otherwise. */
  head: string | null;
  /** The saved spec the head holds. */
  savedSpec: DeckSpec | null;
  /** The draft after the editor applied its edit. */
  latestSpec: () => DeckSpec | null;
  adoptRevision: (id: string) => Promise<void>;
  /** Replace the draft (a new row's blank words filled with starter words). */
  setDraft: (spec: DeckSpec) => void;
  onError: (message: string | null) => void;
}

export function useDeckInPlaceEdits(input: InPlaceInput) {
  const ref = useRef(input);
  ref.current = input;
  const chain = useRef<Promise<void>>(Promise.resolve());
  // The newest base: the head in view, then each revision an edit writes before the page catches up.
  const base = useRef<string | null>(input.head);
  useEffect(() => { base.current = input.head; }, [input.head]);

  const send = useCallback((slideId: string | null, op: DeckOperation, label: string) => {
    const { head, savedSpec } = ref.current;
    if (!head || !savedSpec || (slideId && !savedSpec.slides.some((s) => s.id === slideId))) return;
    chain.current = chain.current.then(async () => {
      const now = ref.current;
      const baseRevisionId = base.current ?? now.head;
      if (!baseRevisionId) return;
      try {
        const out = await applyDeckOperations(now.tenant, now.deckId, { baseRevisionId, operations: [op], label });
        base.current = out.revision.id;
        now.onError(null);
        await now.adoptRevision(out.revision.id);
      } catch (error) {
        // The draft keeps the edit; Save writes it.
        now.onError(`That edit is not saved yet: ${error instanceof Error ? error.message : 'the server refused it'}. Save keeps it.`);
      }
    });
  }, []);

  const fieldOf = (slideId: string, list: string): DeckOperation | null => {
    const slide = ref.current.latestSpec()?.slides.find((s) => s.id === slideId) as unknown as Record<string, unknown> | undefined;
    const field = topField(list);
    return slide && field in slide ? { op: 'set_fields', slideId, fields: { [field]: slide[field] } } : null;
  };

  return {
    onRegionEdit: (slideId: string, path: string, value: unknown) => {
      // A decoration is sent from the editor's onDecorationChange (`onDecoration`).
      if (path === 'decoration') return;
      send(slideId, { op: 'set_path', slideId, path, value: value ?? null }, 'Edited on the slide');
    },
    onRowChange: (slideId: string, list: string, added?: number) => {
      if (added !== undefined) {
        // A new row starts with starter words, so the saved deck stays valid; the person types over them in place.
        const spec = ref.current.latestSpec();
        const next = spec ? structuredClone(spec) : null;
        const slide = next?.slides.find((s) => s.id === slideId) as unknown as Record<string, unknown> | undefined;
        const rows = slide ? listAt(slide, list) : null;
        if (next && rows && added < rows.length) { rows[added] = filledRow(rows[added]); ref.current.setDraft(next); }
      }
      const op = fieldOf(slideId, list);
      if (op) send(slideId, op, 'Edited on the slide');
    },
    onDecoration: (slideId: string, decoration: unknown) => send(slideId, { op: 'set_decoration', slideId, decoration: (decoration ?? null) as 'none' | null | { graphic: string } }, 'Edited on the slide'),
    onStyle: (style: DeckStyleName) => send(null, { op: 'set_style', style }, `Style: ${style}`),
  };
}
