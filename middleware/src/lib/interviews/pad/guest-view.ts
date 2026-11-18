// What the candidate's socket may learn about the people on the pad (row I4.2,
// privacy): the lead's name, and nobody else's. The pad is a `doc:` channel, so
// two server frames carry names to every reader of it:
//   - `crdt:awareness`: each caret's y-protocols awareness state, whose
//     `user.name` the sender's client chose (the panel's own display name);
//   - `documents:presence` (pushed) and `crdt` / `documentPresence` (the
//     answer to a `getDocumentPresence` request): the CRDT service's list of
//     the people in each document, by user id and name.
// For a guest recipient the gateway's last-mile filter (lib/realtime-gateway.ts)
// passes both through `padFrameForGuest`: a caret whose sender is not the lead
// and not a guest is renamed "Interviewer", and presence keeps only the lead
// and guests. Staff recipients are untouched. A frame that cannot be read is
// dropped (null), never passed through unchanged.
import { padInterviewId } from './channel.js';
import { claimsGuest } from '../lobby.js';
import { interviewsStore } from '../store-select.js';

type Context = Record<string, unknown> | null;
type Frame = Record<string, unknown>;

/** The name a guest reads on a panel member's caret. */
export const PANEL_CARET_NAME = 'Interviewer';

export interface PadGuestViewDeps {
  /** The verified context of the socket that sent an awareness update (null when it is gone). */
  senderContext: (clientId: string) => Context;
  /** The interview's lead, or null when there is no such interview. */
  leadOf?: (interviewId: string) => Promise<string | null>;
}

const defaultLeadOf = async (interviewId: string): Promise<string | null> =>
  (await interviewsStore().getInterview(interviewId))?.leadId ?? null;

/** Is this a frame the guest filter must look at? */
export function isPadNamedFrame(frame: Frame): boolean {
  if (frame.type === 'crdt:awareness') return typeof frame.channel === 'string' && padInterviewId(frame.channel) !== null;
  if (frame.type === 'documents:presence') return Array.isArray(frame.documents) && frame.documents.some((d) => padDocument(d) !== null);
  if (frame.type === 'crdt' && frame.action === 'documentPresence') return isRecord(frame.presence) && Object.keys(frame.presence).some((ch) => padInterviewId(ch) !== null);
  return false;
}

/**
 * The frame as `recipient` may read it. A staff recipient (or a frame that names
 * no pad) gets it unchanged; a guest gets the lead's name only. Null drops it.
 */
export async function padFrameForGuest(recipient: Context, frame: Frame, deps: PadGuestViewDeps): Promise<Frame | null> {
  if (!claimsGuest(recipient) || !isPadNamedFrame(frame)) return frame;
  const leadOf = deps.leadOf ?? defaultLeadOf;
  if (frame.type === 'crdt:awareness') {
    const lead = await leadOf(padInterviewId(frame.channel as string)!);
    if (!Array.isArray(frame.updates)) return null;
    const updates: unknown[] = [];
    for (const item of frame.updates as unknown[]) {
      if (!item || typeof item !== 'object') return null;
      const { clientId, update } = item as { clientId?: unknown; update?: unknown };
      if (typeof clientId !== 'string' || typeof update !== 'string') return null;
      const sender = deps.senderContext(clientId);
      const named = claimsGuest(sender) || (lead !== null && sender?.['userId'] === lead);
      const safe = named ? update : renameAwareness(update, PANEL_CARET_NAME);
      if (safe === null) return null;
      updates.push({ ...(item as object), update: safe });
    }
    return { ...frame, updates };
  }
  if (frame.type === 'crdt') {
    const presence: Record<string, unknown> = {};
    for (const [channel, users] of Object.entries(frame.presence as Record<string, unknown>)) {
      const interviewId = padInterviewId(channel);
      presence[channel] = interviewId === null ? users : keepNamed(users, await leadOf(interviewId));
    }
    return { ...frame, presence };
  }
  const documents: unknown[] = [];
  for (const entry of frame.documents as unknown[]) {
    const interviewId = padDocument(entry);
    if (interviewId === null) { documents.push(entry); continue; }
    documents.push({ ...(entry as Frame), users: keepNamed((entry as Frame).users, await leadOf(interviewId)) });
  }
  return { ...frame, documents };
}

/** A pad's presence list as a guest reads it: the lead and guests only. */
function keepNamed(users: unknown, lead: string | null): unknown[] {
  return (Array.isArray(users) ? users : []).filter((u) => {
    const id = isRecord(u) ? u.userId : undefined;
    return typeof id === 'string' && ((lead !== null && id === lead) || id.startsWith('guest:'));
  });
}

function isRecord(v: unknown): v is Frame {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function padDocument(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const id = (entry as Frame).documentId;
  return typeof id === 'string' ? padInterviewId(id) : null;
}

// ── y-protocols awareness update: varUint count, then per client varUint id, varUint clock, varString JSON ──

/** The update (base64) with every present state's `user.name` set to `name`; null when it cannot be read. */
export function renameAwareness(base64: string, name: string): string | null {
  try {
    const bytes = Buffer.from(base64, 'base64');
    const reader = { bytes, at: 0 };
    const out: number[] = [];
    const count = readVarUint(reader);
    writeVarUint(out, count);
    for (let i = 0; i < count; i += 1) {
      writeVarUint(out, readVarUint(reader));
      writeVarUint(out, readVarUint(reader));
      const json = readVarString(reader);
      const state = JSON.parse(json) as unknown;
      if (state && typeof state === 'object' && (state as Frame).user && typeof (state as Frame).user === 'object') {
        (state as Frame).user = { ...((state as Frame).user as Frame), name };
      }
      writeVarString(out, JSON.stringify(state));
    }
    if (reader.at !== bytes.length) return null;
    return Buffer.from(out).toString('base64');
  } catch {
    return null;
  }
}

function readVarUint(r: { bytes: Buffer; at: number }): number {
  let num = 0; let mult = 1;
  for (;;) {
    if (r.at >= r.bytes.length) throw new Error('short');
    const b = r.bytes[r.at++]!;
    num += (b & 0x7f) * mult;
    if (b < 0x80) return num;
    mult *= 128;
    if (mult > 2 ** 53) throw new Error('varuint too long');
  }
}
function writeVarUint(out: number[], n: number): void {
  while (n > 0x7f) { out.push(0x80 | (n % 128)); n = Math.floor(n / 128); }
  out.push(n);
}
function readVarString(r: { bytes: Buffer; at: number }): string {
  const len = readVarUint(r);
  if (r.at + len > r.bytes.length) throw new Error('short');
  const s = r.bytes.subarray(r.at, r.at + len).toString('utf8');
  r.at += len;
  return s;
}
function writeVarString(out: number[], s: string): void {
  const b = Buffer.from(s, 'utf8');
  writeVarUint(out, b.length);
  for (const x of b) out.push(x);
}
