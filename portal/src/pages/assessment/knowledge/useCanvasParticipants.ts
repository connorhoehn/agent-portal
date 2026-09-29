// Who else is on the page, from the canvas's own awareness — the shell byline
// (`EditorShell participants`), jump-to (`onParticipantClick`) and follow
// (`onFollowParticipant` + the library `FollowModeBar`), as realtime-examples'
// page editor wires them. Awareness is the source because it is the socket the
// page is actually editing on: the per-document `knowledge.presence` roster
// (the rail's section presence) says who has the document open, not where
// their caret is.
//
// A peer's caret is the Y.js relative position realtime-modules' editor
// writes to awareness (`cursor.head`); jumping resolves it against this
// editor's ySync binding and scrolls it into view. Following re-jumps
// whenever their awareness changes, until the bar's Stop or a scroll of your
// own (FollowModeBar autoStop).

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import type { Editor } from '@tiptap/react';
import { awarenessPeople, type AwarenessPerson } from './documentCommentsModel';
import { live } from './useCanvasComments';

interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  on(event: 'change', handler: () => void): void;
  off(event: 'change', handler: () => void): void;
}

/** Scroll the editor to where this person's caret is. False when they have none on the page. */
function jumpTo(editor: Editor | null, awareness: AwarenessLike | null, person: AwarenessPerson): boolean {
  if (!live(editor) || !awareness) return false;
  const ystate = ySyncPluginKey.getState(editor.view.state) as { doc?: Y.Doc; type?: Y.XmlFragment; binding?: { mapping: unknown } } | undefined;
  if (!ystate?.doc || !ystate.type || !ystate.binding) return false;
  const states = awareness.getStates();
  for (const clientId of person.clientIds) {
    const cursor = (states.get(clientId) as { cursor?: { head?: unknown } } | undefined)?.cursor;
    if (!cursor?.head) continue;
    try {
      const pos = relativePositionToAbsolutePosition(ystate.doc, ystate.type, Y.createRelativePositionFromJSON(cursor.head),
        ystate.binding.mapping as Parameters<typeof relativePositionToAbsolutePosition>[3]);
      if (pos == null) continue;
      const { node } = editor.view.domAtPos(pos);
      const element = node instanceof HTMLElement ? node : node.parentElement;
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    } catch { /* the binding is not ready yet */ }
  }
  return false;
}

export function useCanvasParticipants(editor: Editor | null, awareness: AwarenessLike | null, selfUserId: string) {
  const [people, setPeople] = useState<AwarenessPerson[]>([]);
  const [following, setFollowing] = useState<string | null>(null);
  useEffect(() => {
    if (!awareness) { setPeople([]); return; }
    const sync = () => setPeople(previous => {
      const next = awarenessPeople(awareness.getStates().entries(), selfUserId);
      return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
    });
    sync();
    awareness.on('change', sync);
    return () => awareness.off('change', sync);
  }, [awareness, selfUserId]);

  // Following: re-jump on every awareness change of the person followed.
  useEffect(() => {
    if (!following || !awareness) return;
    const person = () => people.find(p => p.id === following);
    const follow = () => { const p = person(); if (p) jumpTo(editor, awareness, p); };
    follow();
    awareness.on('change', follow);
    return () => awareness.off('change', follow);
  }, [following, awareness, editor, people]);
  // Someone who leaves cannot be followed.
  useEffect(() => { if (following && !people.some(p => p.id === following)) setFollowing(null); }, [people, following]);

  const participants = useMemo(() => people.map(p => ({ id: p.id, name: p.name, online: true, ...(p.color ? { color: p.color } : {}) })), [people]);
  // FollowModeBar speaks the editor's Participant shape.
  const followBarParticipants = useMemo(() => people.map(p => ({
    clientId: String(p.clientIds[0] ?? p.id), userId: p.id, displayName: p.name, color: p.color ?? '#0d9488',
    mode: 'editor' as const, currentSectionId: null,
  })), [people]);
  const onParticipantClick = useCallback((id: string) => {
    const person = people.find(p => p.id === id);
    if (person) jumpTo(editor, awareness, person);
  }, [people, editor, awareness]);
  const onFollowParticipant = useCallback((id: string) => setFollowing(current => (current === id ? null : id)), []);
  return { people, participants, followBarParticipants, following, onParticipantClick, onFollowParticipant, stopFollowing: () => setFollowing(null) };
}
