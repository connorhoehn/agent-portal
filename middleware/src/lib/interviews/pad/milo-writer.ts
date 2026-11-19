// Milo writes into an interview's code pad for its interview tools (docs/interviews-tenant-plan.md, "Milo's interview tools":
// test cases, imports and a helper, ../milo-tools). A write that fails after typing part of its block takes that part out again.
//
// The server edits the pad the way a person's pad does: over the BFF's own /ws gateway, as a Yjs peer on the pad's channel,
// so the CRDT service applies, stores and fans the edit out exactly as it does a person's, and the pad's own authority
// (./authority.ts admitPadChannel, through ./milo-seat.ts) decides the socket's subscribe and its write. Nothing is written
// from a browser on Milo's behalf, and the library's document service is never reached around.
//
// One write is one short connection, in this order:
//   1. open a grant for the interview and connect to this process's own gateway with a token for it;
//   2. subscribe; the document arrives as `crdt:snapshot` (nothing for an empty pad), and later edits as `crdt:update`;
//   3. once subscribed, send an empty update with an id: its acknowledgement (`crdt:persisted`) comes after everything the
//      subscribe sent, so the local copy is the pad as it stands;
//   4. ask `plan` what to write for that text and language (it may take a while: the socket stays subscribed, so edits made
//      meanwhile still arrive); its answer is a placement, which is asked where and what against the pad AS IT IS THEN (`atEnd`:
//      at the end, on its own lines after a blank one, the rule `questionInsertion` follows in the portal; a tool may place
//      text elsewhere, such as an import at the top); TYPE it in a few chunks (MILO_TYPE_CHUNKS, MILO_TYPE_GAP_MS apart), each
//      its own Yjs transaction and update, so people see it arrive, with Milo's named caret (awareness, name "Milo") at the
//      end of what is typed so far; the last chunk goes with an id and is waited for (stored by the service, and on its way
//      to everyone on the pad); the caret is then taken away;
//   5. close the socket and the grant, whatever happened. Connecting and syncing, the plan, and the write are each bounded
//      (MILO_SYNC_TIMEOUT_MS, MILO_PLAN_TIMEOUT_MS, MILO_WRITE_TIMEOUT_MS), all inside the grant's life.
// A refusal or an error frame, a closed socket, or the bound passing is a failure code; nothing is retried here.
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { config } from '../../../config.js';
import { listenHost } from '../../bind-host.js';
import { realtimeSigningSecret } from '../../realtime-token.js';
import { PAD_LANGUAGES, type PadLanguage } from '../types.js';
import { PAD_LANGUAGE_KEY, PAD_META_NAME, PAD_TEXT_NAME, padChannel } from './channel.js';
import { closeMiloPadGrant, MILO_PAD_GRANT_MS, mintMiloPadToken, openMiloPadGrant } from './milo-seat.js';
import { encodeAwareness } from './guest-view.js';

/** Milo's caret: its name and colour on everyone's pad (the library CodePad draws remote awareness `user` and `cursor`). */
export const MILO_CARET = Object.freeze({ name: 'Milo', color: '#7c3aed', colorLight: 'color-mix(in srgb, #7c3aed 20%, transparent)' });
/** A block is typed in at most this many chunks, this far apart. */
export const MILO_TYPE_CHUNKS = 4;
export const MILO_TYPE_GAP_MS = 150;

/** The text in up to `n` chunks, split at line ends where it can (a short text is one chunk). */
export function typingChunks(text: string, n = MILO_TYPE_CHUNKS): string[] {
  const lines = text.split(/(?<=\n)/);
  if (lines.length <= 1 || n <= 1) return [text];
  const per = Math.ceil(lines.length / n);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per).join(''));
  return out;
}

/** Connecting, subscribing and the sync barrier. */
export const MILO_SYNC_TIMEOUT_MS = 6_000;
/** The plan (the model writing the cases): the model's own timeout and one retry fit inside it. */
export const MILO_PLAN_TIMEOUT_MS = 40_000;
/** Sending the block and its acknowledgement. */
export const MILO_WRITE_TIMEOUT_MS = 6_000;
const PATH = '/ws';

/** What was written: where, how much, and the pad's whole text and language after it. */
export interface MiloPadWritten {
  ok: true;
  /** Where the block starts, in characters; how many were added; the pad's length after. */
  from: number;
  inserted: number;
  length: number;
  /** Lines in the added block. */
  lines: number;
  language: PadLanguage;
  text: string;
}
/**
 * `typed`: some of the block had reached the pad before the write failed. It is then taken out again (Milo's own inserts undone,
 * whatever others typed meanwhile stays); `removed` says the gateway confirmed that. The caller logs the attempt.
 */
export type MiloPadWriteFailure = {
  ok: false; code: 'unavailable' | 'refused' | 'timeout' | 'nothing';
  typed?: { from: number; inserted: number; lines: number; removed: boolean; length: number; language: PadLanguage; text: string };
};
/** How long a failed write waits for the gateway to confirm the typed part was taken out again. */
export const MILO_UNDO_WAIT_MS = 1500;
export type MiloPadWriteResult = MiloPadWritten | MiloPadWriteFailure;

