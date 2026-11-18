// The live round's pad as the mock world opens it (E4 finding 44): Kwame's round (LIVE_INTERVIEW_ID) started twelve
// minutes ago and its run log already holds two runs, so its pad must not open empty. The gateway's pad documents load
// from a snapshot store when first opened (realtime-modules' collabDocs); in the mock world that store starts with one
// snapshot, the pad's text as the pad log's last snapshot left it (K_FIXED) and its language. Everything else starts
// fresh, as before. A pad lives as long as the process (the library's memory stores), so `POST /api/__mock/reset` does
// not rewind a pad someone has already edited.
import { gzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { MemorySnapshotStore } from '@connorhoehn/realtime-modules/server';
import { padChannel } from '../lib/interviews/pad/channel.js';
import { LIVE_INTERVIEW_ID } from './interviews.js';
import { K_FIXED } from './interviews-pad-log.js';

/** The Yjs state of a pad holding `text` in `language`, as the portal's pad reads it (`code` text, `pad.language`). */
export function padState(text: string, language: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('code').insert(0, text);
  doc.getMap('pad').set('language', language);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** A snapshot store holding the live round's pad. */
export function seededPadSnapshots(): MemorySnapshotStore {
  const store = new MemorySnapshotStore();
  const channel = padChannel(LIVE_INTERVIEW_ID);
  if (channel) void store.putSnapshot(channel, gzipSync(Buffer.from(padState(K_FIXED, 'python'))), { timestamp: Date.now() });
  return store;
}
