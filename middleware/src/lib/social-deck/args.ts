// The text after `/deck` in a Social conversation. The client parses it only
// to know what to send; the BFF re-reads the text and its answer wins
// (realtime-examples frontend/src/chat/commands/deckCommand.ts:60-93,
// `parseDeckText`, which this narrows to what Social can source).
//
//   /deck [topic] [#initiative:<id> | #work-item:<id> ...] [--from recording:<id>] [--preview]
//
// `--preview` is recognised anywhere in the text. A `#kind:id` token names a
// page (the same two kinds a DM can reference, lib/dm-page-references.ts); the
// BFF resolves it under the caller's current OrgIQ authority and never trusts
// a title from the client. `--from recording:<id>` (what the reference's picker
// writes, deckCommand.ts:167) names a recorded call of THIS conversation;
// a bare `--from transcript` names none and is refused, as the reference
// refuses an ambiguous pick (deckCommand.ts:119-126).

import { dmPageDescriptor } from '../dm-page-references.js';
import type { CallPageDescriptor } from '../call-pages.js';

export const MAX_PAGES = 4;
export const MAX_TOPIC_CHARS = 200;

export interface ParsedDeckArgs {
  /** What the deck is about, flags and page tokens removed. May be empty. */
  topic: string;
  preview: boolean;
  pages: CallPageDescriptor[];
  /** The recorded call whose transcript is the source (slice 7), when named. */
  recordingId: string | null;
}
export type DeckArgsResult = { ok: true; value: ParsedDeckArgs } | { ok: false; error: string };

export function parseDeckArgs(argumentText: string): DeckArgsResult {
  let preview = false;
  const pages: CallPageDescriptor[] = [];
  const kept: string[] = [];
  let recordingId: string | null = null;
  const words = argumentText.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const lowered = word.toLowerCase();
    if (lowered === '--preview') { preview = true; continue; }
    if (lowered === '--from' || lowered.startsWith('--from=')) {
      const raw = lowered.startsWith('--from=') ? word.slice('--from='.length) : words[(i += 1)] ?? '';
      const match = /^recording:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/i.exec(raw);
      if (!match) return { ok: false, error: 'Pick a recording to build from (--from recording:<id>), or leave --from out to use this conversation.' };
      if (recordingId && recordingId !== match[1]) return { ok: false, error: 'Build a deck from one recording at a time.' };
      recordingId = match[1]!;
      continue;
    }
    if (word.startsWith('#') && word.length > 1) {
      const match = /^#(initiative|work-item):(.+)$/.exec(word);
      const page = match ? dmPageDescriptor({ kind: match[1], id: match[2] }) : null;
      if (!page) return { ok: false, error: `"${word.slice(0, 60)}" is not a page this deck can cite. Use #initiative:<id> or #work-item:<id>.` };
      if (!pages.some(p => p.kind === page.kind && p.id === page.id)) pages.push(page);
      continue;
    }
    kept.push(word);
  }
  if (pages.length > MAX_PAGES) return { ok: false, error: `Reference at most ${MAX_PAGES} pages.` };
  const topic = kept.join(' ').trim();
  if (topic.length > MAX_TOPIC_CHARS) return { ok: false, error: `Keep the topic under ${MAX_TOPIC_CHARS} characters.` };
  return { ok: true, value: { topic, preview, pages, recordingId } };
}

/**
 * "Sprint review — the release risks" -> the deck's title. Only an em or en dash
 * ends the title, never a colon (deckCommand.ts:100-110: a time or `key:value`
 * in ordinary text must not truncate it).
 */
export function deckTitleFrom(topic: string, fallback: string): string {
  const match = /^(.+?)\s*(?:—|–)\s*(.+)$/s.exec(topic.trim());
  const named = match?.[1]?.trim();
  if (named) return named.slice(0, 120);
  const words = topic.trim().split(/\s+/).slice(0, 8).join(' ');
  return (words || fallback).slice(0, 120);
}