/** Where and what to write, decided against the pad's text at the moment of writing; null writes nothing. */
export type MiloPadPlacement = (current: string) => { index: number; text: string } | null;
/** What to write, given the pad's text and language when Milo joined it; null writes nothing. */
export type MiloPadPlan = (pad: { text: string; language: PadLanguage }) => Promise<MiloPadPlacement | null> | MiloPadPlacement | null;

/** What goes before a block so it starts on its own line after a blank one (portal/src/lib/interviewsPad.ts `questionInsertion`). */
export function blockLead(existing: string): string {
  return existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
}

/** A block at the end of the pad as it then is, on its own lines after a blank one. */
export const atEnd = (body: string): MiloPadPlacement => (current) => ({ index: current.length, text: `${blockLead(current)}${body}` });

export interface MiloWriterDeps {
  /** This process's own gateway, `ws://<loopback>:<port>/ws`. */
  gatewayUrl: () => string;
  secret: () => string | null;
  syncMs: number;
  planMs: number;
  writeMs: number;
  /** The pause between typed chunks (tests: 0). */
  typeGapMs: number;
}

/** This process's gateway on the loopback (or the address it is bound to when that is one host). */
export function ownGatewayUrl(port = config.port, host = listenHost()): string {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `ws://${h}:${port}${PATH}`;
}

const DEFAULTS: MiloWriterDeps = {
  gatewayUrl: () => ownGatewayUrl(), secret: realtimeSigningSecret, syncMs: MILO_SYNC_TIMEOUT_MS, planMs: MILO_PLAN_TIMEOUT_MS, writeMs: MILO_WRITE_TIMEOUT_MS, typeGapMs: MILO_TYPE_GAP_MS,
};
let overrides: Partial<MiloWriterDeps> = {};
/** Tests: point the writer at a test gateway; `null` puts the defaults back. */
export function setMiloWriterDeps(next: Partial<MiloWriterDeps> | null): void { overrides = next ?? {}; }
const deps = (): MiloWriterDeps => ({ ...DEFAULTS, ...overrides });

const languageOf = (doc: Y.Doc): PadLanguage => {
  const v = doc.getMap(PAD_META_NAME).get(PAD_LANGUAGE_KEY);
  return typeof v === 'string' && (PAD_LANGUAGES as readonly string[]).includes(v) ? v as PadLanguage : 'python';
};
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const linesIn = (s: string): number => (s ? s.replace(/^\n+/, '').replace(/\n$/, '').split('\n').length : 0);

/** Append `plan`'s block to the end of `interviewId`'s pad as Milo. Never throws. */
export async function writeIntoPad(interviewId: string, plan: MiloPadPlan): Promise<MiloPadWriteResult> {
  const d = deps();
  const channel = padChannel(interviewId);
  const secret = d.secret();
  if (!channel || !secret) return { ok: false, code: 'unavailable' };
  const grant = openMiloPadGrant(interviewId);
  try {
    const token = await mintMiloPadToken({ interviewId, grant }, secret);
    return await exchange(d, token, channel, plan);
  } catch {
    return { ok: false, code: 'unavailable' };
  } finally {
    closeMiloPadGrant(grant);
  }
}

