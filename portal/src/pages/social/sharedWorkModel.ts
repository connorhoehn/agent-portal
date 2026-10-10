// What has been shared INTO one conversation, as the BFF sends it
// (docs/communication-plane-goal.md §2; middleware lib/work-graph/shared-work.ts
// `SharedWorkItem` — the ONE shared-work notion). Every row arrives already
// folded through this reader's authority on the server: a page reference the
// reader may not open, or a deck whose file they may not download, comes back
// `unavailable` with no title. This module only reads the wire defensively and
// names the row's kind; nothing is derived from the thread or a stored title
// here. No React, so `__tests__/sharedWorkModel.test.ts` runs under plain
// `node --test`.

export type SharedWorkKind = 'initiative' | 'work-item' | 'work-node' | 'deck' | 'file';
export type SharedWorkProvenance = 'grant:active' | 'grant:historical' | 'reference' | 'deck' | 'attachment';

export interface SharedWorkItem {
  kind: SharedWorkKind;
  id: string;
  /** null when the reader may not read the thing itself (the row still says it was shared). */
  title: string | null;
  status: 'available' | 'unavailable';
  href: string | null;
  sharedBy: { userId: string; displayName: string } | null;
  sharedInto: { kind: 'conversation' | 'team'; id: string; title: string | null };
  at: string | null;
  authority: 'grant' | 'membership';
  provenance: SharedWorkProvenance;
  ref: { messageId?: string; grantId?: string; fileId?: string; fileName?: string; nodeKind?: string };
  /** One stable row key. */
  key: string;
}

export interface SharedWorkReply { conversation: string; title: string | null; items: SharedWorkItem[]; limits: string[] }

/** A message as the surface's thread hands it to the view (only its arrival refetches the list). */
export interface SharedWorkMessage { id?: string; userId?: string; timestamp?: string; metadata?: Record<string, unknown> }

const KINDS = new Set<string>(['initiative', 'work-item', 'work-node', 'deck', 'file']);
const PROVENANCE = new Set<string>(['grant:active', 'grant:historical', 'reference', 'deck', 'attachment']);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** `GET <api>/conversations/:id/shared-work`. */
export const sharedWorkUrl = (api: string, channel: string): string => `${api}/conversations/${encodeURIComponent(channel)}/shared-work`;

export function readSharedWork(raw: unknown): SharedWorkReply | null {
  const r = obj(raw);
  const conversation = text(r?.['conversation']);
  if (!r || !conversation || !Array.isArray(r['items'])) return null;
  const items = r['items'].flatMap((row): SharedWorkItem[] => {
    const it = obj(row);
    const kind = text(it?.['kind']), id = text(it?.['id']), provenance = text(it?.['provenance']);
    const into = obj(it?.['sharedInto']);
    const intoKind = into?.['kind'], intoId = text(into?.['id']);
    if (!it || !kind || !KINDS.has(kind) || !id || !provenance || !PROVENANCE.has(provenance) || (intoKind !== 'conversation' && intoKind !== 'team') || !intoId) return [];
    const by = obj(it['sharedBy']);
    const byId = text(by?.['userId']);
    const ref = obj(it['ref']) ?? {};
    const status = it['status'] === 'available' ? 'available' : 'unavailable';
    const refOut: SharedWorkItem['ref'] = {};
    for (const k of ['messageId', 'grantId', 'fileId', 'fileName', 'nodeKind'] as const) { const v = text(ref[k]); if (v) refOut[k] = v; }
    return [{
      kind: kind as SharedWorkKind, id, title: status === 'available' ? text(it['title']) : null, status, href: status === 'available' ? text(it['href']) : null,
      sharedBy: byId ? { userId: byId, displayName: text(by?.['displayName']) ?? byId } : null,
      sharedInto: { kind: intoKind, id: intoId, title: text(into?.['title']) },
      at: text(it['at']), authority: it['authority'] === 'grant' ? 'grant' : 'membership', provenance: provenance as SharedWorkProvenance, ref: refOut,
      key: `${kind}:${id}:${refOut.messageId ?? refOut.grantId ?? refOut.fileId ?? ''}`,
    }];
  });
  return { conversation, title: text(r['title']), items, limits: Array.isArray(r['limits']) ? r['limits'].filter((l): l is string => typeof l === 'string') : [] };
}

/** The kind word a row leads with. */
export function sharedKindLabel(item: Pick<SharedWorkItem, 'kind' | 'ref'>): string {
  switch (item.kind) {
    case 'initiative': return 'Initiative';
    case 'work-item': return 'Work item';
    case 'deck': return 'Deck';
    case 'file': return 'File';
    default: return item.ref.nodeKind ? item.ref.nodeKind.charAt(0).toUpperCase() + item.ref.nodeKind.slice(1) : 'Work';
  }
}

/** Why a row cannot be opened, in the reader's terms. */
export function sharedUnavailableReason(item: Pick<SharedWorkItem, 'kind'>): string {
  return item.kind === 'deck' ? 'Its file is not one you can open here.' : 'You cannot open this page now.';
}

/** The row's second line: how it reached you and who shared it. */
export function sharedRowLine(item: SharedWorkItem): string {
  const how = item.provenance === 'grant:historical' ? 'shared earlier' : item.provenance === 'grant:active' ? 'shared now' : null;
  return [sharedKindLabel(item), how, item.sharedBy ? `shared by ${item.sharedBy.displayName}` : null].filter(Boolean).join(' · ');
}