function exchange(d: MiloWriterDeps, token: string, channel: string, plan: MiloPadPlan): Promise<MiloPadWriteResult> {
  return new Promise((resolve) => {
    const doc = new Y.Doc();
    const syncId = `milo-sync-${randomBytes(6).toString('hex')}`;
    const writeId = `milo-write-${randomBytes(6).toString('hex')}`;
    let written: MiloPadWritten | null = null;
    let done = false;
    // What was typed so far (review 1, item 4): a failure after the first chunk takes it out again (`fail`).
    const undoId = `milo-undo-${randomBytes(6).toString('hex')}`;
    let undo: Y.UndoManager | null = null;
    let typed: { from: number; chars: string; language: PadLanguage } | null = null;
    let failing: MiloPadWriteFailure['code'] | null = null;
    const socket = new WebSocket(d.gatewayUrl(), ['bearer-token-v1', token], { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
    // One bound at a time, each phase its own, all inside the grant's life (MILO_PAD_GRANT_MS).
    const started = Date.now();
    let timer = setTimeout(() => fail('timeout'), d.syncMs);
    const bound = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => fail('timeout'), Math.min(ms, MILO_PAD_GRANT_MS - 1000 - (Date.now() - started))); };
    function finish(out: MiloPadWriteResult): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      undo?.destroy();
      doc.destroy();
      resolve(out);
    }
    const attempt = (code: MiloPadWriteFailure['code'], removed: boolean): MiloPadWriteFailure => {
      if (!typed) return { ok: false, code };
      const text = doc.getText(PAD_TEXT_NAME).toString();
      return { ok: false, code, typed: { from: typed.from, inserted: typed.chars.length, lines: linesIn(typed.chars), removed, length: text.length, language: typed.language, text } };
    };
    // A failure: nothing typed yet ends at once; otherwise Milo's own inserts are undone and sent, and the gateway's confirmation
    // (or MILO_UNDO_WAIT_MS) ends it. A second failure while taking it out ends it as it stands.
    function fail(code: MiloPadWriteFailure['code']): void {
      if (done) return;
      if (failing !== null || !typed || !undo) { finish(attempt(failing ?? code, false)); return; }
      failing = code;
      let update: Uint8Array | null = null;
      const take = (u: Uint8Array, origin: unknown) => { if (origin === undo) update = u; };
      doc.on('update', take);
      undo.undo();
      doc.off('update', take);
      clearTimeout(timer);
      timer = setTimeout(() => finish(attempt(code, false)), MILO_UNDO_WAIT_MS);
      try {
        if (clock) caret(null);
        if (update) send({ action: 'update', update: b64(update), updateId: undoId }); else finish(attempt(code, false));
      } catch { finish(attempt(code, false)); }
    }
    const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify({ service: 'crdt', channel, ...frame }));
    const write = async () => {
      const text = doc.getText(PAD_TEXT_NAME);
      const language = languageOf(doc);
      bound(d.planMs);
      let placement: MiloPadPlacement | null;
      try { placement = await plan({ text: text.toString(), language }); } catch { placement = null; }
      if (done) return;
      const placed = placement ? placement(text.toString()) : null;
      if (!placed || !placed.text) { finish({ ok: false, code: 'nothing' }); return; }
      undo = new Y.UndoManager(text, { trackedOrigins: new Set(['milo']), captureTimeout: MILO_PAD_GRANT_MS });
      bound(d.writeMs + MILO_TYPE_CHUNKS * d.typeGapMs);
      const index = Math.max(0, Math.min(placed.index, text.length));
      // Typed in: each chunk after the last one, wherever other people's edits have moved it meanwhile.
      let end = Y.createRelativePositionFromTypeIndex(text, index, -1);
      const chunks = typingChunks(placed.text);
      for (let i = 0; i < chunks.length; i += 1) {
        if (done || failing !== null) return;
        const at = i === 0 ? index : (Y.createAbsolutePositionFromRelativePosition(end, doc)?.index ?? text.length);
        let update: Uint8Array | null = null;
        const take = (u: Uint8Array, origin: unknown) => { if (origin === 'milo') update = u; };
        doc.on('update', take);
        doc.transact(() => text.insert(at, chunks[i]!), 'milo');
        doc.off('update', take);
        if (!update) { fail('nothing'); return; }
        typed = { from: index, chars: (typed?.chars ?? '') + chunks[i]!, language };
        end = Y.createRelativePositionFromTypeIndex(text, at + chunks[i]!.length, -1);
        caret(end);
        const last = i === chunks.length - 1;
        if (last) {
          const after = text.toString();
          written = { ok: true, from: index, inserted: placed.text.length, length: after.length, lines: linesIn(placed.text), language, text: after };
        }
        send({ action: 'update', update: b64(update), ...(last ? { updateId: writeId } : {}) });
        if (!last) await new Promise((r) => setTimeout(r, d.typeGapMs));
      }
    };
    // Milo's named caret (y-protocols awareness, the doc's own client id): at `at`, or taken away (null) before the socket closes.
    let clock = 0;
    const caret = (at: Y.RelativePosition | null) => {
      clock += 1;
      const state = at === null ? null : { user: MILO_CARET, cursor: { anchor: Y.relativePositionToJSON(at), head: Y.relativePositionToJSON(at) } };
      try { send({ action: 'awareness', update: encodeAwareness(doc.clientID, clock, state) }); } catch { /* the socket is closing */ }
    };
    socket.on('open', () => send({ action: 'subscribe' }));
    socket.on('message', (raw) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { finish({ ok: false, code: 'refused' }); return; }
      if (m['type'] === 'error') { fail('refused'); return; }
      if (m['channel'] !== channel) return;
      const bytes = m['type'] === 'crdt:snapshot' ? m['snapshot'] : m['type'] === 'crdt:update' ? m['update'] : undefined;
      if (typeof bytes === 'string') {
        // A frame Yjs cannot read changes nothing.
        try { Y.applyUpdate(doc, new Uint8Array(Buffer.from(bytes, 'base64')), 'remote'); } catch { /* ignored */ }
        return;
      }
      if (m['type'] === 'crdt' && m['action'] === 'subscribed') { send({ action: 'update', update: b64(Y.encodeStateAsUpdate(new Y.Doc())), updateId: syncId }); return; }
      if (m['type'] === 'crdt:persisted' && m['updateId'] === syncId) { void write(); return; }
      if (m['type'] === 'crdt:persisted' && m['updateId'] === undoId && failing !== null) { finish(attempt(failing, true)); return; }
      if (m['type'] === 'crdt:persisted' && m['updateId'] === writeId && written && failing === null) { if (clock) caret(null); finish(written); return; }
      if (m['type'] === 'crdt:persistence-error') fail('refused');
    });
    socket.on('unexpected-response', () => fail('refused'));
    socket.on('error', () => fail('unavailable'));
    socket.on('close', () => finish(attempt(failing ?? 'refused', false)));
  });
}
